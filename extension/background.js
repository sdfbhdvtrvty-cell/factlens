// Service worker: the only place that talks to your backend. No API keys live here.
const DEFAULTS = { backendUrl: "http://localhost:3000", token: "" };
const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];
let backoffUntil = 0; // pause all requests until this timestamp (ms)

// ============================================================
// GLOBAL CLIENT-SIDE RATE LIMITER (token bucket)
// ============================================================
// Caps API calls across ALL tabs at ≤12/min regardless of how
// many tabs are open or how fast the user scrolls. Pairs with
// the server-side pacing so neither side alone is the single
// point of failure when quota is tight.
//
// State is persisted to chrome.storage.session so the bucket
// survives MV3 service-worker restarts without resetting to a
// full burst capacity.
const BUCKET_CAPACITY = 3;
const REFILL_RATE = 12 / 60;      // 12 calls/minute → 0.2 tokens/second
let tokens = 1;                    // conservative on cold start; restored from session below
let lastRefill = Date.now();

// Restore bucket state from session storage (survives worker restarts
// within the same browser session, but not browser close — which is fine,
// since quota resets are per-minute anyway).
chrome.storage.session?.get("fl_bucket", (data) => {
  if (data?.fl_bucket) {
    const { t, lr } = data.fl_bucket;
    if (typeof t === "number" && typeof lr === "number") {
      tokens = t;
      lastRefill = lr;
      refillBucket(); // catch up on time elapsed while the worker was asleep
    }
  }
});

function refillBucket() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsed * REFILL_RATE);
  lastRefill = now;
}

function persistBucket() {
  try { chrome.storage.session?.set({ fl_bucket: { t: tokens, lr: lastRefill } }); } catch {}
}

async function acquireToken() {
  return new Promise((resolve) => {
    const tryGet = () => {
      refillBucket();
      if (tokens >= 1) {
        tokens -= 1;
        persistBucket();
        resolve();
      } else {
        // Wait until a token is available (worst case ~5s at 12 RPM).
        const msUntilToken = Math.ceil((1 - tokens) / REFILL_RATE * 1000);
        setTimeout(tryGet, msUntilToken);
      }
    };
    tryGet();
  });
}

// ============================================================
// RESULT CACHE  (in-memory + chrome.storage.local persistence)
// ============================================================
// In-memory Map is shared across ALL tabs for the life of the
// service worker. chrome.storage.local survives service-worker
// restarts so the cache is warm even after the worker wakes.
const resultCache = new Map();
const CACHE_MAX = 600;
const STORAGE_KEY = "fl_cache_v1";

chrome.storage.local.get(STORAGE_KEY, (data) => {
  const saved = data[STORAGE_KEY];
  if (Array.isArray(saved)) {
    for (const [text, result] of saved) {
      if (typeof text === "string" && result) resultCache.set(text, result);
    }
  }
});

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries = [...resultCache.entries()].slice(-Math.floor(CACHE_MAX / 2));
    chrome.storage.local.set({ [STORAGE_KEY]: entries });
  }, 10_000);
}

function cacheGet(text) {
  return resultCache.get(text);
}
function cacheSet(text, result) {
  if (resultCache.size >= CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value);
  }
  const { id: _drop, ...payload } = result;
  resultCache.set(text, payload);
  schedulePersist();
}

// ============================================================
// IN-FLIGHT DEDUPLICATION  (#6)
// ============================================================
// Tracks sentence texts currently being checked by the API.
// If the same text arrives from another tab or rescan before
// the first response lands, we wait for it rather than sending
// a duplicate API call.
const inFlight = new Map(); // text → Promise<result | null>

// ============================================================
// CONCURRENCY LIMITER
// ============================================================
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

async function acquire() {
  return new Promise((resolve) => {
    const tick = () => {
      if (active < MAX_CONCURRENT && Date.now() >= backoffUntil) { active++; resolve(); }
      else waiting.push(resolve);
    };
    tick();
  });
}

