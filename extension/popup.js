const $ = (s) => document.querySelector(s);
const DEFAULTS = {
  enabled: true, autoScan: true, minConfidence: 0.6,
  backendUrl: "http://localhost:3000", token: "",
  minElWords: 15, minSentWords: 7, maxSentPerEl: 4, preferNumeric: true
};

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function itemEl(cls, label, text, sub, onclick) {
  const d = document.createElement("div");
  d.className = "item";
  const v = document.createElement("div"); v.className = `v ${cls}`; v.textContent = label;
  const t = document.createElement("div"); t.className = "t"; t.textContent = text;
  d.append(v, t);
  if (sub) { const e = document.createElement("div"); e.className = "sub"; e.textContent = sub; d.append(e); }
  d.onclick = onclick;
  return d;
}

function render(r) {
  const { counts, items, pending, enabled, backendOk } = r;
  const flagged = counts.false + counts.misleading;

  let state = "idle", title = "Nothing checked yet", sub = "Scroll the page or press “Scan this page now”.";
  const parts = [];
  if (counts.false) parts.push(`${counts.false} likely false`);
  if (counts.misleading) parts.push(`${counts.misleading} possibly misleading`);

  if (!enabled) { title = "Paused"; sub = "Turn FactLens on to scan pages."; }
  else if (backendOk === false) { state = "red"; title = "Backend unreachable"; sub = `${r.lastErr || "FactLens can't reach the backend."} Scanning is paused.`; }
  else if (flagged > 0) { state = "red"; title = "Warning"; sub = parts.join(", "); }
  else if (counts.checked > 0) { state = "green"; title = "No problems found"; sub = `${counts.checked} claim(s) checked`; }
  if (pending > 0 && enabled && backendOk !== false) sub += ` · checking ${pending}…`;

  $("#light").dataset.state = state;
  $("#statusTitle").textContent = title;
  $("#statusSub").textContent = sub;

  const retryBtn = $("#retryBtn");
  if (backendOk === false) {
    retryBtn.style.display = "inline-block";
    retryBtn.onclick = async () => {
      try { await chrome.tabs.sendMessage((await activeTab()).id, { type: "RETRY_BACKEND" }); }
      catch {}
      retryBtn.style.display = "none";
      setTimeout(refresh, 800);
    };
  } else {
    retryBtn.style.display = "none";
  }

  // Coverage line: shows what the extension did NOT check, so "no problems found"
  // doesn't read as "everything was verified".
  if (backendOk !== false && counts.checked > 0) {
    const cov = $("#coverage");
    cov.style.display = "block";
    cov.textContent = `${counts.checked} claim(s) checked` +
      (r.skipped ? `, ${r.skipped} sentence(s) too short to check` : "");
  } else {
    $("#coverage").style.display = "none";
  }

  const list = $("#list");
  list.replaceChildren();
  const send = async (id) => chrome.tabs.sendMessage((await activeTab()).id, { type: "SCROLL_TO", id });

  items.forEach((it) => list.appendChild(itemEl(
    it.verdict,
    `${it.verdict === "false" ? "Likely false" : "Possibly misleading"} · ${Math.round(it.confidence * 100)}%`,
    it.text, it.explanation, () => send(it.id)
  )));
}

async function refresh() {
  try {
    const tab = await activeTab();
    const r = await chrome.tabs.sendMessage(tab.id, { type: "GET_REPORT" });
    render(r);
  } catch {
    $("#light").dataset.state = "idle";
    $("#statusTitle").textContent = "Unavailable";
    $("#statusSub").textContent = "FactLens can’t run on this page. Try reloading it.";
    $("#list").replaceChildren();
  }
}

async function init() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  $("#enabled").checked = cfg.enabled;
  $("#autoScan").checked = cfg.autoScan;
  $("#minConfidence").value = cfg.minConfidence;
  $("#confVal").textContent = Math.round(cfg.minConfidence * 100) + "%";
  $("#minElWords").value = cfg.minElWords; $("#elVal").textContent = cfg.minElWords;
  $("#minSentWords").value = cfg.minSentWords; $("#sentVal").textContent = cfg.minSentWords;
  $("#maxSentPerEl").value = cfg.maxSentPerEl;
  $("#preferNumeric").checked = cfg.preferNumeric;
  $("#backendUrl").value = cfg.backendUrl;
  $("#token").value = cfg.token;

  $("#enabled").onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
  $("#autoScan").onchange = (e) => chrome.storage.sync.set({ autoScan: e.target.checked });
  $("#minConfidence").oninput = (e) => {
    $("#confVal").textContent = Math.round(e.target.value * 100) + "%";
    chrome.storage.sync.set({ minConfidence: Number(e.target.value) });
  };
  $("#minElWords").oninput = (e) => { $("#elVal").textContent = e.target.value; chrome.storage.sync.set({ minElWords: Number(e.target.value) }); };
  $("#minSentWords").oninput = (e) => { $("#sentVal").textContent = e.target.value; chrome.storage.sync.set({ minSentWords: Number(e.target.value) }); };
  $("#maxSentPerEl").onchange = (e) => chrome.storage.sync.set({ maxSentPerEl: Number(e.target.value) });
  $("#preferNumeric").onchange = (e) => chrome.storage.sync.set({ preferNumeric: e.target.checked });
  $("#scan").onclick = async () => {
    try { await chrome.tabs.sendMessage((await activeTab()).id, { type: "SCAN_NOW" }); } catch {}
    setTimeout(refresh, 500);
  };
  $("#save").onclick = async () => {
    const msg = $("#saveMsg");
    try {
      const u = new URL($("#backendUrl").value.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      if (u.origin !== "http://localhost:3000") {
        const ok = await chrome.permissions.request({ origins: [u.origin + "/*"] });
        if (!ok) { msg.textContent = "Permission to reach that server was denied."; return; }
      }
      await chrome.storage.sync.set({ backendUrl: u.origin, token: $("#token").value.trim() });
      msg.textContent = "Saved.";
    } catch { msg.textContent = "Enter a valid http(s) URL."; }
  };

  refresh();
  setInterval(refresh, 1500);
}
init();