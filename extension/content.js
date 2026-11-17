(() => {
  if (window.__factlens) return;
  window.__factlens = true;

  const CFG = { enabled: true, autoScan: true, minConfidence: 0.6,
    minElWords: 15, minSentWords: 7, maxSentPerEl: 4, preferNumeric: true };
  const MAX_ELEMENTS = 80, BATCH_SIZE = 8;

  // Anything inside these is navigation, chrome, or noise, not article content.
  const SKIP = [
    "nav", "header", "footer", "aside", "form", "script", "style", "noscript", "textarea",
    "input", "button", "select", "code", "pre", "[role=navigation]", "[role=banner]",
    "[role=contentinfo]", "[role=dialog]", "[aria-hidden=true]", "[contenteditable=true]",
    "[class*=cookie i]", "[id*=cookie i]", "[class*=consent i]", "[id*=consent i]",
    "[class*=gdpr i]", "[class*=newsletter i]", "[class*=sidebar i]", "[class*=menu i]",
    "[class*=breadcrumb i]", "[class*=footer i]", "[class*=comment i]"
  ].join(",");
  const CANDIDATES = [
    "p", "li", "blockquote",
    "[data-testid=tweetText]",                    // Twitter / X
    "[data-pressable-container] span[dir=auto]",   // Threads post text
    "[role=article] span[dir=auto]"               // Threads / social article text
  ].join(",");

  const results = new Map();          // claimId -> result + text
  const seen = new WeakSet();
  // Use the page's declared language for accurate sentence segmentation.
  // Falls back safely if the page specifies an invalid/malformed BCP 47 locale tag (e.g. en_US).
  let segmenter;
  try {
    const pageLang = document.documentElement.lang || navigator.language || undefined;
    segmenter = new Intl.Segmenter(pageLang, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
  let queue = [], flushTimer = null, nextId = 1, elementCount = 0, pending = 0, rescanTimer = null,
    skipped = 0, backendOk = true, lastErr = "", flushActive = false;

  const words = (s) => (s.trim().match(/\S+/g) || []).length;
  const isFlagged = (r) => (r.verdict === "false" || r.verdict === "misleading") && r.confidence >= CFG.minConfidence;

  // ---------- Extraction ----------
  function eligible(el) {
    if (seen.has(el) || el.closest(SKIP)) return false;
    // For social posts (Threads), don't scan inner nested inline spans if parent is already a candidate span
    if (el.matches("span[dir=auto]") && el.parentElement?.closest("span[dir=auto]")) return false;
    // Avoid double-scanning block containers that contain other block candidates (like blockquote > p)
    const blockChildren = el.querySelectorAll("p, li, blockquote, [data-testid=tweetText]");
    if (blockChildren.length > 0) return false;
    if (el.closest(".factlens-tip")) return false;
    return words(el.textContent) >= CFG.minElWords;
  }

  function candidates() {
    let roots = document.querySelectorAll("article, main, [role=main]");
    if (!roots.length) roots = [document.body];
    const set = new Set();
    roots.forEach((r) => r.querySelectorAll(CANDIDATES).forEach((el) => set.add(el)));
    return [...set].filter(eligible);
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); enqueue(e.target); }
  }, { rootMargin: "300px" });

  function enqueue(el) {
    if (!CFG.enabled || elementCount >= MAX_ELEMENTS || !el.isConnected) return;
    const all = segmenter.segment(el.textContent);
    const eligible = [];
    for (const { segment } of all) {
      const s = segment.trim();
      if (s.endsWith("?") || s.length > 500) continue;
      if (words(s) < CFG.minSentWords) { skipped++; continue; }
      eligible.push(s);
    }
    const sentences = CFG.preferNumeric
      ? eligible.map((s, i) => ({ s, i, d: /\d/.test(s) ? 0 : 1 }))
        .sort((a, b) => a.d - b.d || a.i - b.i).slice(0, CFG.maxSentPerEl).map((x) => x.s)
      : eligible.slice(0, CFG.maxSentPerEl);
    if (!sentences.length) return;
    elementCount++;
    const elId = nextId++;
    el.dataset.flEl = elId;
    sentences.forEach((text, i) => queue.push({ id: `${elId}:${i}`, text }));
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  }

  function scan(force) {
    if (!CFG.enabled) return;
    for (const el of candidates()) {
      seen.add(el);
      force ? enqueue(el) : io.observe(el);
    }
  }

  // ---------- Backend round-trip ----------
  // Sends ONE batch at a time, then schedules the next after a 1.5s gap.
  // This prevents a fast scroll from dumping 5–10 simultaneous API calls
  // that all queue up behind the rate limiter and stack latency.
  function flush() {
    if (flushActive || !queue.length) return;
    flushActive = true;
    const batch = queue.splice(0, BATCH_SIZE);
    pending++;
    chrome.runtime.sendMessage({ type: "CHECK_CLAIMS", claims: batch, url: location.href })
      .then((res) => {
        if (!res) return;
        if (res.error) { backendOk = false; lastErr = res.error; showBanner(); return; }
        backendOk = true;
        for (const r of res.results || []) {
          const claim = batch.find((c) => c.id === r.id);
          if (claim) apply({ ...r, text: claim.text });
        }
      })
      .catch((e) => { backendOk = false; lastErr = e?.message || "Request failed"; showBanner(); })
      .finally(() => {
        pending--;
        report();
        flushActive = false;
        // If there are more batches, schedule the next one after a gap
        // so requests trickle in instead of stampeding the backend.
        if (queue.length) {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(flush, 1500);
        }
      });
  }

  function apply(r) {
    results.set(r.id, r);
    if (isFlagged(r)) {
      const el = document.querySelector(`[data-fl-el="${r.id.split(":")[0]}"]`);
      if (el) highlight(el, r);
    }
  }

  // ---------- Highlighting ----------
  function highlight(el, r) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = "";
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: full.length });
      full += walker.currentNode.nodeValue;
    }
    const idx = full.indexOf(r.text);
    if (idx < 0) return;
    const end = idx + r.text.length;
    for (const { node, start } of nodes.reverse()) {
      const a = Math.max(idx, start), b = Math.min(end, start + node.nodeValue.length);
      if (a >= b || !node.nodeValue.slice(a - start, b - start).trim()) continue;
      const range = document.createRange();
      range.setStart(node, a - start);
      range.setEnd(node, b - start);
      const mark = document.createElement("mark");
      mark.className = `factlens-mark factlens-${r.verdict}`;
      mark.dataset.flId = r.id;
      try {
        range.surroundContents(mark);
      } catch {
        // surroundContents() throws HierarchyError when the sentence spans across
        // mixed inline elements (e.g. partially bold/linked text). Fall back to
        // marking the whole host element so the flag is still visible to the user.
        if (!el.classList.contains("factlens-mark")) {
          el.classList.add("factlens-mark", `factlens-${r.verdict}`);
          el.dataset.flId = r.id;
        }
        break; // remaining text nodes in this element would cause the same error
      }
    }
  }

  function clearMarks() {
    document.querySelectorAll("mark.factlens-mark").forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  // ---------- Tooltip ----------
  const LABELS = { false: "Likely false", misleading: "Possibly misleading" };
  let tip, hideTimer;

  function getTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "factlens-tip";
    tip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    tip.addEventListener("mouseleave", hideTip);
    document.documentElement.appendChild(tip);
    return tip;
  }
  function hideTip() { hideTimer = setTimeout(() => tip && (tip.style.display = "none"), 250); }

  document.addEventListener("mouseover", (e) => {
    const mark = e.target.closest?.("mark.factlens-mark");
    if (!mark) return;
    const r = results.get(mark.dataset.flId);
    if (!r) return;
    clearTimeout(hideTimer);
    const t = getTip();
    t.replaceChildren();
    const h = document.createElement("div");
    h.className = `factlens-tip-title factlens-${r.verdict}`;
    h.textContent = `${LABELS[r.verdict] || r.verdict} · ${Math.round(r.confidence * 100)}% confidence`;
    const p = document.createElement("div");
    p.textContent = r.explanation;
    t.append(h, p);
    if (r.sources?.length) {
      const ul = document.createElement("div");
      ul.className = "factlens-tip-sources";
      r.sources.forEach((u) => {
        try {
          const a = document.createElement("a");
          a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = new URL(u).hostname.replace(/^www\./, "");
          ul.appendChild(a);
        } catch {}
      });
      t.appendChild(ul);
    }
    t.style.display = "block";
    const rect = mark.getBoundingClientRect();
    const top = rect.bottom + 8 + t.offsetHeight > innerHeight ? rect.top - t.offsetHeight - 8 : rect.bottom + 8;
    t.style.top = Math.max(8, top) + "px";
    t.style.left = Math.max(8, Math.min(rect.left, innerWidth - t.offsetWidth - 8)) + "px";
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest?.("mark.factlens-mark")) hideTip();
  });

  // ---------- Reporting to popup / badge ----------
  function summary() {
    const counts = { checked: results.size, false: 0, misleading: 0 };
    const items = [];
    for (const r of results.values()) {
      if (!isFlagged(r)) continue;
      counts[r.verdict]++;
      items.push({ id: r.id, text: r.text, verdict: r.verdict, confidence: r.confidence, explanation: r.explanation });
    }
    return { counts, items, pending, enabled: CFG.enabled, backendOk, skipped, lastErr };
  }
  function report() {
    try { chrome.runtime.sendMessage({ type: "REPORT", counts: summary().counts, backendOk }); } catch {}
  }

  // ---------- Error banner ----------
  let banner;
  function showBanner() {
    if (banner) return;
    banner = document.createElement("div");
    banner.className = "factlens-banner";
    banner.innerHTML =
      `<span>⚠ FactLens can't reach the backend — ${lastErr || "request failed"}. ` +
      `Scanning is paused.</span> ` +
      `<button id="factlens-retry">Retry</button>`;
    banner.querySelector("#factlens-retry").onclick = () => {
      banner.remove(); banner = null; backendOk = true; scan(true);
    };
    document.documentElement.appendChild(banner);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === "GET_REPORT") sendResponse(summary());
    else if (msg.type === "RETRY_BACKEND") { backendOk = true; lastErr = ""; scan(true); sendResponse({ ok: true }); }
    else if (msg.type === "SCAN_NOW") { scan(true); sendResponse({ ok: true }); }
    else if (msg.type === "SCROLL_TO") {
      const m = document.querySelector(`mark[data-fl-id="${CSS.escape(msg.id)}"]`);
      if (m) {
        m.scrollIntoView({ behavior: "smooth", block: "center" });
        m.classList.add("factlens-flash");
        setTimeout(() => m.classList.remove("factlens-flash"), 1500);
      }
      sendResponse({ ok: !!m });
    }
  });

  // ---------- Settings & lifecycle ----------
  function loadSettings(cb) {
    chrome.storage.sync.get(CFG, (s) => { Object.assign(CFG, s); cb && cb(); });
  }
  chrome.storage.onChanged.addListener((changes) => {
    const wasEnabled = CFG.enabled;
    for (const k in changes) if (k in CFG) CFG[k] = changes[k].newValue;
    if (wasEnabled && !CFG.enabled) { clearMarks(); results.clear(); report(); }
    else if (!wasEnabled && CFG.enabled && CFG.autoScan) scan(false);
  });

  // Handle infinite-scroll / SPA content.
  // Only react when real candidate elements (p, li, blockquote, tweet) are added —
  // not on every attribute tweak, style change, or cursor update that SPAs produce
  // constantly. This prevents queue-flooding on sites like Twitter/YouTube.
  new MutationObserver((mutations) => {
    if (!CFG.enabled || !CFG.autoScan) return;
    const hasNewContent = mutations.some((m) =>
      [...m.addedNodes].some(
        (n) => n.nodeType === Node.ELEMENT_NODE &&
               (n.matches?.(CANDIDATES) || n.querySelector?.(CANDIDATES))
      )
    );
    if (!hasNewContent) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scan(false), 2500); // longer debounce vs original 1000ms
  }).observe(document.body, { childList: true, subtree: true });

  loadSettings(() => { if (CFG.autoScan) scan(false); });
})();