// ============================================================
// BACKEND CALL
// ============================================================
// - Timeout reduced from 90s → 30s (#10)
// - Retries reduced from 3 → 1 on 429  (#4)
// - backoffUntil reset on success        (#9)
async function callBackend(claims, url, attempt = 0) {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000); // was 90s
  try {
    const res = await fetch(cfg.backendUrl.replace(/\/+$/, "") + "/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-factlens-token": cfg.token || "" },
      body: JSON.stringify({ claims, url }),
      signal: controller.signal
    });
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 3, 10) * 1000;
      const delay = wait * Math.pow(2, Math.min(attempt, 2));
      backoffUntil = Date.now() + delay;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, delay));
        return callBackend(claims, url, attempt + 1);
      }
      throw new Error(res.status === 429
        ? "Rate limited (429) — daily quota may be exhausted"
        : `Model temporarily busy (${res.status}) — please retry shortly`);
    }
    if (!res.ok) throw new Error(`Backend error ${res.status}`);
    backoffUntil = 0; // reset on success so partial batches aren't blocked (#9)
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_CLAIMS") {
    (async () => {
      // --- 1. Split batch: cached / in-flight / uncached ---
      const uncached = [];
      const cachedResults = [];
      const inflightWaits = []; // promises for sentences already being checked

      for (const claim of msg.claims) {
        // Already in cache?
        const hit = cacheGet(claim.text);
        if (hit) {
          cachedResults.push({ ...hit, id: claim.id });
          continue;
        }
        // Currently being checked for another tab? Wait for that result.
        const pending = inFlight.get(claim.text);
        if (pending) {
          inflightWaits.push(
            pending.then((r) => r ? { ...r, id: claim.id } : null)
          );
          continue;
        }
        uncached.push(claim);
      }

      // Wait for any in-flight results to land
      if (inflightWaits.length) {
        const resolved = await Promise.all(inflightWaits);
        for (const r of resolved) if (r) cachedResults.push(r);
      }

      // Everything resolved without an API call
      if (!uncached.length) {
        sendResponse({ results: cachedResults });
        return;
      }

      // --- 2. Register in-flight promises so concurrent requests wait ---
      const resolvers = new Map(); // text → resolve function
      for (const claim of uncached) {
        let resolve;
        const p = new Promise((r) => { resolve = r; });
        inFlight.set(claim.text, p);
        resolvers.set(claim.text, resolve);
      }

      // --- 3. Rate-limit then send ---
      await acquireToken();
      await acquire();

      try {
        const data = await callBackend(uncached, msg.url);
        const backendResults = data.results || [];

        // Cache fresh results and resolve in-flight waiters
        for (const r of backendResults) {
          const claim = uncached.find((c) => c.id === r.id);
          if (claim) {
            cacheSet(claim.text, r);
            resolvers.get(claim.text)?.(cacheGet(claim.text));
          }
        }
        // Resolve any claims the backend didn't return a result for
        for (const claim of uncached) {
          if (!backendResults.find((r) => r.id === claim.id)) {
            resolvers.get(claim.text)?.(null);
          }
        }

        sendResponse({ results: [...cachedResults, ...backendResults] });
      } catch (e) {
        // Resolve in-flight promises so waiters don't hang forever
        for (const claim of uncached) resolvers.get(claim.text)?.(null);

        if (cachedResults.length) {
          sendResponse({ results: cachedResults });
        } else {
          sendResponse({ error: e.message || "Request failed" });
        }
      } finally {
        for (const claim of uncached) inFlight.delete(claim.text);
        release();
      }
    })();
    return true; // async response
  }

  if (msg.type === "REPORT" && sender.tab?.id != null) {
    const n = (msg.counts.false || 0) + (msg.counts.misleading || 0);
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: n > 0 ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#d93025" });
  }
});
