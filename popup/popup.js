(function () {
  "use strict";
  const $ = id => document.getElementById(id);
   const SCRIPTS = ["background/automation-policy.js", "content/content.js", "content/temp-mail-page.js"];
  const MAX_IMPORT_BYTES = 1024 * 1024, MAX_ROUTINES = 100, MAX_ACTIONS = 500, MAX_PASSWORDS = 200;

  const state = {
    draft: null, routines: [], schedules: [], run: {},
    passwords: [],          // saved password vault
    confirm: null,          // { key, until } for two-click confirmations
    scheduleOpen: null,     // routine id whose schedule panel is open
    scheduleMode: "delay",
    message: null,          // { text, kind, until }
    listKey: "",
    pwListKey: "",
    pwFormOpen: false,
    pwEditId: null,
    // Proxy settings
    proxyList: [],          // array of proxy strings
    proxyEnabled: false,
    proxyInterval: 5,
    proxyUnit: "minutes",
    proxyIndex: 0,
    proxyOrigin: "",        // the one site the proxy is scoped to
    proxyGlobalMode: false, // route ALL traffic through proxy (unblock)
    proxySpeedMode: true,
    proxySpeedStatus: "",
    proxyHealth: {},
    cfDnsEnabled: false,
    favouriteApps: [],
    recentApps: [],
    oxylabsEnabled: false, oxylabsHost: "unblock.oxylabs.io", oxylabsPort: 60000, oxylabsUser: "", oxylabsPass: "", oxylabsSession: "", oxylabsGeo: "",
    // Captcha settings
     captchaFormOpen: false,
     captchaProvider: "2captcha",
     captchaKey: "",
     captchaUrl: "",
     captchaAssistEnabled: true,
     captchaStatus: {},
     tempMailProvider: "tempmaillol",
     tempMailMailbox: null,
     tempMailMessages: [],
     tempMailSelectedId: "",
     tempMailStatus: "",
     tempMailError: "",
    // Adblock + anti-adblock
    adblockEnabled: true,
    antiAdblockEnabled: true
  };

  const icons = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 19h14"/></svg>'
  };

  const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // Supports hours so long recordings don't look broken (e.g. 1:05:03).
  const clock = ms => {
    const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const host = origin => { try { return new URL(origin).host; } catch (_) { return origin || ""; } };
  const safeFileName = name => String(name || "routine").replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 60) || "routine";

  /* ---------- theme ---------- */
  // Supported: "light" | "dark" | "glass" (Apple Glass / visionOS style)
  function applyTheme(theme) {
    const root = document.documentElement;
    const mode = (theme === "dark" || theme === "glass") ? theme : "light";
    root.setAttribute("data-theme", mode);
    if (document.body) document.body.setAttribute("data-theme", mode);

    // Clear any inline overrides so CSS theme rules can take over cleanly
    ["--bg", "--sheet", "--card"].forEach(p => root.style.removeProperty(p));
    if (document.body) {
      document.body.style.removeProperty("background");
      document.body.style.removeProperty("color");
    }

    if (mode === "light") {
      root.style.setProperty("--bg", "#ffffff");
      root.style.setProperty("--sheet", "#ffffff");
      root.style.setProperty("--card", "#ffffff");
      if (document.body) {
        document.body.style.background = "#ffffff";
        document.body.style.color = "#0b0b0c";
      }
    } else if (mode === "dark") {
      root.style.setProperty("--bg", "#151823");
      root.style.setProperty("--sheet", "#151823");
      root.style.setProperty("--card", "#1e2230");
      if (document.body) {
        document.body.style.background = "#151823";
        document.body.style.color = "#f2f4f8";
      }
    }
    // "glass" mode is fully driven by CSS under html[data-theme="glass"]
    // Logo must not be recolored by theme
    const btn = $("themeBtn");
    if (btn) {
      const labels = { light: "Light", dark: "Dark", glass: "Glass" };
      btn.title = `Theme: ${labels[mode] || mode} (click to cycle)`;
    }
  }
  async function loadTheme() {
    const { uiTheme } = await chrome.storage.local.get({ uiTheme: "dark" });
    const allowed = ["light", "dark", "glass"];
    state.theme = allowed.includes(uiTheme) ? uiTheme : "dark";
    applyTheme(state.theme);
  }
  async function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    // Cycle: light → dark → glass → light
    const order = ["light", "dark", "glass"];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    state.theme = next;
    applyTheme(next);
    if (state.accent) applyAccent(state.accent);
    await chrome.storage.local.set({ uiTheme: next });
    if ($("darkSwitch")) $("darkSwitch").checked = next === "dark";
    // Update title so user knows current mode
    const btn = $("themeBtn");
    if (btn) {
      const labels = { light: "Light", dark: "Dark", glass: "Glass" };
      btn.title = `Theme: ${labels[next] || next} (click to cycle)`;
    }
  }

  /* ---------- settings sheet ---------- */
  const ACCENTS = { nord: "#4687ff", stone: "#9c8a6e", moss: "#6c8c63", mist: "#857f72", clay: "#ad7a40", dusk: "#8270b4", sakura: "#c2756a", ink: "#4a4845" };
  const setFill = el => el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min) * 100) + "%");
  const fmtWait = ms => ms >= 1000 ? (ms / 1000).toFixed(ms % 1000 ? 1 : 0) + " s" : ms + " ms";
  function syncSliders() {
    if ($("loops") && $("loopsOut")) {
      const loops = Number($("loops").value);
      $("loopsOut").textContent = loops === 0 ? "∞" : loops + "×";
    }
    if ($("wait") && $("waitOut")) $("waitOut").textContent = fmtWait(Number($("wait").value));
    if ($("proxyInterval")) {
      const n = Number($("proxyInterval").value), unit = state.proxyUnit || "minutes";
      const stable = Number(n) <= 1;
      state.proxyStableMode = stable;
      if ($("proxyOut")) $("proxyOut").textContent = stable ? "Stable" : `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
      try { chrome.storage.local.set({ proxyStableMode: stable, proxySpeedMode: true }); } catch (_) {}
      document.querySelectorAll("#proxyUnitSeg button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.unit === unit)));
    }
    ["loops", "wait", "proxyInterval"].forEach(id => { if ($(id)) setFill($(id)); });
  }

  /* ---------- App drawer navigation ---------- */
  
  const APP_META = {
    security: {
      label: "Security",
      color: "#0a84ff",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>`
    },
    detective: {
      label: "Detective",
      color: "#30d158",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`
    },
    captcha: {
      label: "Captcha",
      color: "#bf5af2",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h8M9 9l-2 3 2 3M15 9l2 3-2 3"/></svg>`
    },
    tempmail: {
      label: "Temp mail",
      color: "#64d2ff",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>`
    },
    automation: {
      label: "Automation",
      color: "#ff453a",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>`
    },
    media: {
      label: "Media",
      color: "#ff375f",
      icon: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h12v12H4z"/><path d="M16 10l5-3v10l-5-3z"/></svg>`
    }
  };

  function appIconHtml(key, withStar) {
    const meta = APP_META[key] || { label: key, color: "#888", icon: "" };
    const favs = state.favouriteApps || [];
    const on = favs.includes(key);
    const star = withStar
      ? `<span role="button" tabindex="0" class="fav-star${on ? " on" : ""}" data-fav="${esc(key)}" title="Favourite">${on ? "★" : "☆"}</span>`
      : "";
    return `<button type="button" class="app-icon" data-page="${esc(key)}" aria-label="${esc(meta.label)}">
      <span class="app-icon-badge" style="--app-c:${meta.color}">${meta.icon || ""}</span>
      <span class="app-icon-label">${esc(meta.label)}</span>${star}
    </button>`;
  }

  function renderMenuLists() {
    const favs = Array.isArray(state.favouriteApps) ? state.favouriteApps : [];
    const recent = Array.isArray(state.recentApps) ? state.recentApps : [];
    const pairs = [
      ["favDrawer", "favEmpty", favs, true],
      ["recentDrawer", "recentEmpty", recent.filter(k => APP_META[k]).slice(0, 6), false],
      ["homeFavDrawer", "homeFavEmpty", favs, true],
      ["homeRecentDrawer", "homeRecentEmpty", recent.filter(k => APP_META[k]).slice(0, 6), false]
    ];
    for (const [listId, emptyId, keys, withStar] of pairs) {
      const el = $(listId);
      const empty = $(emptyId);
      if (!el) continue;
      const list = (keys || []).filter(k => APP_META[k]);
      el.innerHTML = list.map(k => appIconHtml(k, withStar)).join("");
      if (empty) empty.classList.toggle("hidden", list.length > 0);
    }
    document.querySelectorAll("#appDrawer .fav-star, #homeFavDrawer .fav-star").forEach(el => {
      const k = el.getAttribute("data-fav");
      const on = favs.includes(k);
      el.classList.toggle("on", on);
      el.textContent = on ? "★" : "☆";
    });
  }

  async function toggleFavourite(key) {
    let favs = Array.isArray(state.favouriteApps) ? state.favouriteApps.slice() : [];
    if (favs.includes(key)) favs = favs.filter(k => k !== key);
    else favs.push(key);
    state.favouriteApps = favs;
    await chrome.storage.local.set({ favouriteApps: favs });
    renderMenuLists();
    say(favs.includes(key) ? "Added to favourites." : "Removed from favourites.", "ok");
  }

  async function trackRecentApp(key) {
    try {
      const data = await chrome.storage.local.get({ recentApps: [] });
      let list = Array.isArray(data.recentApps) ? data.recentApps.filter(k => k !== key) : [];
      list.unshift(key);
      list = list.slice(0, 8);
      await chrome.storage.local.set({ recentApps: list });
      state.recentApps = list;
      renderMenuLists();
    } catch (_) {}
  }


  /* Navigation stack: Back returns to parent page, not always the root menu */
  const PAGE_PARENT = {
    blocklog: "security"
  };
  state.navStack = state.navStack || [];

  function currentPageKey() {
    const el = document.querySelector("[data-page-panel]:not(.hidden)");
    return el ? el.getAttribute("data-page-panel") : null;
  }

  function goBack() {
    if (state.navStack && state.navStack.length) {
      const prev = state.navStack.pop();
      openAppPage(prev, { fromBack: true });
      return;
    }
    const cur = currentPageKey();
    if (cur && PAGE_PARENT[cur]) {
      openAppPage(PAGE_PARENT[cur], { fromBack: true });
      return;
    }
    showDrawer();
  }

  function showDrawer() {
  try { renderMenuLists(); } catch (_) {}
    state.navStack = [];
    const drawer = $("drawerView");
    const headD = $("sheetHeadDrawer");
    const headP = $("sheetHeadPage");
    if (drawer) drawer.classList.remove("hidden");
    if (headD) headD.classList.remove("hidden");
    if (headP) headP.classList.add("hidden");
    document.querySelectorAll("[data-page-panel]").forEach(p => p.classList.add("hidden"));
  }

  function openAppPage(key, opts) {
    if (key === "passwords") key = "automation";
    opts = opts || {};
    if (!opts.fromBack) {
      const cur = currentPageKey();
      if (cur && cur !== key) {
        state.navStack = state.navStack || [];
        if (state.navStack[state.navStack.length - 1] !== cur) state.navStack.push(cur);
        if (state.navStack.length > 12) state.navStack.shift();
      }
    }
    try { trackRecentApp(key); } catch (_) {}
    const titles = {
      security: "Security",
      detective: "Detective",
      audit: "Detective",
            captcha: "Captcha",
      tempmail: "Temp mail",
      automation: "Automation",
      timing: "Automation",
      media: "Media",
      blocklog: "Block log"
    };
    const drawer = $("drawerView");
    const headD = $("sheetHeadDrawer");
    const headP = $("sheetHeadPage");
    const title = $("pageTitle");
    if (drawer) drawer.classList.add("hidden");
    if (headD) headD.classList.add("hidden");
    if (headP) headP.classList.remove("hidden");
    if (title) title.textContent = titles[key] || "App";
    document.querySelectorAll("[data-page-panel]").forEach(p => {
      p.classList.toggle("hidden", p.getAttribute("data-page-panel") !== key);
    });
    // ensure page-specific renders
    try {
      if (key === "detective" || key === "audit") { /* detective */ }
      if (key === "security") {
        renderProxy(); renderAdblock(); loadBlockLog(); try { syncSecurityPower(); } catch (_) {}
        const stale = !state.proxyExit || Date.now() - (state.proxyExit.at || 0) > 60000;
        if (stale) chrome.runtime.sendMessage({ type: "proxyExitInfo" }).catch(() => {});
      }
      if (key === "security" || key === "blocklog") loadAllow();
      if (key === "captcha") scanCaptchaNow(false);
      if (key === "tempmail") {
        renderTempMail();
        if (state.tempMailMailbox?.email) tempMailRequest("tempMailRefresh").catch(() => {});
      }
      if (key === "blocklog") loadBlockLog();
      if (key === "automation" || key === "passwords") { renderPasswords(); syncSliders(); }
      if (key === "captcha") renderCaptcha();
      if (key === "timing" || key === "automation") syncSliders();
      if (key === "media") { refreshMediaFromStorage(); scanMediaNow().catch(() => {}); }
    } catch (_) {}
  }

      
  function openSheet(open, pageKey) {
    const sheet = $("sheet");
    const scrim = $("scrim");
    if (!sheet) return;
    sheet.classList.toggle("hidden", !open);
    if (scrim) scrim.classList.toggle("hidden", !open);
    document.body.classList.toggle("sheet-open", !!open);
    const settings = $("settingsBtn");
    if (settings) settings.setAttribute("aria-expanded", String(!!open));
    if (open) {
      if (pageKey) openAppPage(pageKey);
      else showDrawer();
      try { syncSliders(); } catch (_) {}
    }
  }

  function applyAccent(name) {
    if (!ACCENTS[name]) name = "nord";
    document.documentElement.setAttribute("data-accent", name);
    state.accent = name;
    document.querySelectorAll("#swatches .swatch").forEach(b => b.setAttribute("aria-checked", String(b.dataset.accent === name)));
  }
  function buildSwatches() {
    if ($("swatches")) $("swatches").innerHTML = Object.entries(ACCENTS).map(([k, c]) =>
      `<button type="button" class="swatch" role="radio" aria-checked="false" data-accent="${k}" style="--c:${c}"><i></i>${k[0].toUpperCase() + k.slice(1)}</button>`).join("");
  }
  const saveLimits = () => chrome.storage.local.set({ loopsLimit: Number(($("loops") || {}).value) || 0, waitMs: Number(($("wait") || {}).value) || 0 });

  /* ---------- feedback ---------- */
  function say(text, kind, seconds) { state.message = { text, kind: kind || "info", until: Date.now() + (seconds || 8) * 1000 }; renderBanner(); }
  function friendly(error) {
    const text = String(error?.message || error || "");
    if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(text)) return "Extensions can't run on this page. Try an ordinary website.";
    if (/Receiving end|Could not establish|message channel closed/i.test(text)) return "The page didn't respond. Reload it and try again.";
    return text || "Something went wrong. Please try again.";
  }
  function twoClick(key) {
    if (state.confirm && state.confirm.key === key && Date.now() < state.confirm.until) { state.confirm = null; return true; }
    state.confirm = { key, until: Date.now() + 3000 };
    render();
    return false;
  }

  /* ---------- tabs ---------- */
  async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }

  async function ensureContent(tabId) {
    try { const reply = await chrome.tabs.sendMessage(tabId, { type: "ping" }); if (reply?.ok) return; } catch (_) { /* not injected yet */ }
    await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPTS });
  }

  /* ---------- recording ---------- */
  async function startRecording() {
    const tab = await activeTab();
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) { say("Open a regular website to record. Browser pages and the Web Store can't be recorded.", "error"); return; }
    try {
      await chrome.storage.local.remove("recordingDraft");
      await ensureContent(tab.id);
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "startRecording", tabId: tab.id });
      if (!reply?.ok) throw new Error(reply?.error || "Couldn't start recording.");
      setTimeout(() => window.close(), 700); // get out of the way so you can use the page
    } catch (error) { say(friendly(error), "error"); }
  }

  async function stopRecording() {
    const draft = state.draft;
    if (!draft) return;
    let reply = null;
    try { reply = await chrome.tabs.sendMessage(draft.tabId, { type: "stopRecording" }); } catch (_) { /* tab gone or navigating */ }
    if (!reply?.ok) {
      const current = (await chrome.storage.local.get({ recordingDraft: null })).recordingDraft;
      if (current) await chrome.storage.local.set({ recordingDraft: { ...current, recording: false, stoppedAt: Date.now() } });
    }
  }

  /* ---------- run controls ---------- */
  // 0 = unlimited; blank/invalid defaults to 1
  const runOptions = () => {
    const raw = $("loops").value;
    let loops = Math.floor(Number(raw));
    if (raw === "" || !Number.isFinite(loops) || loops < 0) loops = 1;
    return {
      loops,
      delayMs: Math.max(0, Math.min(60000, Number(($("wait") || {}).value) || 0))
    };
  };

  async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || "Something went wrong.");
    return reply;
  }

  function checkRoutine(r) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(r.id)) throw new Error("A routine has an invalid id.");
    if (typeof r.name !== "string" || r.name.length > 80 || !r.name.trim()) throw new Error("A routine has an invalid name.");
    let origin;
    try { origin = new URL(r.origin); } catch (_) { throw new Error("A routine has an invalid web origin."); }
    if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" && origin.pathname !== "") throw new Error("A routine must have a plain web origin.");
    if (r.startUrl != null) {
      let start; try { start = new URL(r.startUrl); } catch (_) { throw new Error("A routine start page is invalid."); }
      if (start.origin !== origin.origin || !/^https?:$/.test(start.protocol) || start.username || start.password) throw new Error("A routine start page must use the same origin.");
    }
    if (!Array.isArray(r.actions) || !r.actions.length || r.actions.length > MAX_ACTIONS || !r.actions.every(AutomationPolicy.validAction)) throw new Error("A routine contains unsafe or invalid steps.");
    return true;
  }

  function stripSecrets(actions) {
    return (actions || []).map(a => {
      if (!isPasswordAction(a)) return a;
      const copy = { ...a, value: "" };
      if (a.passwordId) copy.passwordId = a.passwordId;
      return copy;
    });
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportRoutines() {
    const safe = [];
    for (const routine of state.routines) {
      try {
        checkRoutine(routine);
        safe.push({
          id: routine.id, name: routine.name, origin: routine.origin,
          startUrl: routine.startUrl || null, actions: stripSecrets(routine.actions)
        });
      } catch (_) {}
    }
    if (!safe.length && state.routines.length) throw new Error("No saved routines passed the safety checks.");
    const payload = { version: 1, exportedAt: new Date().toISOString(), routines: safe.slice(0, MAX_ROUTINES) };
    downloadJson("browser-command-routines.json", payload);
    say(`Exported ${plural(payload.routines.length, "routine")} (password values stripped).`, "ok");
  }

  function exportOneRoutine(id) {
    const routine = state.routines.find(r => r.id === id);
    if (!routine) throw new Error("Routine not found.");
    checkRoutine(routine);
    const single = {
      id: routine.id,
      name: routine.name,
      origin: routine.origin,
      startUrl: routine.startUrl || null,
      actions: stripSecrets(routine.actions)
    };
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      routines: [single]
    };
    downloadJson(`${safeFileName(routine.name)}.json`, payload);
    say(`Exported “${routine.name}”.`, "ok");
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw new Error("That file is too large (maximum 1 MB).");
    let raw; try { raw = JSON.parse(await file.text()); } catch (_) { throw new Error("Choose a valid JSON export file."); }

    // Accept: full export { version, exportedAt, routines: [...] }
    // or a single routine object { id, name, origin, actions }
    // or { routine: { ... } }
    let routines = [];
    if (raw && Array.isArray(raw.routines)) {
      if (raw.version !== 1) throw new Error("This file is not a supported routine export.");
      routines = raw.routines;
    } else if (raw && raw.routine && typeof raw.routine === "object") {
      routines = [raw.routine];
    } else if (raw && typeof raw === "object" && Array.isArray(raw.actions) && raw.origin) {
      routines = [raw];
    } else {
      throw new Error("This file is not a supported routine export. Use Export on a routine or Export all.");
    }
    if (!routines.length) throw new Error("No routines found in that file.");
    if (routines.length > MAX_ROUTINES) throw new Error(`Import contains more than ${MAX_ROUTINES} routines.`);

    const unique = new Map();
    for (const routine of routines) {
      // Ensure id exists for single-object imports
      if (!routine.id) routine.id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      checkRoutine(routine);
      unique.set(routine.id, routine);
    }
    const payload = {
      version: 1,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
      routines: [...unique.values()]
    };
    const result = await send({ type: "importRoutines", payload });
    say(`Imported ${plural(result.count, "routine")}. Nothing was run.`, "ok");
  }

  /* ---------- rendering ---------- */
  function isPasswordAction(action) {
    return !!(action && (action.isPassword || action.target?.isPassword || action.target?.type === "password" || action.passwordId));
  }

  function stepLabel(action) {
    const t = action.target || {};
    const name = t.text ? `“${t.text.slice(0, 32)}”` : t.tag || "";
    if (action.kind === "click") return ["Click", name];
    if (action.kind === "input") {
      if (isPasswordAction(action)) {
        const linked = action.passwordId ? state.passwords.find(p => p.id === action.passwordId) : null;
        return ["Password", linked ? `${name} → ${linked.label}` : `${name} → ••••••••`];
      }
      return ["Type", `${name} → ${(action.value || "").slice(0, 24)}`];
    }
    if (action.kind === "change") return ["Choose", `${name} → ${(action.value || "").slice(0, 24)}`];
    if (action.kind === "enter") return ["Press Enter", name];
    if (action.kind === "history") return [action.direction === "back" ? "Back" : "Forward", "same-site browser history"];
    return ["Scroll", `to ${action.y}px`];
  }

  function elapsedMs(draft) {
    if (!draft?.startedAt || !Number.isFinite(draft.startedAt)) return 0;
    if (draft.recording) return Math.max(0, Date.now() - draft.startedAt);
    const end = Number.isFinite(draft.stoppedAt) ? draft.stoppedAt
      : (Number.isFinite(draft.updatedAt) ? draft.updatedAt : draft.startedAt);
    return Math.max(0, end - draft.startedAt);
  }

  function renderTimerOnly() {
    const draft = state.draft;
    const recording = !!draft?.recording;
    const el = $("timer");
    if (!el) return;
    el.textContent = clock(elapsedMs(draft));
    el.classList.toggle("recording", recording);
    el.classList.toggle("live", recording || (!!draft && !recording && (draft.actions?.length > 0)));
  }

  function renderStage() {
    const draft = state.draft;
    const recording = !!draft?.recording;
    const hasDraft = !!draft && !recording && draft.actions?.length > 0;
    const running = !!state.run.running;
    const button = $("recordBtn");
    button.classList.toggle("on", recording);
    button.disabled = running;
    button.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
    renderTimerOnly();
    const count = draft?.actions?.length || 0;
    $("hint").textContent = running ? "A routine is replaying. Stop it to record." :
      recording ? `${plural(count, "step")} captured. Use the page, then press stop.` :
      hasDraft ? "Review your recording below." :
      "Press record, then use the page like you normally do.";
  }

  function renderBanner() {
    const note = state.draft && !state.draft.recording && state.draft.note;
    const run = state.run;
    let text = "", kind = "info";
    if (state.message && Date.now() < state.message.until) ({ text, kind } = state.message);
    else if (run && !run.running && run.finishedAt && Date.now() - run.finishedAt < 10000) { text = run.message; kind = run.ok ? "ok" : "error"; }
    else if (note) text = note;
    const banner = $("banner");
    banner.textContent = text;
    banner.className = "banner" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "") + (text ? "" : " hidden");
  }

  function renderRun() {
    const run = state.run;
    $("runCard").classList.toggle("hidden", !run.running);
    if (!run.running) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(run.percent) || 0)));
    $("runTitle").textContent = run.name ? run.name : "Running";
    const loopPart = run.unlimited || run.loops === 0
      ? `Loop ${run.loop || 1} · ∞`
      : `Loop ${run.loop || 1}/${run.loops || 1}`;
    $("runSub").textContent = `${loopPart} · step ${run.step || 0}/${run.steps || 0}`;
    $("runPct").textContent = pct + "%";
    $("runBar").style.width = pct + "%";
  }

  function renderReview() {
    const draft = state.draft;
    const show = !!draft && !draft.recording && draft.actions?.length > 0;
    $("reviewCard").classList.toggle("hidden", !show);
    if (!show) return;
    const actions = draft.actions;
    $("reviewTitle").textContent = `${plural(actions.length, "step")} captured`;
    $("reviewSub").textContent = draft.skipped ? `${host(draft.origin)} · ${draft.skipped} skipped for safety` : host(draft.origin);
    const key = actions.length + ":" + (draft.updatedAt || 0) + ":" + state.passwords.length;
    if ($("steps").dataset.key !== key) {
      $("steps").dataset.key = key;
      $("steps").innerHTML = actions.map((a, i) => {
        const [verb, rest] = stepLabel(a);
        let extra = "";
        if (isPasswordAction(a) && a.kind === "input") {
          const matching = state.passwords.filter(p => !p.origin || p.origin === draft.origin);
          const options = matching.map(p =>
            `<option value="${esc(p.id)}" ${a.passwordId === p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");
          extra = `<select class="pw-link" data-step="${i}" aria-label="Link saved password">
            <option value="">Recorded value</option>${options}
            ${matching.length ? "" : '<option value="" disabled>No saved passwords for this site</option>'}
          </select>`;
        }
        return `<li><b>${esc(verb)}</b><span>${esc(rest)}</span>${extra}</li>`;
      }).join("");
    }
    $("historyBackBtn").disabled = actions.length >= MAX_ACTIONS;
    $("historyForwardBtn").disabled = actions.length >= MAX_ACTIONS;
    $("replayBtn").textContent = state.confirm?.key === "replay" ? "Tap again to run" : "Replay once";
  }

  function renderPasswords() {
    const form = $("pwForm");
    form.classList.toggle("hidden", !state.pwFormOpen);
    $("pwToggleBtn").textContent = state.pwFormOpen ? "Close" : "Add";
    const key = JSON.stringify([state.passwords, state.confirm, state.pwEditId]);
    if (key === state.pwListKey) return;
    state.pwListKey = key;
    const list = $("passwords");
    if (!state.passwords.length) {
      list.innerHTML = '<li class="empty">No saved passwords yet. Add one for quick login automation.</li>';
      return;
    }
    list.innerHTML = state.passwords.map(p => {
      const deleting = state.confirm?.key === "delpw:" + p.id;
      return `<li class="routine"><div class="row"><div class="meta"><strong title="${esc(p.label)}">${esc(p.label)}</strong>
        <span class="sub">${esc(p.origin ? host(p.origin) : "any site")}${p.username ? " · " + esc(p.username) : ""} · <span class="pw-mask" data-pw="${esc(p.id)}">••••••••</span></span></div>
        <div class="acts">
          <button class="icon" data-act="showpw" data-id="${esc(p.id)}" aria-label="Show password" title="Show password">👁</button><button class="icon del ${deleting ? "armed" : ""}" data-act="delpw" data-id="${esc(p.id)}" aria-label="Delete ${esc(p.label)}">${icons.trash}${deleting ? "Sure?" : ""}</button>
        </div></div></li>`;
    }).join("");
  }

  async function insertHistory(direction) {
    const draft = state.draft;
    if (!draft || draft.recording || !Array.isArray(draft.actions) || draft.actions.length >= MAX_ACTIONS) return;
    const actions = [...draft.actions, { kind: "history", direction, at: Date.now() }];
    if (!actions.every(AutomationPolicy.validAction)) return;
    const updated = { ...draft, actions, updatedAt: Date.now() };
    await chrome.storage.local.set({ recordingDraft: updated });
    state.draft = updated;
    say(`${direction === "back" ? "Back" : "Forward"} step added.`, "ok");
    render();
  }

  function scheduleLabel(s) { return s.mode === "delay" ? `in ${s.value} min` : `daily at ${s.value}`; }

  function renderList() {
    const key = JSON.stringify([state.routines, state.schedules, state.scheduleOpen, state.scheduleMode, state.confirm, !!state.run.running]);
    if (key === state.listKey) return;
    state.listKey = key;
    const list = $("routines");
    if (!state.routines.length) { list.innerHTML = '<li class="empty">Nothing saved yet. Record something and save it here.</li>'; return; }
    list.innerHTML = state.routines.map(r => {
      const playing = state.confirm?.key === "play:" + r.id;
      const deleting = state.confirm?.key === "del:" + r.id;
      const chips = state.schedules.filter(s => s.routineId === r.id).map(s =>
        `<span class="chip">${esc(scheduleLabel(s))} · ${s.active ? "active" : esc(s.result || "done")}<button data-act="unschedule" data-id="${esc(s.id)}" aria-label="Remove schedule">×</button></span>`).join("");
      const panel = state.scheduleOpen === r.id ? `
        <div class="sched">
          <div class="seg"><button data-act="mode" data-mode="delay" class="${state.scheduleMode === "delay" ? "on" : ""}">In minutes</button><button data-act="mode" data-mode="clock" class="${state.scheduleMode === "clock" ? "on" : ""}">Every day at</button></div>
          <div class="row">${state.scheduleMode === "delay" ? '<input id="schedValue" type="number" min="1" max="525600" placeholder="15" aria-label="Minutes from now">' : '<input id="schedValue" type="time" value="09:00" aria-label="Time of day">'}
          <button class="btn primary small" data-act="setSchedule" data-id="${esc(r.id)}">Set</button></div>
          <p class="note">Runs only while a tab for this site is open.</p>
        </div>` : "";
      return `<li class="routine"><div class="row"><div class="meta"><strong title="${esc(r.name)}">${esc(r.name)}</strong><span class="sub">${esc(host(r.origin))} · ${plural(r.actions.length, "step")}</span></div>
        <div class="acts">
          <button class="icon go" data-act="play" data-id="${esc(r.id)}" ${state.run.running ? "disabled" : ""} aria-label="Replay ${esc(r.name)}">${icons.play}${playing ? "Run?" : ""}</button>
          <button class="icon" data-act="export" data-id="${esc(r.id)}" aria-label="Export ${esc(r.name)} as JSON">${icons.download}</button>
          <button class="icon" data-act="schedule" data-id="${esc(r.id)}" aria-label="Schedule ${esc(r.name)}">${icons.clock}</button>
          <button class="icon del ${deleting ? "armed" : ""}" data-act="delete" data-id="${esc(r.id)}" aria-label="Delete ${esc(r.name)}">${icons.trash}${deleting ? "Sure?" : ""}</button>
        </div></div>${chips ? `<div class="chips">${chips}</div>` : ""}${panel}</li>`;
    }).join("");
  }

  function proxyOriginOptions() {
    // Unique recorded origins, so the person can pick the site they recorded on.
    const seen = new Map();
    for (const r of state.routines) if (!seen.has(r.origin)) seen.set(r.origin, host(r.origin));
    if (state.draft?.origin && !seen.has(state.draft.origin)) seen.set(state.draft.origin, host(state.draft.origin));
    return [...seen.entries()];
  }

  const cleanLine = line => String(line || "").replace(/^[a-z0-9]+:\/\//i, "").replace(/^[^@/]*@/, "").replace(/^(.+?):(\d+):[^:]+:.+$/, "$1:$2");
  const lineScheme = line => { const m = String(line || "").match(/^([a-z0-9]+):\/\//i); return (m ? m[1] : "http").toLowerCase().replace("socks5h", "socks5"); };
  const lineHost = line => cleanLine(line).replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const barsFor = ping => (ping == null ? 0 : ping < 500 ? 4 : ping < 1200 ? 3 : ping < 2500 ? 2 : 1);
  const chipFor = cc => (cc && /^[A-Z]{2}$/.test(cc) ? cc : "··");

  function renderProxy() {
    const list = state.proxyList || [];
    const premium = !!state.oxylabsEnabled && !!state.oxylabsUser;
    const on = !!state.proxyEnabled && (!!state.proxyGlobalMode || premium);
    const pc = state.proxyCheck || {};
    const busy = !!pc.running;
    const health = state.proxyHealth || {};
    const geo = state.proxyGeo || {};
    const idx = list.length ? Math.max(0, Math.min(state.proxyIndex || 0, list.length - 1)) : 0;

    const u = $("unblockEnabled");
    if (u) u.checked = on;
    const sp = $("proxySpeedMode");
    if (sp) sp.checked = !!state.proxySpeedMode;

    // progress + status line
    const pp = $("proxyProgress");
    if (pp) {
      pp.classList.toggle("hidden", !busy);
      if ($("proxyProgressBar")) $("proxyProgressBar").style.width = (pc.total ? Math.max(4, Math.round((pc.done || 0) / pc.total * 100)) : 8) + "%";
    }
    const ss = $("proxySpeedStatus");
    if (ss) ss.textContent = state.proxySpeedStatus || "";

    // banner
    const exit = state.proxyExit || {};
    const banner = $("nvStatus"), hero = $("nvHero");
    const mode = busy && state.connecting ? "connecting" : (on ? "on" : "off");
    if (banner) banner.dataset.state = mode;
    if (hero) hero.dataset.state = mode;
    if ($("nvStatusLabel")) $("nvStatusLabel").textContent = mode === "connecting" ? "CONNECTING…" : (on ? "PROTECTED" : "NOT PROTECTED");
    if ($("nvIp")) $("nvIp").textContent = exit.ip || (exit.error ? "Unavailable" : "Detecting…");
    if ($("nvLoc")) $("nvLoc").textContent = [exit.city, exit.country].filter(Boolean).join(", ");

    // buttons
    const cb = $("nvConnectBtn"), db = $("nvDisconnectBtn");
    if (cb) {
      cb.classList.toggle("hidden", on);
      cb.disabled = busy;
      cb.textContent = busy ? "Connecting…" : "Quick connect";
    }
    if (db) db.classList.toggle("hidden", !on || busy);
    const cx = $("nvCancelBtn");
    if (cx) cx.classList.toggle("hidden", !busy);

    // current server card
    const cur = $("nvCurrent");
    if (cur) {
      cur.classList.toggle("hidden", !on);
      if (on) {
        if (premium && !list.length) {
          if ($("nvCurFlag")) $("nvCurFlag").textContent = chipFor(exit.cc);
          if ($("nvCurTitle")) $("nvCurTitle").textContent = "Premium proxy";
          if ($("nvCurSub")) $("nvCurSub").textContent = `${state.oxylabsHost}:${state.oxylabsPort}`;
        } else if (list[idx]) {
          const line = list[idx], h = health[String(idx)], g = geo[lineHost(line)] || {};
          if ($("nvCurFlag")) $("nvCurFlag").textContent = chipFor(exit.cc || g.cc);
          if ($("nvCurTitle")) $("nvCurTitle").textContent = exit.country || g.country || lineHost(line);
          if ($("nvCurSub")) $("nvCurSub").textContent = `${cleanLine(line)} · ${lineScheme(line).toUpperCase()}${h && h.ping != null ? " · " + h.ping + " ms" : ""}`;
        }
      }
    }

    // list
    const status = $("proxyStatus");
    const ul = $("proxyList");
    if (!list.length) {
      if (status) status.textContent = "No servers";
      if (ul) ul.innerHTML = `<li class="empty">No servers yet. Tap Quick connect to fetch some, or add your own.</li>`;
      return;
    }
    const checked = Object.values(health).filter(Boolean);
    const working = busy ? Number(pc.working || 0) : checked.filter(h => h.ok === true).length;
    if (status) status.textContent = `${list.length} servers · ${working} working`;
    if (ul) {
      const windowSize = 40;
      let start = Math.max(0, idx - 2);
      let end = Math.min(list.length, start + windowSize);
      if (end - start < windowSize) start = Math.max(0, end - windowSize);
      const rows = [];
      if (start > 0) rows.push(`<li class="empty">… ${start} earlier</li>`);
      for (let i = start; i < end; i++) {
        const line = list[i];
        const h = health[String(i)];
        const g = geo[lineHost(line)] || {};
        let sub = "Not tested", cls = "px-unknown";
        if (busy && pc.current === i) { sub = "Testing…"; cls = "px-checking"; }
        else if (i === idx && on) { sub = h && h.ping != null ? `Connected · ${h.ping} ms` : "Connected"; cls = "px-connected"; }
        else if (h && h.ok === false) { sub = "Unavailable"; cls = "px-down"; }
        else if (h && h.ok === true) { sub = h.ping != null ? `${h.ping} ms` : "Available"; cls = "px-up"; }
        const bars = h && h.ok === true ? barsFor(h.ping) : 0;
        rows.push(
          `<li class="px-row nv-row ${i === idx && on ? "current" : ""} ${cls}" data-idx="${i}" title="Connect to ${esc(cleanLine(line))}" role="button" tabindex="0">` +
          `<span class="nv-flag">${esc(chipFor(g.cc))}</span>` +
          `<span class="nv-row-main"><span class="px-host">${esc(g.country || lineHost(line))}</span>` +
          `<span class="px-meta">${esc(cleanLine(line))} · ${esc(lineScheme(line).toUpperCase())} · ${esc(sub)}</span></span>` +
          `<span class="nv-bars b${bars}" aria-hidden="true"><i></i><i></i><i></i><i></i></span></li>`
        );
      }
      if (end < list.length) rows.push(`<li class="empty">… ${list.length - end} more</li>`);
      ul.innerHTML = rows.join("");
    }
  }

  function renderCaptcha() {
    const form = $("captchaForm");
    if (form) form.classList.toggle("hidden", !state.captchaFormOpen);
    if ($("captchaAssistEnabled")) $("captchaAssistEnabled").checked = state.captchaAssistEnabled !== false;
    if ($("captchaToggleBtn")) $("captchaToggleBtn").textContent = state.captchaFormOpen ? "Close" : "Edit";
    if ($("captchaProvider")) $("captchaProvider").value = state.captchaProvider || "audio";
    if ($("captchaKey")) $("captchaKey").value = state.captchaKey || "";
    if ($("captchaWitToken")) $("captchaWitToken").value = state.captchaWitToken || "";
    if ($("captchaAuto")) $("captchaAuto").checked = !!state.captchaAuto;
    if ($("captchaUrl")) $("captchaUrl").value = state.captchaUrl || "";
    const ul = $("captchaDetected");
    if (ul) {
      const list = state.captchaList;
      if (list == null) ul.innerHTML = "";
      else if (!list.length) ul.innerHTML = `<li class="empty">No captcha found on this page.</li>`;
      else ul.innerHTML = list.map(x => {
        const key = x.sitekey ? `${x.sitekey.slice(0, 8)}…${x.sitekey.slice(-4)}` : "sitekey not exposed";
        const flags = [x.checked ? "solved" : "", x.challenge ? "challenge open" : "", x.invisible ? "invisible" : "", x.blocked ? "blocked by Google" : ""].filter(Boolean).join(" · ");
        return `<li><strong>${esc(x.type)}</strong><span>${esc(key)}${flags ? " · " + esc(flags) : ""}</span></li>`;
      }).join("");
    }
    const status = $("captchaStatus");
    if (status) {
      const hasWit = !!state.captchaWitToken, hasKey = !!state.captchaKey;
      status.textContent = state.captchaSolveStatus
        || (hasWit ? "Free audio solver ready (Wit.ai token saved)." : hasKey ? `API solver ready (${state.captchaProvider === "audio" ? "2captcha" : state.captchaProvider}).` : "Add a free Wit.ai token (or an API key) under Edit to enable solving.");
    }
  }

  async function scanCaptchaNow(focus) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "captchaStatus", focus: !!focus });
      state.captchaList = reply && reply.ok ? (reply.list || []) : [];
      if (reply && reply.note) state.captchaSolveStatus = reply.note;
    } catch (_) { state.captchaList = []; }
    renderCaptcha();
    return state.captchaList;
  }

  function renderTempMail() {
    const mailbox = state.tempMailMailbox;
    const address = $("tempMailAddress");
    if (address) address.textContent = mailbox?.email || "No address generated";
    if ($("tempMailProvider") && document.activeElement !== $("tempMailProvider")) $("tempMailProvider").value = state.tempMailProvider || "auto";
    const providerLink = $("tempMailProviderLink");
    if (providerLink) {
      const provider = mailbox?.provider || state.tempMailProvider || "tempmaillol";
      const map = {
        mailtm: { href: "https://mail.tm/", label: "Mail.tm" },
        tempmaillol: { href: "https://tempmail.lol/", label: "TempMail.lol" },
        guerrilla: { href: "https://www.guerrillamail.com/", label: "Guerrilla Mail" },
        tempmailplus: { href: "https://tempmail.plus/", label: "Tempmail.plus" },
        auto: { href: "https://tempmail.lol/", label: "TempMail.lol" }
      };
      const info = map[provider] || map.tempmaillol;
      providerLink.href = info.href;
      providerLink.textContent = info.label;
    }
    const has = !!mailbox?.email;
    if ($("tempMailCopyBtn")) $("tempMailCopyBtn").disabled = !has;
    if ($("tempMailRefreshBtn")) $("tempMailRefreshBtn").disabled = !has;
    if ($("tempMailClearBtn")) $("tempMailClearBtn").disabled = !has;
    const status = $("tempMailStatus");
    if (status) {
      status.textContent = state.tempMailError || state.tempMailStatus || (has
        ? "Inbox refreshes automatically while the address is active."
        : "Tap New address, or use the small MeMik button beside any email field on a website.");
      status.classList.toggle("error", !!state.tempMailError);
    }
    const list = $("tempMailMessages");
    if (list) {
      const messages = state.tempMailMessages || [];
      list.innerHTML = messages.length
        ? messages.map(m => `<li data-temp-mail-id="${esc(m.id)}" role="button" tabindex="0"><strong>${esc(m.subject || "No subject")}</strong><span>${esc(m.from || "Unknown sender")} · ${esc(m.date ? new Date(m.date).toLocaleString() : "new")}</span>${m.intro ? `<em>${esc(m.intro)}</em>` : ""}</li>`).join("")
        : `<li class="empty">${has ? "No messages yet. This page checks every minute." : "Generate an address to open an inbox."}</li>`;
    }
  }

  // Build a safe, self-contained document for the message iframe (scripts, forms and remote frames removed).
  function messageDocument(message) {
    let html = String(message.html || "");
    const text = String(message.text || "");
    if (!html && text) html = `<pre style="white-space:pre-wrap;font:14px/1.5 system-ui,sans-serif;margin:0">${esc(text)}</pre>`;
    if (!html) html = "<p>This message is empty.</p>";
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<(iframe|object|embed|form|meta|base|link)\b[\s\S]*?(<\/\1>|>)/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "$1=$2#$2");
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:12px 14px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#202124;background:#fff;word-break:break-word}img{max-width:100%;height:auto}a{color:#1a5fe0}table{max-width:100%}</style>
</head><body>${html}</body></html>`;
  }

  // ---------- ad-blocker allowlist ----------
  const allow = { builtin: [], user: [], tabHost: "" };
  const allowMatch = (host, list) => (list || []).find(e => host === e || host.endsWith("." + e)) || "";
  const isAllowedHost = host => !!host && (allowMatch(String(host).toLowerCase(), allow.builtin) || allowMatch(String(host).toLowerCase(), allow.user));

  function renderAllow() {
    const ul = $("allowList");
    if (ul) {
      ul.innerHTML = allow.user.length
        ? allow.user.map(h => `<li><span class="nv-allow-host">${esc(h)}</span><button type="button" class="nv-icon-btn" data-allow-remove="${esc(h)}" aria-label="Stop allowing ${esc(h)}" title="Remove">✕</button></li>`).join("")
        : `<li class="empty">No sites added yet.</li>`;
    }
    if ($("allowBuiltinCount")) $("allowBuiltinCount").textContent = String(allow.builtin.length);
    if ($("allowBuiltin")) $("allowBuiltin").innerHTML = allow.builtin.map(h => `<span class="nv-chip">${esc(h)}</span>`).join("");
    // this-tab switch: ON = ad blocker active on the site
    const sw = $("allowThisSite"), sub = $("allowThisSiteSub");
    if (sw && sub) {
      const host = allow.tabHost;
      if (!host) { sw.disabled = true; sw.checked = true; sub.textContent = "Open a website to change this."; }
      else if (allowMatch(host, allow.builtin)) { sw.disabled = true; sw.checked = false; sub.textContent = `${host} is always allowed (mail service).`; }
      else {
        const entry = allowMatch(host, allow.user);
        sw.disabled = false;
        sw.checked = !entry;
        sub.textContent = entry ? `Off on ${host}. Ads are not blocked there.` : `On for ${host}.`;
      }
    }
  }

  async function loadAllow() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "allowlistGet" });
      if (reply && reply.ok) { allow.builtin = reply.builtin || []; allow.user = reply.user || []; }
    } catch (_) {}
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const u = tab && tab.url ? new URL(tab.url) : null;
      allow.tabHost = u && /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : "";
    } catch (_) { allow.tabHost = ""; }
    renderAllow();
    try { renderBlockLog(state.blockLogRows || []); } catch (_) {}
  }

  async function allowHost(host) {
    const reply = await chrome.runtime.sendMessage({ type: "allowlistAdd", host });
    if (!reply || reply.ok === false) throw new Error((reply && reply.error) || "Could not add that site.");
    if (reply.user) allow.user = reply.user;
    return reply;
  }

  if ($("allowAddBtn")) {
    const add = async () => {
      const input = $("allowAddInput");
      try {
        const reply = await allowHost(input.value);
        input.value = "";
        say(reply.note === "builtin" ? `${reply.host} is already always allowed.` : `Allowed ${reply.host}. Reload the page to see the change.`, "ok");
      } catch (e) { say(e.message || String(e), "error"); }
      renderAllow();
    };
    $("allowAddBtn").onclick = add;
    $("allowAddInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  }
  if ($("allowList")) $("allowList").addEventListener("click", async e => {
    const b = e.target.closest("[data-allow-remove]");
    if (!b) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "allowlistRemove", host: b.dataset.allowRemove });
      if (reply && reply.ok) allow.user = reply.user || [];
      say(`Stopped allowing ${b.dataset.allowRemove}.`, "ok");
    } catch (err) { say(err.message || String(err), "error"); }
    renderAllow();
    try { renderBlockLog(state.blockLogRows || []); } catch (_) {}
  });
  if ($("allowThisSite")) $("allowThisSite").onchange = async () => {
    const host = allow.tabHost;
    if (!host) return;
    const sw = $("allowThisSite");
    try {
      if (sw.checked) {
        const entry = allowMatch(host, allow.user);
        const reply = await chrome.runtime.sendMessage({ type: "allowlistRemove", host: entry || host });
        if (reply && reply.ok) allow.user = reply.user || [];
        say(`Ad blocker is on for ${host}. Reload the page.`, "ok");
      } else {
        await allowHost(host);
        say(`Ad blocker is off for ${host}. Reload the page.`, "ok");
      }
    } catch (err) { say(err.message || String(err), "error"); }
    renderAllow();
  };

  function renderBlockLog(log) {
    const list = $("blockLogList");
    const empty = $("blockLogEmpty");
    const rows = Array.isArray(log) ? log : [];
    state.blockLogRows = rows;
    const preview = $("blockLogPreview");
    const count = $("blockLogCount");
    if (preview) preview.textContent = rows.length ? `${rows.length} recent block${rows.length === 1 ? "" : "s"}` : "View blocked ads & trackers";
    if (count) count.textContent = `${rows.length} entr${rows.length === 1 ? "y" : "ies"}`;
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = "";
      if (empty) { empty.classList.remove("hidden"); empty.textContent = "Blocked ads and trackers will appear here."; }
      return;
    }
    if (empty) empty.classList.add("hidden");
    list.innerHTML = rows.slice(0, 120).map(e => {
      const when = e.at ? new Date(e.at).toLocaleTimeString() : "";
      const page = e.page ? ` on ${esc(e.page)}` : "";
      const kind = (e.kind || "ad").toLowerCase();
      const host = String(e.host || "").toLowerCase();
      const pageHost = String(e.page || "").toLowerCase();
      const hostOk = isAllowedHost(host), pageOk = isAllowedHost(pageHost);
      const actions = (hostOk ? `<span class="bl-allowed">✓ ${esc(host)} allowed</span>` : (host ? `<button type="button" class="bl-allow" data-allow-host="${esc(host)}">Allow ${esc(host)}</button>` : ""))
        + (pageHost && pageHost !== host ? (pageOk ? `<span class="bl-allowed">✓ ${esc(pageHost)} allowed</span>` : `<button type="button" class="bl-allow" data-allow-host="${esc(pageHost)}">Allow whole site ${esc(pageHost)}</button>`) : "");
      return `<li class="vpn-log-item"><div class="bl-host"><span class="vpn-log-badge ${kind}">${esc(kind)}</span> ${esc(e.host || "?")}</div><div class="bl-meta">${esc(e.path || "")}${page} · ${when}</div>${actions ? `<div class="bl-actions">${actions}</div>` : ""}</li>`;
    }).join("");
  }
  if ($("blockLogList")) $("blockLogList").addEventListener("click", async e => {
    const b = e.target.closest("[data-allow-host]");
    if (!b) return;
    b.disabled = true;
    try {
      const reply = await allowHost(b.dataset.allowHost);
      say(`Allowed ${reply.host}. Reload the page to see the change.`, "ok");
    } catch (err) { say(err.message || String(err), "error"); b.disabled = false; }
    renderAllow();
    renderBlockLog(state.blockLogRows || []);
  });

  async function loadBlockLog() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "blockLogGet" });
      if (reply && reply.ok) renderBlockLog(reply.log);
    } catch (_) {
      const data = await chrome.storage.local.get({ blockLog: [] });
      renderBlockLog(data.blockLog);
    }
  }

  if ($("blockLogOpenBtn")) {
    $("blockLogOpenBtn").onclick = () => {
      // Stay inside Security: push Security then open log page
      if ($("sheet") && $("sheet").classList.contains("hidden")) openSheet(true, "security");
      openAppPage("blocklog");
    };
  }
  if ($("blockLogClearBtn")) $("blockLogClearBtn").onclick = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "blockLogClear" });
      renderBlockLog([]);
      say("Block log cleared.", "ok");
    } catch (e) { say(e.message || String(e), "error"); }
  };

  
  
  function updateProxyScanProgress(check) {
    const bar = $("proxyProgressBar");
    const wrap = $("proxyProgress");
    const status = $("proxyStatus");
    const speed = $("proxySpeedStatus");
    if (!check) return;
    const total = Math.max(1, Number(check.total) || 1);
    const done = Math.max(0, Number(check.done) || 0);
    const pct = Math.min(100, Math.round((done / total) * 100));
    if (wrap) wrap.classList.toggle("hidden", !check.running && done === 0);
    if (bar) bar.style.width = pct + "%";
    const msg = check.running
      ? `Scanning ${done}/${total}… ${check.working || 0} working`
      : (check.working
          ? `Done · ${check.working} working · ${check.dead || 0} failed`
          : null);
    if (msg && status) status.textContent = msg;
    if (msg && speed) speed.textContent = msg;
  }

  async function ensureUnblockConnected() {
    state.connecting = true;
    state.proxySpeedStatus = "Finding a working server…";
    renderProxy();
    try {
      const reply = await chrome.runtime.sendMessage({ type: "proxyConnectWorking", forceFetch: true });
      if (!reply || reply.ok === false) {
        state.unblockEnabled = false;
        state.proxyEnabled = false;
        await chrome.storage.local.set({ unblockEnabled: false, proxyEnabled: false });
        throw new Error((reply && reply.error) || "No working server found");
      }
      state.unblockEnabled = true;
      state.proxyEnabled = true;
      await chrome.storage.local.set({ unblockEnabled: true, proxyEnabled: true });
      // Pull the list the background just ranked, so the next save cannot overwrite it with stale data.
      const d = await chrome.storage.local.get({ proxyList: [], proxyIndex: 0, proxyHealth: {}, proxyCheck: {}, proxySpeedStatus: "" });
      state.proxyList = d.proxyList; state.proxyIndex = d.proxyIndex; state.proxyHealth = d.proxyHealth;
      state.proxyCheck = d.proxyCheck; state.proxySpeedStatus = d.proxySpeedStatus;
    } finally {
      state.connecting = false;
      renderProxy();
      syncSecurityPower();
    }
  }

  function syncSecurityPower() {
    const on = !!state.adblockEnabled;
    const btn = $("securityPowerBtn");
    const label = $("securityPowerLabel");
    const sub = $("securityPowerSub");
    if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (label) label.textContent = "Threat Protection";
    if (sub) sub.textContent = on ? "On · blocking ads, trackers and malicious sites" : "Off · tap to block ads, trackers and malicious sites";
  }

  if ($("securityPowerBtn")) {
    $("securityPowerBtn").onclick = async () => {
      // Protection power controls adblock only — never forces Unblock on/off
      const next = !state.adblockEnabled;
      try {
        state.adblockEnabled = next;
        state.antiAdblockEnabled = next;
        if ($("adblockEnabled")) $("adblockEnabled").checked = next;
        await chrome.storage.local.set({ adblockEnabled: next, antiAdblockEnabled: next });
        try {
          await chrome.runtime.sendMessage({ type: "adblockSettingsChanged", enabled: next, antiEnabled: next });
        } catch (_) {}
        syncSecurityPower();
        renderAdblock();
        say(next ? "Protection on (adblock)." : "Protection off.", "ok");
      } catch (e) {
        say(e.message || String(e), "error");
      }
    };
  }

  function renderAdblock() {
    const on = !!state.adblockEnabled;
    try { syncSecurityPower(); } catch (_) {}
    const sw = $("adblockEnabled");
    if (sw) sw.checked = on;
    const st = $("adblockStatus");
    if (st) st.textContent = on ? "Adblock is on (anti-detect included)." : "Adblock is off.";
    try { refreshAdblockUpdateUI(); } catch (_) {}
    const btn = $("adblockBtn");
    if (btn) {
      btn.classList.toggle("on", on);
      btn.classList.toggle("off", !on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Adblock on" : "Adblock off";
    }
  }

  try { refreshMediaFromStorage(); } catch (_) {}
  try { loadBlockLog(); } catch (_) {}
  try { loadAllow(); } catch (_) {}
  try { renderMenuLists(); } catch (_) {}

  function render() {
    renderStage();
    renderBanner();
    renderRun();
    renderReview();
    renderList();
    renderPasswords();
    renderProxy();
    renderCaptcha();
    renderTempMail();
    renderAdblock();
  }

  /* ---------- events ---------- */
  if ($("recordBtn")) $("recordBtn").onclick = () => (state.draft?.recording ? stopRecording() : startRecording());
  $("runStop").onclick = async () => { await chrome.runtime.sendMessage({ type: "stopRoutine" }); say("Stopping after this step…"); };
  $("discardBtn").onclick = () => chrome.storage.local.remove("recordingDraft");
  $("exportBtn").onclick = () => { try { exportRoutines(); } catch (error) { say(friendly(error), "error"); } };
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = async event => { try { await importFile(event.target.files[0]); } catch (error) { say(friendly(error), "error"); } finally { event.target.value = ""; } };
  $("historyBackBtn").onclick = () => insertHistory("back").catch(error => say(friendly(error), "error"));
  $("historyForwardBtn").onclick = () => insertHistory("forward").catch(error => say(friendly(error), "error"));
  
  function initMenu() {
    const wireHome = (id) => {
      const el = $(id);
      if (!el) return;
      el.onclick = (e) => {
        const star = e.target.closest("[data-fav]");
        if (star) {
          e.preventDefault();
          e.stopPropagation();
          toggleFavourite(star.getAttribute("data-fav"));
          return;
        }
        const btn = e.target.closest("[data-page]");
        if (btn) {
          const key = btn.getAttribute("data-page");
          if (key) openSheet(true, key);
        }
      };
    };
    wireHome("homeFavDrawer");
    wireHome("homeRecentDrawer");

    const settings = $("settingsBtn");
    if (settings) {
      settings.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSheet(true);
      };
    }
    if ($("sheetClose")) $("sheetClose").onclick = () => openSheet(false);
    if ($("sheetClose2")) $("sheetClose2").onclick = () => openSheet(false);
    if ($("scrim")) $("scrim").onclick = () => openSheet(false);
    if ($("pageBackBtn")) $("pageBackBtn").onclick = () => goBack();

    const drawer = $("drawerView");
    if (drawer) {
      drawer.onclick = (e) => {
        const star = e.target.closest("[data-fav]");
        if (star) {
          e.preventDefault();
          e.stopPropagation();
          toggleFavourite(star.getAttribute("data-fav"));
          return;
        }
        const btn = e.target.closest("[data-page]");
        if (!btn) return;
        const key = btn.getAttribute("data-page");
        if (key) openSheet(true, key);
      };
    }
  }
  initMenu();

  $("themeBtn").onclick = () => toggleTheme().catch(() => {});
  function wireAppDrawer(rootId) {
    const root = $(rootId);
    if (!root) return;
    root.addEventListener("click", e => {
      const btn = e.target.closest("[data-page]");
      if (!btn) return;
      const key = btn.getAttribute("data-page");
      // Open the feature page directly (skip intermediate Apps grid)
      openSheet(true, key);
    });
  }
    // sheet drawer still handled by appDrawer listener above

  function renderMediaList(result) {
    const list = $("mediaList"); const st = $("mediaStatus"); if (!list) return;
    const items = (result && result.items) || [];
    if (st) st.textContent = items.length ? `Found ${items.length} item(s).` : "No direct media URLs found.";
    list.innerHTML = items.map((it,i)=>`<li data-media-url="${esc(it.url)}" data-media-label="${esc(it.label)}"><strong>${esc(it.label)}</strong><span class="media-meta">${esc(it.type)} · ${esc(it.url)}</span><div class="media-actions"><button type="button" class="btn ghost small" data-media-dl="${i}">Download</button></div></li>`).join("")||`<li class="empty">Nothing yet.</li>`;
    list.querySelectorAll("[data-media-dl]").forEach(btn=>{
      btn.onclick=async()=>{ const li=btn.closest("[data-media-url]"); if(!li)return;
        try { await chrome.runtime.sendMessage({ type:"mediaDownload", url:li.getAttribute("data-media-url"), filename:li.getAttribute("data-media-label")||undefined, title:(result&&result.title)||"" }); say("Download started.","ok"); }
        catch(e){ say(e.message||String(e),"error"); } };
    });
  }
  async function refreshMediaFromStorage() {
    try {
      const data = await chrome.storage.local.get({ mediaDetected: null });
      if (data.mediaDetected && data.mediaDetected.items && data.mediaDetected.items.length) {
        renderMediaList(data.mediaDetected);
      }
    } catch (_) {}
  }

  async function scanMediaNow() {
    const btn = $("mediaScanBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    try {
      const reply = await chrome.runtime.sendMessage({ type: "mediaDetectActiveTab" });
      if (!reply?.ok) throw new Error(reply?.error || "Scan failed");
      renderMediaList(reply.result || {});
    } catch (e) {
      // fall back to last stored detection
      await refreshMediaFromStorage();
      if ($("mediaStatus") && !($("mediaList") && $("mediaList").children.length)) {
        $("mediaStatus").textContent = e.message || String(e);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Refresh list"; }
    }
  }

  if ($("mediaScanBtn")) $("mediaScanBtn").onclick = () => scanMediaNow();
    if ($("mediaPipBtn")) $("mediaPipBtn").onclick = async () => {
    try { const r=await chrome.runtime.sendMessage({type:"mediaPlayerControl",opts:{pip:true}}); if(!r?.ok) throw new Error(r?.error||"PiP failed"); say("PiP toggled.","ok"); }
    catch(e){ say(e.message||String(e),"error"); }
  };
  if ($("mediaApplySpeedBtn")) $("mediaApplySpeedBtn").onclick = async () => {
    const speed=Number(($("mediaSpeed")&&$("mediaSpeed").value)||1);
    try { const r=await chrome.runtime.sendMessage({type:"mediaPlayerControl",opts:{speed}}); if(!r?.ok) throw new Error(r?.error||"Failed"); say("Speed "+speed+"×","ok"); }
    catch(e){ say(e.message||String(e),"error"); }
  };


  // Nested action dropdowns
  document.querySelectorAll(".sub-dd-toggle").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.sub;
      const menu = id ? $(id) : btn.parentElement.querySelector(".sub-dd-menu");
      if (!menu) return;
      const open = menu.classList.contains("hidden");
      document.querySelectorAll(".sub-dd-menu").forEach(m => m.classList.add("hidden"));
      menu.classList.toggle("hidden", !open);
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".sub-dd-menu").forEach(m => m.classList.add("hidden"));
  });

  // Accordion sections in menu
  document.querySelectorAll(".acc-head").forEach(btn => {
    btn.addEventListener("click", () => {
      const sec = btn.closest(".acc-section");
      if (!sec) return;
      const open = !sec.classList.contains("open");
      sec.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      const body = sec.querySelector(".acc-body");
      if (body) body.hidden = !open;
    });
  });

  // Bold +/- buttons next to sliders (theme-coloured)
  document.querySelectorAll(".step-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.target;
      const dir = Number(btn.dataset.dir) || 1;
      const input = $(id);
      if (!input) return;
      const step = Number(input.step) || 1;
      const min = Number(input.min);
      const max = Number(input.max);
      let v = Number(input.value) + dir * step;
      if (Number.isFinite(min)) v = Math.max(min, v);
      if (Number.isFinite(max)) v = Math.min(max, v);
      input.value = String(v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });


  // Menu sections use accordion expand/collapse

        document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").classList.contains("hidden")) openSheet(false); });
  if ($("darkSwitch")) $("darkSwitch").onchange = async () => {
    // darkSwitch only toggles between light/dark; glass is selected via the theme button cycle
    const next = $("darkSwitch").checked ? "dark" : "light";
    state.theme = next;
    applyTheme(next);
    if (state.accent) applyAccent(state.accent);
    await chrome.storage.local.set({ uiTheme: next });
  };
  if ($("swatches")) $("swatches").addEventListener("click", event => {
    const b = event.target.closest("[data-accent]");
    if (!b) return;
    applyAccent(b.dataset.accent);
    chrome.storage.local.set({ uiAccent: b.dataset.accent });
  });
  ["loops", "wait"].forEach(id => { if ($(id)) { $(id).oninput = syncSliders; $(id).onchange = saveLimits; } });

  /* ---------- password vault ---------- */
  function clearPwForm() {
    $("pwLabel").value = ""; $("pwOrigin").value = ""; $("pwUser").value = ""; $("pwPass").value = "";
    state.pwEditId = null;
  }

  $("pwToggleBtn").onclick = () => {
    state.pwFormOpen = !state.pwFormOpen;
    if (state.pwFormOpen) {
      clearPwForm();
      // Prefill origin from the active tab when possible
      activeTab().then(tab => {
        try { if (tab?.url) $("pwOrigin").value = new URL(tab.url).origin; } catch (_) {}
      }).catch(() => {});
    }
    render();
  };
  $("pwCancelBtn").onclick = () => { state.pwFormOpen = false; clearPwForm(); render(); };

  $("pwSaveBtn").onclick = async () => {
    const label = $("pwLabel").value.trim();
    const originRaw = $("pwOrigin").value.trim();
    const username = $("pwUser").value.trim();
    const password = $("pwPass").value;
    if (!label) { say("Give this password a label.", "error"); return; }
    if (!password) { say("Enter the password.", "error"); return; }
    let origin = "";
    if (originRaw) {
      try {
        const u = new URL(originRaw.includes("://") ? originRaw : "https://" + originRaw);
        if (!/^https?:$/.test(u.protocol)) throw new Error("bad");
        origin = u.origin;
      } catch (_) { say("Site must be a normal http(s) origin, e.g. https://mail.example.com", "error"); return; }
    }
    const entry = {
      id: state.pwEditId || crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      label: label.slice(0, 80),
      origin,
      username: username.slice(0, 200),
      password: password.slice(0, 500),
      updatedAt: Date.now()
    };
    const list = state.passwords.filter(p => p.id !== entry.id).concat(entry);
    await chrome.storage.local.set({ savedPasswords: list });
    state.passwords = list;
    state.pwFormOpen = false;
    clearPwForm();
    say(`Saved “${entry.label}”.`, "ok");
    render();
  };

  // One line per saved login: "label,site,username,password" (label/site optional),
  // "site,username,password", or just "username,password". '#' starts a comment.
  function parsePasswordLines(text) {
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(",").map(s => s.trim());
      let label = "", origin = "", username = "", password = "";
      if (parts.length >= 4) { [label, origin, username] = parts; password = parts.slice(3).join(",").trim(); }
      else if (parts.length === 3) [origin, username, password] = parts;
      else if (parts.length === 2) [username, password] = parts;
      else continue;
      if (!password) continue;
      rows.push({ label, origin, username, password });
    }
    return rows;
  }

  async function importPasswordFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw new Error("That file is too large (maximum 1 MB).");
    const rows = parsePasswordLines(await file.text());
    if (!rows.length) throw new Error("No valid lines found. Use label,site,username,password per line.");

    const list = [...state.passwords];
    let added = 0, updated = 0, skipped = 0;
    for (const row of rows.slice(0, MAX_PASSWORDS)) {
      let origin = "";
      if (row.origin) {
        origin = ProxyScope.normalizeOrigin(row.origin) || "";
        if (!origin) { skipped++; continue; } // bad site on this line — skip just this line
      }
      const label = (row.label || row.username || (origin ? host(origin) : "") || "Saved login").slice(0, 80);
      const username = row.username.slice(0, 200);
      const password = row.password.slice(0, 500);
      const match = list.findIndex(p => p.origin === origin && p.username.toLowerCase() === username.toLowerCase());
      if (match !== -1) { list[match] = { ...list[match], label, password, updatedAt: Date.now() }; updated++; }
      else if (list.length < MAX_PASSWORDS) { list.push({ id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), label, origin, username, password, updatedAt: Date.now() }); added++; }
      else skipped++;
    }
    await chrome.storage.local.set({ savedPasswords: list });
    state.passwords = list;
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (updated) parts.push(`${updated} updated`);
    if (skipped) parts.push(`${skipped} skipped`);
    say(`Import: ${parts.join(", ") || "nothing to do"}.`, added || updated ? "ok" : "error");
    render();
  }
  $("pwImportBtn").onclick = () => $("pwImportFile").click();
  $("pwImportFile").onchange = async event => {
    try { await importPasswordFile(event.target.files[0]); }
    catch (error) { say(friendly(error), "error"); }
    finally { event.target.value = ""; }
  };

  if ($("passwords")) $("passwords").addEventListener("click", async event => {
    const showBtn = event.target.closest("[data-act=showpw]");
    if (showBtn) {
      const id = showBtn.dataset.id;
      const entry = state.passwords.find(x => x.id === id);
      const mask = document.querySelector(`.pw-mask[data-pw="${CSS.escape(id)}"]`);
      if (entry && mask) {
        const show = mask.getAttribute("data-shown") !== "1";
        mask.textContent = show ? (entry.password || "") : "••••••••";
        mask.setAttribute("data-shown", show ? "1" : "0");
        showBtn.title = show ? "Hide password" : "Show password";
      }
      return;
    }
    const button = event.target.closest("[data-act=delpw]");
    if (!button) return;
    const id = button.dataset.id;
    if (!twoClick("delpw:" + id)) return;
    const list = state.passwords.filter(p => p.id !== id);
    await chrome.storage.local.set({ savedPasswords: list });
    state.passwords = list;
    say("Password removed.", "ok");
    render();
  });

  /* ---------- proxy settings ---------- */
  function parseProxyList(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#") && !line.startsWith("//"))
      .slice(0, 5000);
  }

  async function saveProxySettings(extra) {
    const payload = {
      proxyList: state.proxyList,
      proxyEnabled: state.proxyEnabled,
      proxyInterval: state.proxyInterval,
      proxyUnit: state.proxyUnit,
      proxyIndex: state.proxyIndex,
      proxyOrigin: state.proxyOrigin,
      proxyGlobalMode: state.proxyGlobalMode,
      proxySpeedMode: state.proxySpeedMode,
      ...extra
    };
    await chrome.storage.local.set(payload);
    // Notify background to apply / reschedule rotation
    try { await chrome.runtime.sendMessage({ type: "proxySettingsChanged" }); } catch (_) {}
  }

  const setBusy = (btn, on) => { if (btn) { btn.disabled = !!on; btn.classList.toggle("busy", !!on); } };
  const reloadProxyState = async () => {
    const d = await chrome.storage.local.get({ proxyList: [], proxyHealth: {}, proxyIndex: 0, proxySpeedStatus: "", proxyEnabled: false, proxyCheck: {}, proxyExit: null, proxyGeo: {} });
    state.proxyList = d.proxyList; state.proxyHealth = d.proxyHealth; state.proxyIndex = d.proxyIndex;
    state.proxySpeedStatus = d.proxySpeedStatus; state.proxyEnabled = !!d.proxyEnabled; state.proxyCheck = d.proxyCheck || {};
    state.proxyExit = d.proxyExit; state.proxyGeo = d.proxyGeo || {};
  };

  $("proxyLoadBtn").onclick = () => $("proxyFile").click();

  // Test every server (up to 100), drop the dead ones, keep the rest sorted fastest first.
  if ($("proxyProbeBtn")) $("proxyProbeBtn").onclick = async () => {
    if (!state.proxyList.length) { say("No servers to test. Tap Quick connect first.", "error"); return; }
    const btn = $("proxyProbeBtn");
    setBusy(btn, true);
    try {
      const reply = await chrome.runtime.sendMessage({ type: "proxyProbeAll" });
      if (reply && reply.ok === false) throw new Error(reply.error || "Test failed");
      const r = reply && reply.result;
      if (r && r.busy) say("A test is already running.", "info");
      else {
        const kept = r ? r.kept : 0;
        say(kept ? `${kept} working server${kept === 1 ? "" : "s"} kept.` : "No working servers found.", kept ? "ok" : "error");
      }
      await reloadProxyState();
      chrome.runtime.sendMessage({ type: "proxyGeolocate", limit: 8 }).catch(() => {});
      render();
    } catch (e) {
      say("Test failed: " + (e.message || e), "error");
    } finally {
      setBusy(btn, false);
    }
  };

  const switchNow = async () => {
    if (!state.proxyEnabled) { say("Connect first, then you can switch servers.", "error"); return; }
    const btns = [$("proxySwitchNowBtn"), $("nvSwapBtn")];
    btns.forEach(b => setBusy(b, true));
    try {
      const reply = await chrome.runtime.sendMessage({ type: "proxyRotateNow" });
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || "Switch failed");
      await reloadProxyState();
      say(reply.stable ? "Switched server. Stable mode keeps it until you switch again." : "Switched server. Timer restarted.", "ok");
    } catch (e) {
      say("Switch failed: " + (e.message || e), "error");
    } finally {
      btns.forEach(b => setBusy(b, false));
      render();
    }
  };
  if ($("proxySwitchNowBtn")) $("proxySwitchNowBtn").onclick = switchNow;
  if ($("nvSwapBtn")) $("nvSwapBtn").onclick = switchNow;

  // Refresh the public server lists, then test them in the background (progress shows live).
  $("proxyFetchBtn").onclick = async () => {
    const btn = $("proxyFetchBtn");
    setBusy(btn, true);
    try {
      say("Downloading server lists…", "info");
      const reply = await chrome.runtime.sendMessage({ type: "proxyFetchFresh" });
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || "Could not fetch servers");
      await reloadProxyState();
      say(`Fetched ${reply.count} servers. Testing them now…`, "ok");
      render();
      chrome.runtime.sendMessage({ type: "proxyProbeAll" }).then(async () => { await reloadProxyState(); render(); }).catch(() => {});
    } catch (e) {
      say("Fetch failed: " + (e.message || e) + " You can also load a .txt list.", "error");
    } finally {
      setBusy(btn, false);
    }
  };

  $("proxyFile").onchange = async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { say("Proxy file is too large (max 2 MB).", "error"); return; }
    try {
      const lines = parseProxyList(await file.text()).filter(validProxyLine).slice(0, 5000);
      if (!lines.length) { say("No valid proxy lines found in that file.", "error"); return; }
      state.proxyList = lines;
      state.proxyIndex = 0;
      await chrome.storage.local.set({ proxyList: lines, proxyIndex: 0, proxyHealth: {} });
      say(`Loaded ${lines.length} server${lines.length === 1 ? "" : "s"}. Connecting…`, "ok");
      render();
      state.connecting = true; renderProxy();
      const reply = await chrome.runtime.sendMessage({ type: "proxyConnectWorking", forceFetch: false });
      state.connecting = false;
      await reloadProxyState();
      if (!reply || reply.ok === false) { say((reply && reply.error) || "No working server in that list.", "error"); }
      else { state.proxyGlobalMode = true; await saveProxySettings({ proxyEnabled: true, proxyGlobalMode: true }); say("Connected.", "ok"); }
      render();
    } catch (err) {
      state.connecting = false;
      say("Could not read the file.", "error");
      render();
    }
  };

  $("proxyClearBtn").onclick = async () => {
    if (!state.proxyList.length) return;
    if (!twoClick("clearproxies")) { say("Tap again to clear the server list.", "info"); return; }
    state.proxyList = [];
    state.proxyIndex = 0;
    state.proxyEnabled = false;
    state.proxyGlobalMode = false;
    await saveProxySettings({ proxyHealth: {}, proxyGeo: {} });
    say("Server list cleared.", "ok");
    render();
  };

  // A line is accepted if it looks like [scheme://][user:pass@]host[:port] or host:port:user:pass, where host is an
  // IPv4 address, a [bracketed IPv6] address or a real domain name (it needs a dot and a letter TLD).
  const PROXY_LINE_RE = /^(?:(?:https?|socks4|socks5h?):\/\/)?(?:[^@\s\/]{1,100}@)?(?:\[[0-9a-f:]{2,45}\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d{1,5})?(?::[^:\s]{1,100}:[^\s]{1,100})?\/?$/i;
  function validProxyLine(line) {
    if (typeof line !== "string" || line.length > 300 || !PROXY_LINE_RE.test(line)) return false;
    const port = cleanLine(line).match(/:(\d{1,5})$/);
    if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) return false;
    const ip = cleanLine(line).replace(/:\d+$/, "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    return !ip || ip.slice(1).every(n => Number(n) <= 255);
  }

  const addProxies = async () => {
    const input = $("proxyAddInput");
    const lines = parseProxyList((input.value || "").replace(/[,;]+/g, "\n"));
    if (!lines.length) { say("Type a server first, e.g. 1.2.3.4:8080", "error"); return; }
    const good = lines.filter(validProxyLine);
    if (!good.length) { say("That does not look like a proxy. Use host:port or user:pass@host:port.", "error"); return; }
    const existing = new Set(state.proxyList);
    const fresh = good.filter(l => !existing.has(l));
    if (!fresh.length) { say("Already in your list.", "info"); return; }
    const firstNew = state.proxyList.length;           // appended, so existing test results keep their positions
    state.proxyList = state.proxyList.concat(fresh);
    await chrome.storage.local.set({ proxyList: state.proxyList });
    input.value = "";
    say(`Added ${fresh.length} server${fresh.length === 1 ? "" : "s"}${good.length < lines.length ? ` (${lines.length - good.length} skipped)` : ""}. Connecting…`, "ok");
    render();
    await connectToIndex(firstNew);
  };
  if ($("proxyAddBtn")) $("proxyAddBtn").onclick = addProxies;
  if ($("proxyAddInput")) $("proxyAddInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addProxies(); } });

  async function connectToIndex(i) {
    try {
      state.connecting = true; state.proxySpeedStatus = "Connecting…"; renderProxy();
      const reply = await chrome.runtime.sendMessage({ type: "proxySelect", index: i });
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || "That server did not respond.");
      state.proxyGlobalMode = true;
      await saveProxySettings({ proxyEnabled: true, proxyGlobalMode: true, proxyIndex: i });
      say("Connected.", "ok");
    } catch (e) {
      say(e.message || String(e), "error");
    } finally {
      state.connecting = false;
      await reloadProxyState();
      render();
    }
  }

  if ($("proxyList")) {
    const pick = row => { if (row && row.dataset.idx != null) connectToIndex(Number(row.dataset.idx)); };
    $("proxyList").addEventListener("click", e => pick(e.target.closest(".px-row")));
    $("proxyList").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { const r = e.target.closest(".px-row"); if (r) { e.preventDefault(); pick(r); } } });
  }

  async function setUnblockEnabled(on) {
    try {
      if (on) {
        if (state.oxylabsEnabled && state.oxylabsUser) {
          // Premium proxy configured: apply it instead of scanning free servers.
          state.proxyEnabled = true; state.proxyGlobalMode = true;
          await saveProxySettings({ proxyEnabled: true, proxyGlobalMode: true });
          say("Connected through the premium proxy.", "ok");
        } else {
          say("Finding the best server…", "info");
          await ensureUnblockConnected();
          state.proxyGlobalMode = true;
          await saveProxySettings({ proxyList: state.proxyList, proxyIndex: state.proxyIndex });
          say("Connected.", "ok");
        }
      } else {
        await chrome.runtime.sendMessage({ type: "proxyDisconnect" });   // clears Chrome's proxy, then records "disconnected"
        state.proxyEnabled = false;
        state.unblockEnabled = false;
        state.proxyGlobalMode = false;
        state.oxylabsEnabled = false;    // otherwise the premium proxy would silently stay active
        if ($("oxylabsEnabled")) $("oxylabsEnabled").checked = false;
        await saveProxySettings();
        say("Disconnected.", "ok");
      }
      try { chrome.runtime.sendMessage({ type: "proxyExitInfo" }).catch(() => {}); } catch (_) {}
    } catch (e) {
      const u = $("unblockEnabled");
      if (u) u.checked = false;
      say(e.message || String(e), "error");
    } finally {
      state.connecting = false;
      try { await reloadProxyState(); } catch (_) {}
      render();
    }
  }
  if ($("unblockEnabled")) $("unblockEnabled").onchange = () => setUnblockEnabled($("unblockEnabled").checked);
  if ($("nvConnectBtn")) $("nvConnectBtn").onclick = () => setUnblockEnabled(true);
  if ($("nvDisconnectBtn")) $("nvDisconnectBtn").onclick = () => setUnblockEnabled(false);
  if ($("nvCancelBtn")) $("nvCancelBtn").onclick = async () => {
    try { await chrome.runtime.sendMessage({ type: "proxyCancel" }); } catch (_) {}
    say("Cancelling…", "info");
  };

  async function saveOxylabsSettings() {
    const enabled = !!($("oxylabsEnabled") && $("oxylabsEnabled").checked);
    const payload = {
      enabled,
      host: ($("oxylabsHost") && $("oxylabsHost").value.trim()) || "unblock.oxylabs.io",
      port: ($("oxylabsPort") && $("oxylabsPort").value) || 60000,
      user: ($("oxylabsUser") && $("oxylabsUser").value.trim()) || "",
      pass: ($("oxylabsPass") && $("oxylabsPass").value) || "",
      session: ($("oxylabsSession") && $("oxylabsSession").value.trim()) || "",
      geo: ($("oxylabsGeo") && $("oxylabsGeo").value.trim()) || ""
    };
    state.oxylabsEnabled = enabled;
    state.oxylabsHost = payload.host;
    state.oxylabsPort = Number(payload.port) || 60000;
    state.oxylabsUser = payload.user;
    state.oxylabsPass = payload.pass;
    state.oxylabsSession = payload.session;
    state.oxylabsGeo = payload.geo;
    await chrome.storage.local.set({
      oxylabsEnabled: enabled,
      oxylabsHost: payload.host,
      oxylabsPort: state.oxylabsPort,
      oxylabsUser: payload.user,
      oxylabsPass: payload.pass,
      oxylabsSession: payload.session,
      oxylabsGeo: payload.geo
    });
    try {
      await chrome.runtime.sendMessage({ type: "oxylabsSettingsChanged", ...payload });
    } catch (_) {}
    state.proxyEnabled = enabled ? true : state.proxyEnabled;
    say(enabled ? (payload.user ? "Premium proxy on." : "Enter your Oxylabs username first.") : "Premium proxy off.", enabled && !payload.user ? "error" : "ok");
    renderProxy();
  }
  if ($("oxylabsEnabled")) $("oxylabsEnabled").onchange = () => saveOxylabsSettings();
  ["oxylabsHost","oxylabsPort","oxylabsUser","oxylabsPass","oxylabsSession","oxylabsGeo"].forEach(id => {
    if ($(id)) $(id).onchange = () => saveOxylabsSettings();
  });

  $("proxySpeedMode").onchange = async () => {
    state.proxySpeedMode = !!$("proxySpeedMode").checked;
    await chrome.storage.local.set({ proxySpeedMode: state.proxySpeedMode });
    try {
      const reply = await chrome.runtime.sendMessage({ type: "proxySpeedModeChanged", enabled: state.proxySpeedMode });
      if (reply && reply.result && reply.result.result) {
        const r = reply.result.result;
        state.proxySpeedStatus = r.latency != null
          ? `Fastest: #${r.index + 1} · ${r.latency} ms`
          : (state.proxySpeedStatus || "");
      }
    } catch (_) {}
    say(state.proxySpeedMode
      ? "Stick to fastest on — will check a few proxies, then keep the winner."
      : "Stick to fastest off.", "ok");
    render();
  };


  $("proxyEnabled").onchange = () => {}; // legacy hidden field

  $("proxyOrigin").onchange = async () => {
    const raw = $("proxyOrigin").value.trim();
    if (!raw) {
      state.proxyOrigin = "";
      await saveProxySettings();
      render();
      return;
    }
    const origin = ProxyScope.normalizeOrigin(raw);
    if (!origin) {
      say("Enter a plain site like example.com or https://example.com", "error");
      $("proxyOrigin").value = state.proxyOrigin ? host(state.proxyOrigin) : "";
      return;
    }
    state.proxyOrigin = origin;
    $("proxyOrigin").value = host(origin);
    await saveProxySettings();
    render();
  };
  $("proxyInterval").oninput = syncSliders;
  $("proxyInterval").onchange = async () => {
    state.proxyInterval = Math.max(1, Math.min(60, parseInt($("proxyInterval").value, 10) || 5));
    syncSliders();
    await saveProxySettings();
  };
  if ($("proxyUnitSeg")) $("proxyUnitSeg").addEventListener("click", async event => {
    const b = event.target.closest("button[data-unit]");
    if (!b) return;
    state.proxyUnit = b.dataset.unit;
    $("proxyUnit").value = state.proxyUnit;
    syncSliders();
    await saveProxySettings();
  });

  /* ---------- captcha settings ---------- */
  if ($("captchaToggleBtn")) $("captchaToggleBtn").onclick = () => {
    state.captchaFormOpen = !state.captchaFormOpen;
    render();
  };
  if ($("captchaCancelBtn")) $("captchaCancelBtn").onclick = () => {
    state.captchaFormOpen = false;
    render();
  };
  if ($("captchaSaveBtn")) $("captchaSaveBtn").onclick = async () => {
    const provider = ($("captchaProvider") && $("captchaProvider").value) || "none";
    const key = ($("captchaKey") && $("captchaKey").value.trim()) || "";
    const wit = ($("captchaWitToken") && $("captchaWitToken").value.trim()) || "";
    state.captchaWitToken = wit.slice(0, 200);
    state.captchaAuto = !!($("captchaAuto") && $("captchaAuto").checked);
    const url = ($("captchaUrl") && $("captchaUrl").value.trim()) || "";
    // Key is optional — assisted mode works without it
    state.captchaProvider = provider;
    state.captchaKey = key.slice(0, 200);
    state.captchaUrl = url.slice(0, 300);
    await chrome.storage.local.set({
      captchaProvider: state.captchaProvider,
      captchaKey: state.captchaKey,
      captchaUrl: state.captchaUrl,
      captchaWitToken: state.captchaWitToken,
      captchaAuto: state.captchaAuto
    });
    state.captchaFormOpen = false;
    say(key || wit ? "Captcha settings saved." : "Saved — add a token or key to enable solving.", "ok");
    render();
  };

  if ($("captchaAssistEnabled")) $("captchaAssistEnabled").onchange = async () => {
    state.captchaAssistEnabled = !!$("captchaAssistEnabled").checked;
    await chrome.storage.local.set({ captchaAssistEnabled: state.captchaAssistEnabled });
    say(state.captchaAssistEnabled ? "Assisted captcha on." : "Assisted captcha off.", "ok");
    renderCaptcha();
  };

  if ($("captchaSolveBtn")) $("captchaSolveBtn").onclick = async () => {
    const btn = $("captchaSolveBtn");
    const title = btn && btn.querySelector(".vpn-row-title");
    if (btn) btn.disabled = true;
    if (title) title.textContent = "Solving…";
    state.captchaSolveStatus = "Working on it…";
    renderCaptcha();
    try {
      const reply = await chrome.runtime.sendMessage({ type: "captchaSolveActiveTab" });
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || "Solve failed");
      const how = reply.method === "audio" ? "Captcha solved with the audio challenge." : (reply.injected ? "Captcha solved and token filled in." : "Solved — submit the form if needed.");
      state.captchaSolveStatus = reply.note || how;
      say(state.captchaSolveStatus, "ok");
    } catch (e) {
      state.captchaSolveStatus = e.message || String(e);
      say(state.captchaSolveStatus, "error");
    } finally {
      if (btn) btn.disabled = false;
      if (title) title.textContent = "Solve captcha";
      scanCaptchaNow(false);
    }
  };

  if ($("captchaAssistNowBtn")) $("captchaAssistNowBtn").onclick = async () => {
    state.captchaSolveStatus = "";
    const list = await scanCaptchaNow(true);
    say(list.length ? `Found: ${list.map(x => x.type).join(", ")}.` : "No captcha found on this page.", list.length ? "ok" : "info");
  };
  if ($("captchaClearBtn")) $("captchaClearBtn").onclick = async () => {
    if (!state.captchaKey && !state.captchaWitToken) return;
    if (!twoClick("clearcaptcha")) { say("Tap again to clear the saved captcha keys.", "info"); return; }
    state.captchaKey = "";
    state.captchaUrl = "";
    state.captchaWitToken = "";
    state.captchaAuto = false;
    await chrome.storage.local.set({ captchaKey: "", captchaUrl: "", captchaWitToken: "", captchaAuto: false });
    state.captchaFormOpen = false;
    say("Captcha keys cleared.", "ok");
    render();
  };

  /* ---------- temporary email ---------- */
  function applyTempMailState(data) {
    if (!data) return;
    if ("provider" in data) state.tempMailProvider = data.provider || state.tempMailProvider || "auto";
    if ("mailbox" in data) state.tempMailMailbox = data.mailbox || null;
    if ("messages" in data) state.tempMailMessages = Array.isArray(data.messages) ? data.messages : [];
    if ("selectedId" in data) state.tempMailSelectedId = data.selectedId || "";
    if ("status" in data) state.tempMailStatus = data.status || "";
    if ("error" in data) state.tempMailError = data.error || "";
    renderTempMail();
  }

  async function tempMailRequest(type, extra) {
    const reply = await chrome.runtime.sendMessage({ type, ...(extra || {}) });
    if (!reply?.ok) throw new Error(reply?.error || "Temporary email request failed.");
    applyTempMailState(reply);
    return reply;
  }

  if ($("tempMailProvider")) $("tempMailProvider").onchange = async () => {
    state.tempMailProvider = ($("tempMailProvider").value || "auto");
    await chrome.storage.local.set({ tempMailProvider: state.tempMailProvider });
    // Keep dropdown choice in temp-mail module state too
    try {
      await chrome.runtime.sendMessage({ type: "tempMailSetProvider", provider: state.tempMailProvider });
    } catch (_) {}
  };
  if ($("tempMailGenerateBtn")) $("tempMailGenerateBtn").onclick = async () => {
    const button = $("tempMailGenerateBtn");
    const provider = ($("tempMailProvider") && $("tempMailProvider").value) || state.tempMailProvider || "auto";
    state.tempMailProvider = provider;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Working…";
    say(provider === "auto" ? "Contacting providers…" : "Creating address…", "info");
    try {
      await chrome.storage.local.set({ tempMailProvider: provider });
      await tempMailRequest("tempMailGenerate", { provider });
      const used = state.tempMailMailbox?.provider || provider;
      say(`Address ready (${used}).`, "ok");
    } catch (error) {
      say(error.message || String(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = label;
      renderTempMail();
    }
  };
  if ($("tempMailDiagBtn")) $("tempMailDiagBtn").onclick = async () => {
    const btn = $("tempMailDiagBtn"), ul = $("tempMailDiag");
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Testing…";
    ul.innerHTML = `<li class="empty">Checking every provider from your connection…</li>`;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "tempMailDiagnose" });
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || "Test failed");
      ul.innerHTML = reply.results.map(r => `<li class="${r.ok ? "ok" : "bad"}"><strong>${esc(r.name)}</strong><span>${r.ok ? `Working · ${r.ms} ms` : `Not working · ${esc(r.error || "unknown error")}`}</span></li>`).join("");
    } catch (e) { ul.innerHTML = `<li class="bad"><span>${esc(e.message || String(e))}</span></li>`; }
    finally { btn.disabled = false; btn.textContent = label; }
  };
  if ($("tempMailCopyBtn")) $("tempMailCopyBtn").onclick = async () => {
    const value = state.tempMailMailbox?.email;
    if (!value) { say("No address to copy.", "error"); return; }
    try {
      await navigator.clipboard.writeText(value);
      say("Temporary email copied.", "ok");
    } catch (_) {
      say("Clipboard access was denied by the browser.", "error");
    }
  };
  if ($("tempMailRefreshBtn")) $("tempMailRefreshBtn").onclick = async () => {
    try { await tempMailRequest("tempMailRefresh"); say("Inbox refreshed.", "ok"); }
    catch (error) { say(error.message || String(error), "error"); }
  };
  if ($("tempMailClearBtn")) $("tempMailClearBtn").onclick = async () => {
    if (!twoClick("clear-temp-mail")) return;
    try { await tempMailRequest("tempMailClear"); say("Temporary email cleared.", "ok"); }
    catch (error) { say(error.message || String(error), "error"); }
  };
  function openTempMailMessage(message) {
    const reader = $("tempMailReader");
    const list = $("tempMailMessages");
    if (!reader) return;
    if (list) list.classList.add("hidden");
    reader.classList.remove("hidden");
    const sub = $("tempMailSubject");
    const meta = $("tempMailMeta");
    const frame = $("tempMailFrame");
    if (sub) sub.textContent = message.subject || "No subject";
    if (meta) {
      const when = message.date ? new Date(message.date).toLocaleString() : "";
      meta.textContent = `${message.from || "Unknown"}${when ? " · " + when : ""}`;
    }
    if (frame) frame.srcdoc = messageDocument(message);
  }

  const closeMailReader = () => {
    const reader = $("tempMailReader");
    const list = $("tempMailMessages");
    if (reader) reader.classList.add("hidden");
    if (list) list.classList.remove("hidden");
    const frame = $("tempMailFrame");
    if (frame) frame.srcdoc = "";
    state.tempMailSelectedId = "";
    chrome.runtime.sendMessage({ type: "tempMailCloseReader" }).catch(() => {});
  };
  if ($("tempMailBackBtn")) $("tempMailBackBtn").onclick = closeMailReader;

  const openMail = async row => {
    if (!row) return;
    try {
      const reply = await tempMailRequest("tempMailGetMessage", { id: row.dataset.tempMailId });
      openTempMailMessage(reply.message || {});
    } catch (error) { say(error.message || String(error), "error"); }
  };
  if ($("tempMailMessages")) {
    $("tempMailMessages").addEventListener("click", e => openMail(e.target.closest("[data-temp-mail-id]")));
    $("tempMailMessages").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { const r = e.target.closest("[data-temp-mail-id]"); if (r) { e.preventDefault(); openMail(r); } } });
  }

  /* ---------- adblock ---------- */
  async function setAdblockEnabled(on) {
    state.adblockEnabled = !!on;
    state.antiAdblockEnabled = !!on; // always paired
    await chrome.storage.local.set({
      adblockEnabled: state.adblockEnabled,
      antiAdblockEnabled: state.antiAdblockEnabled
    });
    try {
      await chrome.runtime.sendMessage({
        type: "adblockSettingsChanged",
        enabled: state.adblockEnabled,
        antiEnabled: state.antiAdblockEnabled
      });
    } catch (_) {}
    say(state.adblockEnabled ? "Adblock enabled." : "Adblock disabled.", "ok");
    try { syncSecurityPower(); } catch (_) {}
    render();
  }
  if ($("adblockBtn")) $("adblockBtn").onclick = () => setAdblockEnabled(!state.adblockEnabled);
  if ($("adblockEnabled")) $("adblockEnabled").onchange = () => setAdblockEnabled($("adblockEnabled").checked);

  async function refreshAdblockUpdateUI() {
    const data = await chrome.storage.local.get({
      adblockAutoUpdate: true,
      adblockListVersion: "bundled",
      adblockRemoteVersion: "",
       adblockUpdateAvailable: false,
       adblockUpdateStatus: "",
       adblockLastUpdated: 0,
       adblockSourceStatus: ""
    });
    state.adblockAutoUpdate = data.adblockAutoUpdate !== false;
    if ($("adblockAutoUpdate")) $("adblockAutoUpdate").checked = state.adblockAutoUpdate;
    const st = $("adblockUpdateStatus");
    if (st) {
       let line = data.adblockUpdateStatus || data.adblockSourceStatus || "";
      if (!line) {
        const local = data.adblockListVersion || "bundled";
        const remote = data.adblockRemoteVersion || "";
        if (data.adblockUpdateAvailable && remote) line = `Update available: ${remote} (you have ${local})`;
        else line = `Filters: ${local}` + (remote && remote === local ? " · up to date" : "");
      }
      st.textContent = line;
    }
  }

  if ($("adblockAutoUpdate")) $("adblockAutoUpdate").onchange = async () => {
    const on = !!$("adblockAutoUpdate").checked;
    state.adblockAutoUpdate = on;
    try {
      await chrome.runtime.sendMessage({ type: "adblockAutoUpdateChanged", enabled: on });
    } catch (_) {
      await chrome.storage.local.set({ adblockAutoUpdate: on });
    }
    say(on ? "Filter auto-update on." : "Filter auto-update off — use Update now.", "ok");
    refreshAdblockUpdateUI();
  };

  if ($("adblockCheckBtn")) $("adblockCheckBtn").onclick = async () => {
    const b = $("adblockCheckBtn");
    if (b) { b.disabled = true; b.textContent = "Checking…"; }
    try {
      const reply = await chrome.runtime.sendMessage({ type: "adblockCheckUpdate" });
      const r = reply && reply.result;
      if (r && r.error) say(r.error, "error");
      else if (r && r.available) say(`Update available: ${r.tag}`, "ok");
      else say("Filters are up to date.", "ok");
      await refreshAdblockUpdateUI();
    } catch (e) {
      say("Check failed: " + (e.message || e), "error");
    } finally {
      if (b) { b.disabled = false; b.textContent = "Check update"; }
    }
  };

  if ($("adblockUpdateBtn")) $("adblockUpdateBtn").onclick = async () => {
    const b = $("adblockUpdateBtn");
    if (b) { b.disabled = true; b.textContent = "Updating…"; }
    try {
      const reply = await chrome.runtime.sendMessage({ type: "adblockRunUpdate" });
      if (reply && reply.ok) say(`Updated · ${reply.count || 0} host rules`, "ok");
      else say((reply && reply.error) || "Update failed", "error");
      await refreshAdblockUpdateUI();
    } catch (e) {
      say("Update failed: " + (e.message || e), "error");
    } finally {
      if (b) { b.disabled = false; b.textContent = "Update now"; }
    }
  };

  $("replayBtn").onclick = async () => {
    const draft = state.draft;
    if (!draft?.actions?.length || !twoClick("replay")) return;
    try { await send({ type: "runRecording", recording: { origin: draft.origin, startUrl: draft.startUrl, actions: draft.actions }, ...runOptions(), confirmed: true }); say("Replay started."); }
    catch (error) { say(friendly(error), "error"); }
  };

  if ($("routines")) $("routines").addEventListener("click", async event => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const id = button.dataset.id;
    const act = button.dataset.act;
    try {
      if (act === "play") {
        if (!twoClick("play:" + id)) return;
        await send({ type: "runRoutine", routineId: id, ...runOptions(), confirmed: true });
        say("Replay started.");
      } else if (act === "export") {
        exportOneRoutine(id);
      } else if (act === "delete") {
        if (!twoClick("del:" + id)) return;
        await send({ type: "deleteRoutine", id });
      } else if (act === "schedule") {
        state.scheduleOpen = state.scheduleOpen === id ? null : id; render();
      } else if (act === "mode") {
        state.scheduleMode = button.dataset.mode; render();
      } else if (act === "setSchedule") {
        await send({ type: "scheduleRoutine", routineId: id, mode: state.scheduleMode, value: $("schedValue").value.trim(), confirmed: true });
        state.scheduleOpen = null; say("Schedule set.", "ok");
      } else if (act === "unschedule") {
        await send({ type: "cancelSchedule", id });
      }
    } catch (error) { say(friendly(error), "error"); }
  });


  /* ---------- blocked counters ---------- */
  const fmtN = n => Number(n || 0).toLocaleString();
  function renderStats() {
    const s = state.blockStats || {};
    const ads = s.ads || 0, tr = s.trackers || 0;
    if ($("statAds")) $("statAds").textContent = fmtN(ads);
    if ($("statTrackers")) $("statTrackers").textContent = fmtN(tr);
    if ($("statTotal")) $("statTotal").textContent = fmtN(ads + tr);
  }
  async function loadStats() {
    const d = await chrome.storage.local.get({ blockStats: { ads: 0, trackers: 0 }, proxyCheck: {}, proxyHealth: {} });
    state.blockStats = d.blockStats; state.proxyCheck = d.proxyCheck; state.proxyHealth = d.proxyHealth;
    renderStats();
    if ($("statsResetBtn")) $("statsResetBtn").onclick = async () => {
      await chrome.storage.local.set({ blockStats: { ads: 0, trackers: 0, since: Date.now() } });
    };
  }

  /* ---------- state sync ---------- */
  let frame = 0;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); };
  
  /* ---------- Site audit + breach check ---------- */
  function renderAuditFindings(result) {
    const st = $("detScanStatus");
    if (st) {
      const n = (result && result.findings && result.findings.length) || 0;
      const when = new Date().toLocaleTimeString();
      st.textContent = n ? `Scan completed ${when} · ${n} finding(s)` : `Scan completed ${when} · no issues found`;
    }

    const el = $("auditResults");
    if (!el) return;
    if (!result || !result.findings) {
      el.textContent = "No results.";
      return;
    }
    const s = result.summary || {};
    const lines = [
      `URL: ${result.url || ""}`,
      `XSS findings: ${s.xss || 0} · SQL surfaces: ${s.sqli || 0} · High: ${s.high || 0}`,
      ""
    ];
    for (const f of result.findings) {
      if (f.type === "info") continue;
      lines.push(`[${(f.level || "").toUpperCase()}] ${f.type.toUpperCase()}: ${f.title}`);
      lines.push(`  ${f.detail}`);
      lines.push("");
    }
    const info = result.findings.find(f => f.type === "info");
    if (info) lines.push(info.detail);
    el.textContent = lines.join("\n");
  }

  
  async function runDetective(mode) {
    const out = $("auditResults");
    if (out) out.textContent = "Running…";
    try {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a normal http(s) page first.");
      let reply;
      try {
        reply = await chrome.tabs.sendMessage(tab.id, { type: "detectiveScan", mode: mode || "all" });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/security-scan.js"] });
        reply = await chrome.tabs.sendMessage(tab.id, { type: "detectiveScan", mode: mode || "all" });
      }
      if (!reply?.ok) throw new Error(reply?.error || "Scan failed");
      renderAuditFindings(reply.result);
    } catch (e) {
      if (out) out.textContent = e.message || String(e);
      say(e.message || String(e), "error");
    }
  }

  [
    ["detInfoBtn", "info"],
    ["detLinksBtn", "links"],
    ["detHeadersBtn", "headers"],
    ["detMixBtn", "mixed"],
    ["detCookieBtn", "cookie"],
    ["detCspBtn", "csp"],
    ["detXssBtn", "xss"],
    ["detSqlBtn", "sql"],
    ["detRedirectBtn", "redirect"]
  ].forEach(([id, mode]) => {
    if ($(id)) $(id).onclick = () => runDetective(mode);
  });

  if ($("auditScanBtn")) $("auditScanBtn").onclick = () => runDetective("all");

  if ($("breachCheckBtn")) $("breachCheckBtn").onclick = async () => {
    const email = ($("breachEmail") && $("breachEmail").value.trim()) || "";
    const out = $("breachResults");
    if (out) out.textContent = "Checking…";
    try {
      const reply = await chrome.runtime.sendMessage({ type: "breachCheckEmail", email });
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || "Lookup failed");
      if (!reply.found) {
        if (out) out.textContent = reply.message || "No breaches found.";
      } else {
        const list = (reply.breaches || []).slice(0, 40).join("\n• ");
        if (out) out.textContent = (reply.message || "") + "\n\n• " + list;
      }
      say(reply.found ? "Breaches found." : "No breaches found.", reply.found ? "error" : "ok");
    } catch (e) {
      if (out) out.textContent = e.message || String(e);
      say(e.message || String(e), "error");
    }
  };

  if ($("pwnedPassBtn")) $("pwnedPassBtn").onclick = async () => {
    const password = ($("breachPassword") && $("breachPassword").value) || "";
    const out = $("pwnedPassResults");
    if (out) out.textContent = "Checking…";
    try {
      const reply = await chrome.runtime.sendMessage({ type: "pwnedPasswordCheck", password });
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || "Check failed");
      if (out) out.textContent = reply.message || "";
      say(reply.pwned ? "Password is compromised." : "Password not in HIBP list.", reply.pwned ? "error" : "ok");
    } catch (e) {
      if (out) out.textContent = e.message || String(e);
      say(e.message || String(e), "error");
    }
  };


  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.blockLog) {
      try { renderBlockLog(changes.blockLog.newValue || []); } catch (_) {}
    }
    if (area === "local" && changes.mediaDetected) {
      try {
        const panel = document.querySelector('[data-page-panel="media"]');
        if (panel && !panel.classList.contains("hidden")) renderMediaList(changes.mediaDetected.newValue || {});
      } catch (_) {}
    }

    if (area !== "local") return;
    if ("recordingDraft" in changes) state.draft = changes.recordingDraft.newValue || null;
    if ("routines" in changes) state.routines = changes.routines.newValue || [];
    if ("schedules" in changes) state.schedules = changes.schedules.newValue || [];
    if ("runStatus" in changes) state.run = changes.runStatus.newValue || {};
    if ("savedPasswords" in changes) state.passwords = changes.savedPasswords.newValue || [];
    if ("proxyList" in changes) state.proxyList = changes.proxyList.newValue || [];
    if ("proxyEnabled" in changes) state.proxyEnabled = !!changes.proxyEnabled.newValue;
    if ("proxyInterval" in changes) state.proxyInterval = changes.proxyInterval.newValue ?? 5;
    if ("proxyUnit" in changes) state.proxyUnit = changes.proxyUnit.newValue || "minutes";
    if ("proxyIndex" in changes) state.proxyIndex = changes.proxyIndex.newValue || 0;
    if ("proxyOrigin" in changes) state.proxyOrigin = changes.proxyOrigin.newValue || "";
    if ("proxyGlobalMode" in changes) state.proxyGlobalMode = !!changes.proxyGlobalMode.newValue;
    if ("proxySpeedMode" in changes) state.proxySpeedMode = !!changes.proxySpeedMode.newValue;
    if ("proxySpeedStatus" in changes) state.proxySpeedStatus = changes.proxySpeedStatus.newValue || "";
    if ("proxyBestLatency" in changes) {/* status string carries display */}
    if ("captchaProvider" in changes) state.captchaProvider = changes.captchaProvider.newValue || "audio";
    if ("captchaSolveStatus" in changes) { state.captchaSolveStatus = changes.captchaSolveStatus.newValue || ""; try { renderCaptcha(); } catch (_) {} }
    if ("captchaKey" in changes) state.captchaKey = changes.captchaKey.newValue || "";
     if ("captchaUrl" in changes) state.captchaUrl = changes.captchaUrl.newValue || "";
     if ("captchaStatus" in changes) state.captchaStatus = changes.captchaStatus.newValue || {};
     if ("tempMailProvider" in changes) state.tempMailProvider = changes.tempMailProvider.newValue || "auto";
     if ("tempMailState" in changes) applyTempMailState(changes.tempMailState.newValue || {});
    if ("blockStats" in changes) { state.blockStats = changes.blockStats.newValue || {}; renderStats(); }
    if ("proxyHealth" in changes) state.proxyHealth = changes.proxyHealth.newValue || {};
    if ("proxyCheck" in changes) state.proxyCheck = changes.proxyCheck.newValue || {};
    if ("proxyExit" in changes) state.proxyExit = changes.proxyExit.newValue || null;
    if ("proxyGeo" in changes) state.proxyGeo = changes.proxyGeo.newValue || {};
    if ("adblockEnabled" in changes) state.adblockEnabled = changes.adblockEnabled.newValue !== false;
    if ("antiAdblockEnabled" in changes) state.antiAdblockEnabled = changes.antiAdblockEnabled.newValue !== false;
    later();
  });

  // Timer ticks every 250ms while recording so the clock stays accurate;
  // full UI refresh is less frequent.
  setInterval(() => {
    const now = Date.now();
    if (state.confirm && now > state.confirm.until) {
      state.confirm = null;
      render();
      return;
    }
    if (state.draft?.recording) renderTimerOnly();
  }, 250);

  setInterval(() => {
    if (state.message && Date.now() > state.message.until) {
      state.message = null;
      renderBanner();
    }
    // Periodic full render to pick up draft updates while popup stays open
    if (state.draft?.recording) renderStage();
  }, 1000);

  (async function init() {
    await loadTheme();
    await loadStats();
    buildSwatches();
    const data = await chrome.storage.local.get({
      uiAccent: "nord", loopsLimit: 1, waitMs: 0,
      recordingDraft: null, routines: [], schedules: [], runStatus: {}, savedPasswords: [],
      proxyList: [], proxyEnabled: false, proxyInterval: 5, proxyUnit: "minutes", proxyIndex: 0, proxyOrigin: "", proxyGlobalMode: false, proxySpeedMode: true, proxySpeedStatus: "",
    proxyHealth: {}, proxyExit: null, proxyGeo: {}, proxyCheck: {},
    cfDnsEnabled: false,
    favouriteApps: [],
    recentApps: [],
    oxylabsEnabled: false, oxylabsHost: "unblock.oxylabs.io", oxylabsPort: 60000, oxylabsUser: "", oxylabsPass: "", oxylabsSession: "", oxylabsGeo: "",
      captchaProvider: "audio", captchaKey: "", captchaUrl: "", captchaWitToken: "", captchaAuto: false, captchaSolveStatus: "",
       captchaAssistEnabled: true, captchaStatus: {},
       tempMailProvider: "tempmaillol", tempMailState: {},
      adblockEnabled: true, antiAdblockEnabled: true
    });
    applyAccent(data.uiAccent);
    $("loops").value = Math.max(0, Math.min(100, Math.floor(Number(data.loopsLimit)) || 0));
    if ($("wait")) $("wait").value = Math.max(0, Math.min(60000, Number(data.waitMs) || 0));
    if ($("darkSwitch")) $("darkSwitch").checked = document.documentElement.getAttribute("data-theme") === "dark";
    state.draft = data.recordingDraft;
    state.routines = data.routines;
    state.schedules = data.schedules;
    state.run = data.runStatus || {};
    state.passwords = data.savedPasswords || [];
    state.proxyList = data.proxyList || [];
    state.proxyEnabled = !!data.proxyEnabled;
    state.proxyInterval = data.proxyInterval ?? 5;
    state.proxyUnit = data.proxyUnit || "minutes";
    state.proxyIndex = data.proxyIndex || 0;
    state.proxyOrigin = data.proxyOrigin || "";
    state.proxyGlobalMode = !!data.proxyGlobalMode;
    state.proxySpeedMode = !!data.proxySpeedMode;
     state.proxySpeedStatus = data.proxySpeedStatus || "";
     state.proxyCheck = data.proxyCheck || {};
     state.proxyHealth = data.proxyHealth || {};
     state.proxyExit = data.proxyExit || null;
     state.proxyGeo = data.proxyGeo || {};
     state.oxylabsEnabled = !!data.oxylabsEnabled; state.oxylabsHost = data.oxylabsHost; state.oxylabsPort = data.oxylabsPort;
     state.oxylabsUser = data.oxylabsUser; state.oxylabsPass = data.oxylabsPass; state.oxylabsSession = data.oxylabsSession; state.oxylabsGeo = data.oxylabsGeo;
     if ($("oxylabsEnabled")) $("oxylabsEnabled").checked = !!data.oxylabsEnabled;
     if ($("oxylabsHost")) $("oxylabsHost").value = data.oxylabsHost || "";
     if ($("oxylabsPort")) $("oxylabsPort").value = data.oxylabsPort || "";
     if ($("oxylabsUser")) $("oxylabsUser").value = data.oxylabsUser || "";
     if ($("oxylabsPass")) $("oxylabsPass").value = data.oxylabsPass || "";
     if ($("oxylabsSession")) $("oxylabsSession").value = data.oxylabsSession || "";
     if ($("oxylabsGeo")) $("oxylabsGeo").value = data.oxylabsGeo || "";
     state.captchaStatus = data.captchaStatus || {};
    // Auto-unblock: if user left Unblock on and still has a list, re-apply (local only)
    if (data.proxyEnabled && data.proxyGlobalMode && (data.proxyList || []).length) {
      state.proxyEnabled = true;
      state.proxyGlobalMode = true;
    }
     state.captchaProvider = data.captchaProvider || "audio";
     state.captchaWitToken = data.captchaWitToken || "";
     state.captchaAuto = !!data.captchaAuto;
     state.captchaSolveStatus = data.captchaSolveStatus || "";
     state.captchaKey = data.captchaKey || "";
     state.captchaUrl = data.captchaUrl || "";
     state.captchaAssistEnabled = data.captchaAssistEnabled !== false;
     state.tempMailProvider = data.tempMailProvider || "tempmaillol";
     applyTempMailState(data.tempMailState || {});
    state.adblockEnabled = data.adblockEnabled !== false;
    state.antiAdblockEnabled = data.antiAdblockEnabled !== false;
    render();
  })();
})();
