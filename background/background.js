try { importScripts("allowlist.js", "captcha-solver.js", "temp-mail.js", "media.js", "automation-policy.js", "proxy-scope.js"); } catch (e) { console.warn("MeMik importScripts", e); }

(function () {
  "use strict";
  const policy = AutomationPolicy;
  // 0 means unlimited (until the user stops). Soft safety ceiling avoids runaway storage.
  const MAX_LOOPS = 0; // no hard cap when caller passes 0
  const LOOPS_SOFT_CAP = 1000000;
  const MAX_ACTIONS = 500;
  const MAX_ROUTINES = 100;
  const MAX_NAME = 80;
   const SCRIPTS = ["background/automation-policy.js", "content/content.js", "content/temp-mail-page.js"];
  let busy = false;

  const get = defaults => chrome.storage.local.get(defaults);
  const set = value => chrome.storage.local.set(value);

  function normalizeRoutine(input, requireId) {
    if (!input || typeof input !== "object") throw new Error("Each routine must be an object.");
    const origin = typeof input.origin === "string" ? input.origin : "";
    if (!policy.recordableUrl(origin + "/")) throw new Error("A routine has an invalid web origin.");
    const parsedOrigin = new URL(origin + "/");
    if (parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) throw new Error("A routine must have a plain web origin.");
    const actions = Array.isArray(input.actions) ? input.actions : [];
    if (!actions.length || actions.length > MAX_ACTIONS || !actions.every(policy.validAction)) throw new Error("A routine contains unsafe or invalid steps.");
    const startUrl = input.startUrl == null ? null : String(input.startUrl);
    if (startUrl && !policy.recordableUrl(startUrl, parsedOrigin.origin)) throw new Error("A routine start page must use the same origin.");
    const id = input.id == null && !requireId ? crypto.randomUUID() : String(input.id || "");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("A routine has an invalid id.");
    if (requireId && (typeof input.name !== "string" || input.name.length > MAX_NAME || !input.name.trim())) throw new Error("A routine has an invalid name.");
    const name = String(input.name || "Untitled routine").trim().slice(0, MAX_NAME) || "Untitled routine";
    return { id, name, origin: parsedOrigin.origin, startUrl: startUrl || null, actions, createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now() };
  }

  // Long waits are chunked and touch an extension API so the worker is not put to sleep mid-run.
  async function sleep(ms) {
    const end = Date.now() + Math.max(0, ms);
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(left, 5000)));
      if (left > 5000) await chrome.runtime.getPlatformInfo();
    }
  }

  /* ---------- toolbar badge ---------- */
  function updateBadge(draft) {
    if (draft && draft.recording) {
      chrome.action.setBadgeBackgroundColor({ color: "#ff4d5e" });
      chrome.action.setBadgeText({ text: "REC" });
    } else chrome.action.setBadgeText({ text: "" });
  }
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.recordingDraft) {
      const prev = changes.recordingDraft.oldValue;
      const next = changes.recordingDraft.newValue;
      updateBadge(next);
      // After stop: open the popup so the user can name/save the routine
      if (prev && prev.recording && next && !next.recording) {
        try {
          if (chrome.action && chrome.action.openPopup) {
            chrome.action.openPopup().catch(() => {});
          }
        } catch (_) {}
      }
    }
  });
  async function onBoot() {
    const data = await get({ schedules: [], runStatus: {}, recordingDraft: null });
    updateBadge(data.recordingDraft);
    if (data.runStatus.running) {
      await set({ runStatus: { running: false, ok: false, message: "A run was interrupted when the browser closed.", finishedAt: Date.now() } });
    }
    for (const s of data.schedules.filter(item => item.active)) {
      if (!(await chrome.alarms.get(`routine:${s.id}`))) {
        await chrome.alarms.create(`routine:${s.id}`, { when: Math.max(Date.now() + 1000, s.when) });
      }
    }
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [910001], addRules: [] });
    } catch (_) {}
    await ensureTempMailAllowRules().catch(() => {});
    await syncAllowRules().catch(() => {});
    await ensureMailOriginRules().catch(e => console.warn("mail origin rules", e));
    await scheduleAdblockAutoUpdate().catch(() => {});
    checkUbolRelease().catch(() => {});
    if (typeof TempMail !== "undefined") TempMail.onBoot().catch(() => {});
    await applyProxySettings().catch(() => {});
    await applyAdblockSettings().catch(() => {});
  }
  chrome.runtime.onInstalled.addListener(onBoot);
  chrome.runtime.onStartup.addListener(onBoot);

  // Prefer side panel so MeMik UI stays open when pages reload after a proxy switch
  try {
    // Use normal toolbar popup (not side panel)
    // The UI is always the normal toolbar popup (manifest default_popup); never a side panel or window.
  } catch (_) {}



  // Closing the recorded tab ends the recording instead of leaving it "on" forever.
  chrome.tabs.onRemoved.addListener(async tabId => {
    const { recordingDraft } = await get({ recordingDraft: null });
    if (recordingDraft?.recording && recordingDraft.tabId === tabId) {
      await set({ recordingDraft: { ...recordingDraft, recording: false, stoppedAt: Date.now(), note: "The recorded tab was closed." } });
    }
  });

  /* ---------- talking to tabs ---------- */
  async function waitForTab(tabId, timeout = 15000) {
    const end = Date.now() + timeout;
    for (;;) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" || Date.now() > end) return tab;
      await sleep(150);
    }
  }

  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPTS });
  }

  async function sendToTab(tabId, message, action) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message);
        if (reply !== undefined) return reply;
        if (action && ["click", "enter", "history"].includes(action.kind)) return { ok: true }; // the page navigated mid-step
      } catch (error) {
        const text = String(error?.message || error);
        if (/message channel closed|port closed/i.test(text) && action && ["click", "enter", "history"].includes(action.kind)) return { ok: true };
        if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw error;
      }
      await waitForTab(tabId);
      try { await inject(tabId); } catch (error) { throw new Error("This page doesn't allow the extension to run on it."); }
      await sleep(200);
    }
    throw new Error("The page didn't respond. Reload it and try again.");
  }

  async function findTab(origin, scheduled) {
    const ok = tab => tab.id && (scheduled ? policy.safeUrl(tab.url) : policy.recordableUrl(tab.url)) && new URL(tab.url).origin === origin;
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && ok(active)) return active;
    return (await chrome.tabs.query({})).find(tab => { try { return ok(tab); } catch (_) { return false; } });
  }

  const stripHash = url => String(url || "").split("#")[0];
  const stopRequested = async () => !!(await get({ runStop: false })).runStop;

  /* ---------- running routines ---------- */
  async function executeRoutine(routine, { loops = 1, delayMs = 0, scheduled = false } = {}) {
    if (busy) return { ok: false, error: "A routine is already running." };
    busy = true;
    let tab = null;
    try {
      if (!routine || !policy.recordableUrl(routine.origin) || !routine.actions?.length || routine.actions.length > MAX_ACTIONS || !routine.actions.every(policy.validAction)) {
        return { ok: false, error: "That routine is empty or unsafe to run." };
      }
      tab = await findTab(routine.origin, scheduled);
      if (!tab && !scheduled && routine.startUrl && policy.recordableUrl(routine.startUrl, routine.origin)) {
        tab = await chrome.tabs.create({ url: routine.startUrl, active: true });
      }
      if (!tab) {
        const error = scheduled ? `Skipped: no open tab for ${routine.origin}.` : `Open ${routine.origin} in a tab first, then run again.`;
        await set({ runStatus: { running: false, ok: false, message: error, finishedAt: Date.now() } });
        return { ok: false, error };
      }
      // 0 = unlimited until Stop is pressed
      let rawLoops = Math.floor(Number(loops));
      if (!Number.isFinite(rawLoops) || rawLoops < 0) rawLoops = 1;
      const unlimited = rawLoops === 0;
      loops = unlimited ? LOOPS_SOFT_CAP : Math.max(1, rawLoops);
      delayMs = Math.max(0, Math.min(60000, Number(delayMs) || 0));
      const steps = routine.actions.length;
      const totalPlanned = unlimited ? 0 : loops * steps;
      await set({ runStop: false });

      outer:
      for (let loop = 1; loop <= loops; loop++) {
        if (await stopRequested()) break;
        if (loop > 1 && !scheduled && routine.startUrl) {
          const now = await chrome.tabs.get(tab.id);
          if (stripHash(now.url) !== stripHash(routine.startUrl) && policy.recordableUrl(routine.startUrl, routine.origin)) await chrome.tabs.update(tab.id, { url: routine.startUrl });
        }
        await waitForTab(tab.id);
        for (let step = 0; step < steps; step++) {
          if (await stopRequested()) break outer;
          const action = routine.actions[step];
          const current = await chrome.tabs.get(tab.id);
          const allowed = scheduled ? policy.safeUrl(current.url, routine.origin) : policy.recordableUrl(current.url, routine.origin);
          if (!allowed) throw new Error("The tab left the recorded site, so the run was stopped.");
          const doneSteps = (loop - 1) * steps + step;
          const percent = unlimited
            ? Math.round(((step + 1) / Math.max(1, steps)) * 100)
            : Math.round(((doneSteps + 1) / Math.max(1, totalPlanned)) * 100);
          const loopLabel = unlimited ? `loop ${loop} · ∞` : `loop ${loop}/${loops}`;
          const text = `${loopLabel} · step ${step + 1}/${steps}`;
          await set({
            runStatus: {
              running: true, routineId: routine.id, name: routine.name,
              loop, loops: unlimited ? 0 : loops, step: step + 1, steps,
              percent, unlimited, message: text
            }
          });
          chrome.tabs.sendMessage(tab.id, {
            type: "runProgress", text, percent, loop, loops: unlimited ? 0 : loops,
            step: step + 1, steps, unlimited, name: routine.name || ""
          }).catch(() => {});
          const result = await sendToTab(tab.id, { type: "replayAction", action, origin: routine.origin }, action);
          if (!result?.ok) throw new Error(result?.error || "A step failed.");
          const next = routine.actions[step + 1];
          const gap = next && action.at && next.at ? Math.min(1500, Math.max(250, next.at - action.at)) : 300;
          await sleep(scheduled ? Math.max(gap, 400) : gap);
          await waitForTab(tab.id);
          const after = await chrome.tabs.get(tab.id);
          const stillAllowed = scheduled ? policy.safeUrl(after.url, routine.origin) : policy.recordableUrl(after.url, routine.origin);
          if (!stillAllowed) throw new Error("History navigation left the recorded site, so the run was stopped.");
        }
        if (loop < loops && !scheduled) await sleep(delayMs);
      }
      const stopped = await stopRequested();
      const message = stopped ? "Run stopped." : "Run complete.";
      await set({ runStop: false, runStatus: { running: false, ok: true, routineId: routine.id, name: routine.name, message, finishedAt: Date.now() } });
      chrome.tabs.sendMessage(tab.id, { type: "routineFinished", text: message }).catch(() => {});
      return { ok: true };
    } catch (error) {
      await set({ runStop: false, runStatus: { running: false, ok: false, routineId: routine?.id, message: error.message, finishedAt: Date.now() } });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "routineFinished", text: "Run stopped: " + error.message }).catch(() => {});
      return { ok: false, error: error.message };
    } finally { busy = false; }
  }

  /* ---------- schedules + proxy rotation (single alarm listener) ---------- */
  const PROXY_ALARM = "proxy-rotate";
  const SPEED_ALARM = "proxy-speed-check";
  const SPEED_PROBE_URL = "https://www.gstatic.com/generate_204";
  const SPEED_SAMPLE = 5;          // max candidates to try on full pick
  const SPEED_TIMEOUT_MS = 4000;   // per probe (free proxies are slow to negotiate TLS)
  const SPEED_RECHECK_MIN = 15;    // minutes between light rechecks
  const SPEED_SLOW_FACTOR = 2.0;   // switch if current is this much slower than best

  // Profiles split by form factor — NEVER cross mobile↔desktop (preserves site layout mode)
  const FP_DESKTOP = [
    {
      form: "desktop",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      platform: "Win32", vendor: "Google Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: false, platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64",
        brands: [{ brand: "Chromium", version: "121" }, { brand: "Google Chrome", version: "121" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "121.0.6167.85" }
    },
    {
      form: "desktop",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      platform: "MacIntel", vendor: "Google Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: false, platform: "macOS", platformVersion: "14.2.0", architecture: "x86", bitness: "64",
        brands: [{ brand: "Chromium", version: "121" }, { brand: "Google Chrome", version: "121" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "121.0.6167.85" }
    },
    {
      form: "desktop",
      ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      platform: "Linux x86_64", vendor: "Google Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: false, platform: "Linux", platformVersion: "6.5.0", architecture: "x86", bitness: "64",
        brands: [{ brand: "Chromium", version: "121" }, { brand: "Google Chrome", version: "121" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "121.0.6167.85" }
    },
    {
      form: "desktop",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      platform: "Win32", vendor: "Google Inc.", language: "en-GB", languages: ["en-GB", "en"],
      uaData: { mobile: false, platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64",
        brands: [{ brand: "Chromium", version: "120" }, { brand: "Microsoft Edge", version: "120" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "120.0.2210.144" }
    }
  ];
  const FP_MOBILE = [
    {
      form: "mobile",
      ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv81", vendor: "Google Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: true, platform: "Android", platformVersion: "13.0.0", architecture: "arm", bitness: "64",
        brands: [{ brand: "Chromium", version: "121" }, { brand: "Google Chrome", version: "121" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "121.0.6167.85" }
    },
    {
      form: "mobile",
      ua: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l", vendor: "Google Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: true, platform: "Android", platformVersion: "14.0.0", architecture: "arm", bitness: "64",
        brands: [{ brand: "Chromium", version: "120" }, { brand: "Google Chrome", version: "120" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "120.0.6099.144" }
    },
    {
      form: "mobile",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121.0.6167.66 Mobile/15E148 Safari/604.1",
      platform: "iPhone", vendor: "Apple Computer, Inc.", language: "en-US", languages: ["en-US", "en"],
      uaData: { mobile: true, platform: "iOS", platformVersion: "17.2.0", architecture: "arm", bitness: "64",
        brands: [{ brand: "Chromium", version: "121" }, { brand: "Google Chrome", version: "121" }, { brand: "Not-A.Brand", version: "99" }],
        uaFullVersion: "121.0.6167.66" }
    }
  ];

  async function resolveFormFactor() {
    const { deviceFormFactor } = await get({ deviceFormFactor: null });
    if (deviceFormFactor === "mobile" || deviceFormFactor === "desktop") return deviceFormFactor;
    let form = "desktop";
    try {
      const info = await chrome.runtime.getPlatformInfo();
      if (info && (info.os === "android" || info.os === "ios")) form = "mobile";
    } catch (_) {}
    await set({ deviceFormFactor: form });
    return form;
  }

  const CF_HOST_RE = /(?:^|\.)(?:challenges\.cloudflare\.com|cloudflare\.com)$/i;
  const CF_PATH_RE = /\/cdn-cgi\/challenge-platform\//i;


  chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name === "adblock-auto-update") {
      const { adblockAutoUpdate } = await get({ adblockAutoUpdate: true });
      if (adblockAutoUpdate) runAdblockFilterUpdate({ manual: false }).catch(() => {});
      return;
    }
    if (typeof TempMail !== "undefined" && alarm.name === TempMail.ALARM) {
      await TempMail.refresh().catch(() => {});
      return;
    }

    if (alarm.name === SPEED_ALARM) {
      await recheckProxySpeed().catch(e => console.warn("speed recheck", e));
      return;
    }
    if (alarm.name === PROXY_ALARM) {
      // Do not switch mid Cloudflare verification (causes endless reload loops)
      if (await anyTabOnCloudflareChallenge()) {
        console.info("Proxy rotate deferred — Cloudflare challenge active");
        // Re-arm short delay so we try again after challenge
        await chrome.alarms.create(PROXY_ALARM, { when: Date.now() + 30_000 });
        return;
      }
      await rotateProxy();
      return;
    }
    if (!alarm.name.startsWith("routine:")) return;
    const id = alarm.name.slice(8);
    const data = await get({ schedules: [], routines: [] });
    const schedule = data.schedules.find(item => item.id === id);
    if (!schedule?.active) return;
    if (schedule.mode !== "clock") schedule.active = false;
    schedule.firedAt = Date.now();
    await set({ schedules: data.schedules });
    const routine = data.routines.find(item => item.id === schedule.routineId);
    const result = routine ? await executeRoutine(routine, { loops: 1, scheduled: true }) : { ok: false, error: "The routine was deleted." };
    const latest = await get({ schedules: [] });
    const entry = latest.schedules.find(item => item.id === id);
    if (entry) { entry.result = result.ok ? "Ran" : result.error; await set({ schedules: latest.schedules }); }
  });

  /* ---------- messages from the popup and pages ---------- */
  const FROM_PAGE = [
    "whoami", "stopRoutine", "tempMailGenerate", "tempMailGetState",
    "tempMailRefresh", "tempMailGetMessage", "tempMailClear"
  , "captchaTranscribe", "captchaSolveFromFrame"];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's own pages may use privileged requests; web pages may only ask who they are or stop a run.
    const fromExtension = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
    if (!fromExtension && !FROM_PAGE.includes(message?.type)) return false;
    (async () => {
      switch (message?.type) {
        case "whoami": return { ok: true, tabId: sender.tab?.id ?? null };

        case "saveRoutine": {
          const routine = normalizeRoutine(message.routine || {}, false);
          const data = await get({ routines: [] });
          await set({ routines: [routine, ...data.routines.filter(item => item.id !== routine.id)].slice(0, MAX_ROUTINES) });
          return { ok: true, routine };
        }

        case "importRoutines": {
          const payload = message.payload;
          if (!payload || payload.version !== 1 || typeof payload.exportedAt !== "string" || !Number.isFinite(Date.parse(payload.exportedAt)) || !Array.isArray(payload.routines)) throw new Error("This file is not a supported routine export.");
          if (JSON.stringify(payload).length > 1024 * 1024) throw new Error("That file is too large (maximum 1 MB).");
          if (payload.routines.length > MAX_ROUTINES) throw new Error(`Import contains more than ${MAX_ROUTINES} routines.`);
          const imported = new Map();
          for (const item of payload.routines) {
            const routine = normalizeRoutine(item, true);
            imported.set(routine.id, routine);
          }
          const data = await get({ routines: [] });
          const merged = new Map(data.routines.map(item => [item.id, item]));
          for (const routine of imported.values()) merged.set(routine.id, routine);
          await set({ routines: [...merged.values()].slice(0, MAX_ROUTINES) });
          return { ok: true, count: imported.size };
        }

        case "runRoutine": {
          if (message.confirmed !== true) throw new Error("Please confirm the run.");
          const routine = (await get({ routines: [] })).routines.find(item => item.id === message.routineId);
          if (!routine) throw new Error("That routine no longer exists.");
          void executeRoutine(routine, { loops: message.loops, delayMs: message.delayMs });
          return { ok: true };
        }

        case "runRecording": {
          if (message.confirmed !== true) throw new Error("Please confirm the run.");
          const rec = message.recording || {};
          const routine = { id: "unsaved", name: "Unsaved recording", origin: rec.origin, startUrl: rec.startUrl || null, actions: rec.actions || [] };
          if (!policy.recordableUrl(`${routine.origin}/`) || !routine.actions.length) throw new Error("This recording is empty.");
          void executeRoutine(routine, { loops: message.loops, delayMs: message.delayMs });
          return { ok: true };
        }

        case "stopRoutine": await set({ runStop: true }); return { ok: true };

        case "captchaSolveActiveTab": {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            if (!tab || tab.id == null) return { ok: false, error: "No active tab" };
            if (!/^https?:/i.test(tab.url || "")) return { ok: false, error: "Open an http(s) page" };
            return await captchaSolveTab(tab);
          } catch (e) {
            await set({ captchaSolveStatus: e.message || String(e) });
            return { ok: false, error: e.message || String(e) };
          }
        }
        case "captchaStatus": {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            if (!tab || tab.id == null || !/^https?:/i.test(tab.url || "")) return { ok: true, list: [], note: "Open a website to look for captchas." };
            const list = summarizeCaptcha(await captchaScan(tab.id));
            if (message.focus && list.length) {
              const fr = await captchaFrames(tab.id);
              for (const f of fr) { const r = await chrome.tabs.sendMessage(tab.id, { type: "captchaFocus" }, { frameId: f.frameId }).catch(() => null); if (r && r.ok) break; }
            }
            return { ok: true, list, url: tab.url };
          } catch (e) { return { ok: false, error: e.message || String(e) }; }
        }
        case "captchaTranscribe": {
          try {
            if (!isRecaptchaFrame(sender.url || "", RC_BFRAME_RE)) return { ok: false, error: "Not a reCAPTCHA challenge frame." };
            const st = await get({ captchaWitToken: "" });
            const bin = atob(String(message.audio || ""));
            if (!bin.length) return { ok: false, error: "The audio clip was empty." };
            const bytes = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
            const text = await CaptchaSolver.transcribeWit(bytes, st.captchaWitToken);
            return { ok: true, text };
          } catch (e) { return { ok: false, error: e.message || String(e) }; }
        }
        case "captchaSolveFromFrame": {
          try {
            if (!isRecaptchaFrame(sender.url || "", RC_BFRAME_RE)) return { ok: false, error: "Not a reCAPTCHA challenge frame." };
            const tabId = sender && sender.tab && sender.tab.id;
            if (tabId == null) return { ok: false, error: "No tab" };
            const r = await solveRecaptchaAudio(tabId, sender.frameId);
            await set({ captchaSolveStatus: "Solved." });
            return { ok: true, ...r };
          } catch (e) {
            await set({ captchaSolveStatus: e.message || String(e) });
            return { ok: false, error: e.message || String(e) };
          }
        }

        case "mediaOpenPopup":
          try { await chrome.action.openPopup(); } catch (_) {}
          return { ok: true };
        case "allowlistGet": {
          const d = await get({ adblockAllow: [] });
          return { ok: true, builtin: MemikAllow.BUILTIN, user: cleanAllowList(d.adblockAllow) };
        }
        case "allowlistAdd": {
          const host = MemikAllow.normalizeHost(message.host);
          if (!host) return { ok: false, error: "That does not look like a website address. Use something like example.com" };
          const d = await get({ adblockAllow: [] });
          const user = cleanAllowList(d.adblockAllow);
          if (MemikAllow.hostMatches(host, MemikAllow.BUILTIN)) return { ok: true, host, user, note: "builtin" };
          if (user.length >= 500) return { ok: false, error: "The allowlist is full (500 sites)." };
          if (!user.includes(host)) user.push(host);
          await set({ adblockAllow: user });
          await syncAllowRules();
          return { ok: true, host, user };
        }
        case "allowlistRemove": {
          const host = MemikAllow.normalizeHost(message.host);
          const d = await get({ adblockAllow: [] });
          const user = cleanAllowList(d.adblockAllow).filter(h => h !== host);
          await set({ adblockAllow: user });
          await syncAllowRules();
          return { ok: true, user };
        }
        case "blockLogClear":
          await set({ blockLog: [] });
          return { ok: true };
        case "blockLogGet": {
          const d = await get({ blockLog: [] });
          return { ok: true, log: Array.isArray(d.blockLog) ? d.blockLog : [] };
        }
        case "mediaDetectActiveTab": {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = tabs[0];
          if (!tab?.id) return { ok: false, error: "No active tab" };
          if (!/^https?:/i.test(tab.url||"")) return { ok: false, error: "Open an http(s) page" };
          return await MeMikMedia.detectInTab(tab.id);
        }
        case "mediaDownload": {
          const url = String(message.url||"");
          return await MeMikMedia.downloadUrl(url, message.filename || MeMikMedia.guessName(url, message.title||""));
        }
        case "mediaPlayerControl": {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = tabs[0];
          if (!tab?.id) return { ok: false, error: "No active tab" };
          try { return await chrome.tabs.sendMessage(tab.id, { type: "mediaPlayerControl", opts: message.opts||{} }); }
          catch(_) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/media-detect.js"] });
            return await chrome.tabs.sendMessage(tab.id, { type: "mediaPlayerControl", opts: message.opts||{} });
          }
        }
        case "tempMailGenerate":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          {
            // No explicit provider => honour the user's saved choice (content-script button relies on this).
            const pick = String(message.provider || "").trim();
            const result = await TempMail.generate(pick);
            return { ...result, email: result.mailbox?.email || "" };
          }
        case "tempMailSetProvider":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          {
            const pick = String(message.provider || "auto").trim() || "auto";
            const st = await TempMail.getState();
            // persist preference without wiping mailbox
            await chrome.storage.local.get({ tempMailState: null }).then(async data => {
              const cur = data.tempMailState || {};
              await chrome.storage.local.set({
                tempMailState: { ...cur, provider: pick },
                tempMailProvider: pick
              });
            });
            return { ok: true, provider: pick };
          }
        case "tempMailGetState":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return TempMail.getState();
        case "tempMailRefresh":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return TempMail.refresh();
        case "tempMailGetMessage":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return TempMail.getMessage(String(message.id || ""));
        case "tempMailDiagnose":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return { ok: true, results: await TempMail.diagnose() };
        case "tempMailCloseReader":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return TempMail.closeReader();
        case "tempMailClear":
          if (typeof TempMail === "undefined") throw new Error("Temporary email is unavailable.");
          return TempMail.clear();

        case "scheduleRoutine": {
          if (message.confirmed !== true) throw new Error("Please confirm the schedule.");
          const data = await get({ schedules: [], routines: [] });
          if (!data.routines.some(item => item.id === message.routineId)) throw new Error("Choose a saved routine first.");
          const valid = message.mode === "delay"
            ? Number.isFinite(Number(message.value)) && Number(message.value) >= 1 && Number(message.value) <= 525600
            : message.mode === "clock" && /^([01]\d|2[0-3]):[0-5]\d$/.test(message.value);
          if (!valid) throw new Error("Enter 1–525600 minutes, or a time like 09:30.");
          let when;
          if (message.mode === "delay") when = Date.now() + Number(message.value) * 60000;
          else {
            const [h, m] = message.value.split(":").map(Number);
            const date = new Date(); date.setHours(h, m, 0, 0);
            if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
            when = date.getTime();
          }
          const schedule = { id: crypto.randomUUID(), routineId: message.routineId, active: true, mode: message.mode, value: String(message.value), when };
          await set({ schedules: [schedule, ...data.schedules] });
          await chrome.alarms.create(`routine:${schedule.id}`, { when, ...(message.mode === "clock" ? { periodInMinutes: 1440 } : {}) });
          return { ok: true, schedule };
        }

        case "cancelSchedule": {
          await chrome.alarms.clear(`routine:${message.id}`);
          const data = await get({ schedules: [] });
          await set({ schedules: data.schedules.filter(item => item.id !== message.id) });
          return { ok: true };
        }

        case "deleteRoutine": {
          const data = await get({ routines: [], schedules: [] });
          await set({ routines: data.routines.filter(item => item.id !== message.id), schedules: data.schedules.filter(item => item.routineId !== message.id) });
          for (const s of data.schedules.filter(item => item.routineId === message.id)) await chrome.alarms.clear(`routine:${s.id}`);
          return { ok: true };
        }

        case "proxySettingsChanged": {
          await applyProxySettings();
          return { ok: true };
        }

        case "proxyProbeList": {
          const result = await probeProxyListSample({ checkAll: !!message.checkAll });
          return { ok: true, result };
        }

        case "proxyConnectWorking": {
          const result = await fastConnectWorkingProxy({ forceFetch: message.forceFetch !== false, timeoutMs: message.timeoutMs, batchSize: message.batchSize });
          return result;
        }
        case "proxyFetchFresh": {
          const result = await fetchFreshProxies();
          return result;
        }
        case "proxyProbeAll": {
          const result = await probeProxyListSample({ checkAll: true });
          return { ok: true, result };
        }

        case "cfDnsChanged": {
          return { ok: false, error: "Cloudflare DNS option removed" };
        }

        case "oxylabsSettingsChanged": {
          await set({
            oxylabsEnabled: !!message.enabled,
            oxylabsHost: String(message.host || "unblock.oxylabs.io").trim(),
            oxylabsPort: Math.max(1, Math.min(65535, Number(message.port) || 60000)),
            oxylabsUser: String(message.user || "").trim(),
            oxylabsPass: String(message.pass || ""),
            oxylabsSession: String(message.session || "").trim(),
            oxylabsGeo: String(message.geo || "").trim()
          });
          await applyProxySettings();
          return { ok: true };
        }

        case "proxyRotateNow": {
          if (await anyTabOnCloudflareChallenge()) {
            return { ok: false, error: "Cloudflare verification in progress — switch deferred." };
          }
          await rotateProxy();
          const st = await get({
            proxyIndex: 0, proxyList: [], proxyInterval: 5, proxyUnit: "minutes",
            proxySpeedStatus: "", proxyStableMode: false
          });
          return {
            ok: true,
            index: st.proxyIndex,
            interval: st.proxyInterval,
            unit: st.proxyUnit,
            stable: !!st.proxyStableMode,
            status: st.proxySpeedStatus || ""
          };
        }

        case "proxySelect": {
          return await selectProxy(message.index);
        }
        case "proxyExitInfo": {
          const info = await refreshExitInfo();
          return { ok: true, info };
        }
        case "proxyGeolocate": {
          await geolocateServers(Math.max(1, Math.min(20, Number(message.limit) || 8)));
          return { ok: true };
        }
        case "proxyDisconnect": {
          // Order matters: clear Chrome's proxy first, THEN record "disconnected", so the UI never claims it early.
          await chrome.alarms.clear(PROXY_ALARM);
          await chrome.proxy.settings.clear({ scope: "regular" });
          await set({ proxyEnabled: false, unblockEnabled: false, proxyGlobalMode: false, oxylabsEnabled: false, proxySpeedStatus: "Disconnected." });
          refreshExitInfo().catch(() => {});
          return { ok: true };
        }
        case "proxyCancel": {
          scanCancel = true;
          return { ok: true };
        }
        case "proxySpeedModeChanged": {
          if (typeof message.enabled === "boolean") await set({ proxySpeedMode: message.enabled });
          const result = await applySpeedMode();
          return { ok: true, result };
        }

        case "proxyPickFastest": {
          const result = await pickFastestProxy({ force: true });
          return { ok: true, result };
        }

        
        case "breachCheckEmail": {
          const email = String(message.email || "").trim().toLowerCase();
          if (!email || !email.includes("@")) return { ok: false, error: "Enter a valid email" };
          try {
            // XposedOrNot — free, returns breach names only (no passwords)
            const res = await fetch(
              "https://api.xposedornot.com/v1/check-email/" + encodeURIComponent(email),
              { cache: "no-store", headers: { Accept: "application/json" } }
            );
            if (res.status === 404) {
              return { ok: true, found: false, breaches: [], message: "No known public breaches for this email." };
            }
            if (!res.ok) {
              // Fallback message
              const text = await res.text().catch(() => "");
              return { ok: false, error: "Lookup failed (" + res.status + "). Try again later." };
            }
            const data = await res.json();
            // shapes: { breached: true/false, breaches: [...] } or { Error: ... }
            let breaches = [];
            if (Array.isArray(data)) breaches = data;
            else if (Array.isArray(data.breaches)) breaches = data.breaches.flat ? data.breaches.flat() : data.breaches;
            else if (data.BreachDetails) breaches = [].concat(data.BreachDetails);
            else if (data.breaches && typeof data.breaches === "object") {
              breaches = Object.keys(data.breaches);
            }
            // normalize to strings
            breaches = breaches.map(b => (typeof b === "string" ? b : (b.name || b.Name || JSON.stringify(b))));
            return {
              ok: true,
              found: breaches.length > 0,
              breaches,
              message: breaches.length
                ? ("Found in " + breaches.length + " breach(es). Change passwords on those sites.")
                : "No known public breaches for this email."
            };
          } catch (e) {
            return { ok: false, error: e.message || String(e) };
          }
        }

        case "pwnedPasswordCheck": {
          const password = String(message.password || "");
          if (!password) return { ok: false, error: "Enter a password" };
          try {
            const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
            const prefix = hash.slice(0, 5);
            const suffix = hash.slice(5);
            const res = await fetch("https://api.pwnedpasswords.com/range/" + prefix, {
              cache: "no-store",
              headers: { "Add-Padding": "true" }
            });
            if (!res.ok) return { ok: false, error: "HIBP request failed" };
            const text = await res.text();
            let count = 0;
            for (const line of text.split("\n")) {
              const [suf, n] = line.trim().split(":");
              if (suf && suf.toUpperCase() === suffix) {
                count = parseInt(n, 10) || 0;
                break;
              }
            }
            return {
              ok: true,
              pwned: count > 0,
              count,
              message: count > 0
                ? ("Seen in breaches " + count.toLocaleString() + " times. Do not use this password.")
                : "Not found in HIBP password list."
            };
          } catch (e) {
            return { ok: false, error: e.message || String(e) };
          }
        }

        case "adblockCheckUpdate": {
          const result = await checkUbolRelease();
          return { ok: !result.error, result };
        }
        case "adblockRunUpdate": {
          const result = await runAdblockFilterUpdate({ manual: true });
          return result;
        }
        case "adblockAutoUpdateChanged": {
          await set({ adblockAutoUpdate: !!message.enabled });
          await scheduleAdblockAutoUpdate();
          return { ok: true };
        }
        case "adblockSettingsChanged": {
          if (typeof message.enabled === "boolean") await set({ adblockEnabled: message.enabled });
          if (typeof message.antiEnabled === "boolean") await set({ antiAdblockEnabled: message.antiEnabled });
          await applyAdblockSettings();
          return { ok: true };
        }

        default: throw new Error("Unsupported request.");
      }
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  /* ---------- proxy rotation helpers ---------- */
  function unitToMs(interval, unit) {
    const n = Math.max(1, Number(interval) || 5);
    if (unit === "seconds") return n * 1000;
    if (unit === "hours") return n * 3600 * 1000;
    return n * 60 * 1000;
  }

  function unitToMinutes(interval, unit) {
    const n = Math.max(1, Number(interval) || 5);
    if (unit === "seconds") return n / 60;
    if (unit === "hours") return n * 60;
    return n;
  }

  /**
   * Parse one proxy line -> { scheme, host, port, user, pass } or null.
   * Accepts: host:port, scheme://host:port, user:pass@host:port, scheme://user:pass@host:port,
   * host:port:user:pass, and [ipv6]:port.
   */
  function parseProxyLine(line) {
    let raw = String(line || "").trim();
    if (!raw) return null;
    let scheme = "http";
    const schemeMatch = raw.match(/^(https?|socks4|socks5h?):\/\//i);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase().replace("socks5h", "socks5");
      raw = raw.slice(schemeMatch[0].length);
    }
    raw = raw.replace(/\/+$/, "");

    let user = "", pass = "";
    const at = raw.lastIndexOf("@");
    if (at !== -1) {
      const cred = raw.slice(0, at);
      raw = raw.slice(at + 1);
      const c = cred.indexOf(":");
      user = c === -1 ? cred : cred.slice(0, c);
      pass = c === -1 ? "" : cred.slice(c + 1);
      try { user = decodeURIComponent(user); pass = decodeURIComponent(pass); } catch (_) {}
    } else if (!raw.startsWith("[")) {
      const parts = raw.split(":");
      if (parts.length >= 4 && /^\d+$/.test(parts[1])) {          // host:port:user:pass
        user = parts[2];
        pass = parts.slice(3).join(":");
        raw = parts[0] + ":" + parts[1];
      }
    }

    let host, portStr;
    if (raw.startsWith("[")) {
      const end = raw.indexOf("]");
      if (end === -1) return null;
      host = raw.slice(1, end);
      portStr = raw.slice(end + 1).replace(/^:/, "");
    } else {
      const colon = raw.lastIndexOf(":");
      if (colon === -1) { host = raw; portStr = ""; }
      else { host = raw.slice(0, colon); portStr = raw.slice(colon + 1); }
    }
    host = (host || "").trim();
    if (!host || /[\s\/]/.test(host)) return null;
    const defaultPort = scheme === "socks5" || scheme === "socks4" ? 1080 : 80;
    const port = portStr ? parseInt(portStr, 10) : defaultPort;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    const out = { scheme, host, port, user, pass };
    // Chrome cannot send credentials to SOCKS proxies at all.
    out.unsupported = !!user && (scheme === "socks5" || scheme === "socks4");
    return out;
  }

  /** Hosts that must never go through the proxy: inbox providers and the geo lookup. */
  function directHosts() {
    const mail = (typeof TempMail !== "undefined" && TempMail.HOSTS) || [];
    return mail.concat(["ipwho.is"]);
  }

  async function applyFingerprint(index) {
    // Device spoofing reverted — no UA / hardware changes
    return null;
  }

    async function anyTabOnCloudflareChallenge() {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        const u = tab.url || "";
        if (!u) continue;
        try {
          const url = new URL(u);
          if (CF_HOST_RE.test(url.hostname) || CF_PATH_RE.test(url.pathname + url.search)) return true;
          // Many sites embed CF challenge in path
          if (url.pathname.includes("/cdn-cgi/challenge-platform/")) return true;
        } catch (_) {}
        // Title heuristic
        if (/just a moment|checking your browser|attention required|cloudflare/i.test(tab.title || "")) return true;
      }
    } catch (_) {}
    return false;
  }


  function proxyKey(parsed) {
    if (!parsed) return "";
    return `${parsed.scheme}://${parsed.host}:${parsed.port}`;
  }

  async function markProxyHealth(index, ok, pingMs) {
    const data = await get({ proxyHealth: {}, proxyList: [] });
    const health = data.proxyHealth || {};
    const line = (data.proxyList || [])[index];
    if (line == null) return;
    health[String(index)] = {
      ok: !!ok,
      ping: ok && pingMs != null ? pingMs : null,
      at: Date.now(),
      line: String(line).slice(0, 120)
    };
    await set({ proxyHealth: health });
  }

  async function nextAvailableIndex(fromIndex, list, health) {
    const n = list.length;
    if (!n) return 0;
    health = health || {};
    for (let step = 1; step <= n; step++) {
      const i = (fromIndex + step) % n;
      const h = health[String(i)];
      if (!h || h.ok !== false) return i; // unknown or available
    }
    return (fromIndex + 1) % n; // all marked bad — still advance
  }

  // Global unblock uses fixed_servers; scoped mode uses a PAC so only one site is proxied.
  // Inbox/geo hosts are always DIRECT. Never clear first: that would leak traffic for a moment.
  async function setProxyConfig(proxy, hostname, globalMode) {
    if (!proxy || (!globalMode && !hostname)) {
      await chrome.proxy.settings.clear({ scope: "regular" });
      return;
    }
    if (globalMode) {
      const scheme = ["socks5", "socks4", "https"].includes(proxy.scheme) ? proxy.scheme : "http";
      await chrome.proxy.settings.set({
        value: {
          mode: "fixed_servers",
          rules: {
            singleProxy: { scheme, host: proxy.host, port: proxy.port },
            bypassList: ["<local>", "localhost", "127.0.0.1", "[::1]"].concat(directHosts())
          }
        },
        scope: "regular"
      });
    } else {
      await chrome.proxy.settings.set({
        value: {
          mode: "pac_script",
          pacScript: { data: ProxyScope.buildPacScript(hostname || "", proxy, false, directHosts()) }
        },
        scope: "regular"
      });
    }
  }

  async function scheduleProxyAlarm(interval, unit) {
    await chrome.alarms.clear(PROXY_ALARM);
    try {
      const st = await get({ proxyStableMode: false });
      if (st.proxyStableMode) return;
    } catch (_) {}

    const ms = unitToMs(interval, unit);
    if (ms < 60_000) {
      await chrome.alarms.create(PROXY_ALARM, { when: Date.now() + ms });
    } else {
      const mins = Math.max(1, unitToMinutes(interval, unit));
      await chrome.alarms.create(PROXY_ALARM, { delayInMinutes: mins, periodInMinutes: mins });
    }
  }

  
  const BLOCK_LOG_KEY = "blockLog";
  const BLOCK_LOG_MAX = 150;

  function classifyBlockedUrl(url) {
    const u = String(url || "").toLowerCase();
    if (/track|analytics|pixel|telemetry|beacon|stats\.|metrics|doubleclick|google-analytics|googletagmanager|facebook\.com\/tr|hotjar|segment\.|mixpanel|amplitude|sentry|clarity\.ms/i.test(u)) {
      return "tracker";
    }
    return "ad";
  }

  async function recordBlock(url, pageHost, rulesetId) {
    try {
      const kind = classifyBlockedUrl(url);
      let host = "";
      let path = url;
      try {
        const u = new URL(url);
        host = u.hostname;
        path = u.pathname + (u.search ? "?…" : "");
      } catch (_) {}
      const data = await get({ [BLOCK_LOG_KEY]: [], statsAds: 0, statsTrackers: 0, statsTotal: 0 });
      const list = Array.isArray(data[BLOCK_LOG_KEY]) ? data[BLOCK_LOG_KEY] : [];
      // de-dupe rapid identical hits
      if (list[0] && list[0].host === host && list[0].path === String(path).slice(0, 120) && (Date.now() - list[0].at) < 1500) {
        return;
      }
      list.unshift({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        at: Date.now(),
        kind,
        host,
        path: String(path).slice(0, 120),
        page: pageHost || "",
        ruleset: rulesetId || ""
      });
      while (list.length > BLOCK_LOG_MAX) list.pop();
      const patch = {
        [BLOCK_LOG_KEY]: list,
        statsTotal: (data.statsTotal || 0) + 1
      };
      if (kind === "tracker") patch.statsTrackers = (data.statsTrackers || 0) + 1;
      else patch.statsAds = (data.statsAds || 0) + 1;
      await set(patch);
    } catch (_) {}
  }

  try {
    if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
        try {
          const req = info.request || {};
          const rule = info.rule || {};
          const url = req.url || "";
          if (!url) return;
          // Page loads only match header-tweaking rules; only malware-site rules really block a main frame.
          if (req.type === "main_frame" && rule.rulesetId !== "security-filters") return;
          let pageHost = "";
          try { pageHost = req.initiator ? new URL(req.initiator).hostname : ""; } catch (_) {}
          recordBlock(url, pageHost, rule.rulesetId || String(rule.ruleId || ""));
        } catch (_) {}
      });
    }
  } catch (e) {
    console.warn("block log listener", e);
  }



/** Quick connect: fetch lists (optional), test servers 8 at a time, connect to the fastest that passes two independent probes. */
async function fastConnectWorkingProxy(options = {}) {
  if (proxyCheckRunning) return { ok: false, error: "A server check is already running. Please wait." };
  proxyCheckRunning = true;
  scanCancel = false;
  try {
    const timeoutMs = Math.max(2000, Math.min(8000, Number(options.timeoutMs) || SPEED_TIMEOUT_MS));
    const maxTry = Math.max(16, Math.min(400, Number(options.maxTry) || 240));
    const fail = async (error, extra) => {
      await set({
        proxyEnabled: false,
        proxyCheck: { running: false, done: (extra && extra.done) || 0, total: (extra && extra.total) || 0, working: 0, dead: (extra && extra.dead) || 0 },
        proxySpeedStatus: error
      });
      try { await setProxyConfig(null); } catch (_) {}
      return { ok: false, error, ...(extra || {}) };
    };

    await set({
      proxyCheck: { running: true, done: 0, total: maxTry, working: 0, dead: 0 },
      proxySpeedStatus: options.forceFetch !== false ? "Fetching live server lists…" : "Looking for a working server…",
      proxySpeedMode: true
    });

    if (options.forceFetch !== false) {
      const fetched = await fetchFreshProxies();
      if (scanCancel) return fail("Cancelled.");
      if (!fetched || fetched.ok === false) return fail((fetched && fetched.error) || "Could not fetch servers");
    }
    const data = await get({ proxyList: [], proxyHealth: {} });
    const list = Array.isArray(data.proxyList) ? data.proxyList.slice() : [];
    if (!list.length) return fail("No servers available. Add some or tap Refresh.");

    // Known-good first (fastest ping), then everything else in list order.
    const health = data.proxyHealth || {};
    const order = list.map((line, i) => ({ line, ping: health[String(i)] && health[String(i)].ok === true ? health[String(i)].ping : null }));
    const good = order.filter(x => x.ping != null).sort((x, y) => x.ping - y.ping);
    const rest = order.filter(x => x.ping == null);
    const toScan = good.concat(rest).slice(0, maxTry).map(x => x.line);

    const BATCH = PROBE_LANES.length;
    let done = 0, dead = 0, winner = null;
    const others = [];                       // other servers that passed the first probe: kept as known-good
    const deadline = Date.now() + 100000;    // stay well inside the service worker lifetime
    for (let off = 0; off < toScan.length && !winner && Date.now() < deadline && !scanCancel; off += BATCH) {
      const chunk = toScan.slice(off, off + BATCH);
      const parsedChunk = chunk.map(parseProxyLine);
      await set({
        proxyCheck: { running: true, done, total: toScan.length, working: others.length, dead },
        proxySpeedStatus: `Testing servers ${off + 1}–${off + chunk.length} of ${toScan.length}…`
      });
      let res;
      try { res = await probeBatch(parsedChunk, timeoutMs, null); } catch (_) { res = chunk.map(() => null); }
      done += chunk.length;
      const passed = [];
      res.forEach((ms, i) => { if (ms != null) passed.push({ line: chunk[i], parsed: parsedChunk[i], ping: ms }); });
      dead += chunk.length - passed.length;
      passed.sort((a, b) => a.ping - b.ping);
      for (const cand of passed) {
        if (scanCancel) break;
        // Second, independent confirmation through the real (global) config before trusting it.
        let ms = null;
        try {
          await setProxyConfig(cand.parsed, "", true);
          const [a, b] = await withAuthCandidates([cand.parsed], async () => {
            const first = await probeLatency(timeoutMs, SPEED_PROBE_URLS[0]);
            return [first, first != null ? await probeLatency(timeoutMs, SPEED_PROBE_URLS[1]) : null];
          });
          if (a != null && b != null) ms = Math.min(a, b);
        } catch (_) { ms = null; }
        if (ms != null) {
          if (!winner) winner = { ...cand, ping: ms }; else others.push({ ...cand, ping: ms });
        } else dead++;
      }
    }

    if (scanCancel) return fail("Cancelled.", { done, total: toScan.length, dead });
    if (!winner) return fail(`No working server found (${dead} tested). Tap Quick connect to try fresh ones.`, { done, total: toScan.length, dead });

    const front = [winner].concat(others);
    const frontLines = new Set(front.map(x => x.line));
    const newList = front.map(x => x.line).concat(list.filter(x => !frontLines.has(x)));
    const newHealth = {};
    front.forEach((x, i) => { newHealth[String(i)] = { ok: true, ping: x.ping, at: Date.now(), line: String(x.line).slice(0, 120) }; });
    await set({
      proxyList: newList,
      proxyIndex: 0,
      proxyEnabled: true,
      proxyGlobalMode: true,
      proxySpeedMode: true,
      proxyHealth: newHealth,
      proxyBestLatency: winner.ping,
      proxyCheck: { running: false, done, total: toScan.length, working: front.length, dead },
      proxySpeedStatus: `Connected · ${winner.ping} ms`
    });
    await setProxyConfig(winner.parsed, "", true);
    await scheduleProxyAlarm(...(await intervalArgs()));
    refreshExitInfo().catch(() => {});
    geolocateServers(8).catch(() => {});
    return { ok: true, working: front.length, ping: winner.ping, checked: done, line: winner.line };
  } finally {
    proxyCheckRunning = false;
  }
}

async function intervalArgs() {
  const st = await get({ proxyInterval: 5, proxyUnit: "minutes" });
  return [st.proxyInterval, st.proxyUnit];
}

/* ---------- exit IP + server geolocation (ipify through the proxy, ipwho.is always direct) ---------- */
async function fetchJsonTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 7000);
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "omit", signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function geoLookup(ip) {
  const d = await fetchJsonTimeout("https://ipwho.is/" + encodeURIComponent(ip), 7000);
  if (!d || d.success === false) throw new Error((d && d.message) || "lookup failed");
  return { cc: String(d.country_code || "").toUpperCase(), country: d.country || "", city: d.city || "", isp: (d.connection && (d.connection.isp || d.connection.org)) || "" };
}

async function refreshExitInfo() {
  const st = await get({ proxyEnabled: false });
  let info;
  try {
    const d = await fetchJsonTimeout("https://api.ipify.org?format=json", 8000);
    const ip = String(d && d.ip || "");
    if (!ip) throw new Error("no ip");
    let geo = {};
    try { geo = await geoLookup(ip); } catch (_) {}
    info = { ip, ...geo, protected: !!st.proxyEnabled, at: Date.now() };
  } catch (e) {
    info = { ip: "", error: "Could not detect IP", protected: !!st.proxyEnabled, at: Date.now() };
  }
  await set({ proxyExit: info });
  return info;
}

async function geolocateServers(limit) {
  const data = await get({ proxyList: [], proxyGeo: {} });
  const geo = data.proxyGeo || {};
  let n = 0;
  for (const line of data.proxyList || []) {
    if (n >= (limit || 8)) break;
    const p = parseProxyLine(line);
    if (!p || geo[p.host] || !/^\d{1,3}(\.\d{1,3}){3}$/.test(p.host)) continue;
    n++;
    try { geo[p.host] = await geoLookup(p.host); } catch (_) { geo[p.host] = { cc: "", country: "" }; }
    await set({ proxyGeo: geo });
  }
}

async function applyProxySettings() {
    const data = await get({
      proxyList: [], proxyEnabled: false, proxyInterval: 5,
      proxyUnit: "minutes", proxyIndex: 0, proxyOrigin: "",
      proxyGlobalMode: false,
      oxylabsEnabled: false, oxylabsHost: "unblock.oxylabs.io", oxylabsPort: 60000,
      oxylabsUser: "", oxylabsPass: "", oxylabsSession: "", oxylabsGeo: ""
    });
    await chrome.alarms.clear(PROXY_ALARM);

    // Oxylabs Web Unblocker mode (commercial anti-bot proxy)
    if (data.oxylabsEnabled && data.oxylabsUser) {
      const host = (data.oxylabsHost || "unblock.oxylabs.io").trim() || "unblock.oxylabs.io";
      const port = Math.max(1, Math.min(65535, Number(data.oxylabsPort) || 60000));
      try {
        await chrome.proxy.settings.clear({ scope: "regular" });
      } catch (_) {}
      await chrome.proxy.settings.set({
        value: {
          mode: "fixed_servers",
          rules: {
            singleProxy: { scheme: "http", host, port },
            bypassList: ["<local>", "localhost", "127.0.0.1", "[::1]"].concat(directHosts())
          }
        },
        scope: "regular"
      });
      // Sticky session + geo headers (Oxylabs Web Unblocker)
      try {
        const headers = [];
        if (data.oxylabsSession) {
          headers.push({ header: "X-Oxylabs-Session-Id", operation: "set", value: data.oxylabsSession });
        }
        if (data.oxylabsGeo) {
          headers.push({ header: "x-oxylabs-geo-location", operation: "set", value: data.oxylabsGeo });
        }
        // Optional render assist for tough sites
        headers.push({ header: "X-Oxylabs-Render", operation: "set", value: "html" });
        if (headers.length) {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [920001],
            addRules: [{
              id: 920001,
              priority: 90,
              action: { type: "modifyHeaders", requestHeaders: headers },
              condition: {
                urlFilter: "*",
                resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "other"]
              }
            }]
          });
        }
      } catch (e) {
        console.warn("oxylabs headers", e);
      }
      await set({
        proxyEnabled: true,
        proxyGlobalMode: true,
        proxySpeedStatus: `Premium proxy · ${host}:${port}`
      });
      refreshExitInfo().catch(() => {});
      return;
    }

    // Clear oxylabs header rule when not in use
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [920001], addRules: [] });
    } catch (_) {}

    const globalMode = !!data.proxyGlobalMode;
    const hostname = ProxyScope.hostnameOf(data.proxyOrigin);
    if (!data.proxyEnabled || !Array.isArray(data.proxyList) || !data.proxyList.length) {
      await setProxyConfig(null);
      refreshExitInfo().catch(() => {});
      return;
    }
    if (!globalMode && !hostname) {
      await setProxyConfig(null);
      await set({ proxyEnabled: false });
      return;
    }

    const idx = Math.max(0, Number(data.proxyIndex) || 0) % data.proxyList.length;
    const parsed = parseProxyLine(data.proxyList[idx]);
    if (parsed) {
      try {
        await setProxyConfig(parsed, hostname, globalMode);
        await applyFingerprint(idx);
        await set({
          proxySpeedStatus: parsed.unsupported
            ? "Chrome cannot send a username/password to a SOCKS proxy. Use an HTTP/HTTPS proxy."
            : `Connected · ${parsed.host}:${parsed.port} (#${idx + 1} of ${data.proxyList.length})`
        });
        refreshExitInfo().catch(() => {});
      } catch (e) {
        console.warn("proxy set failed", e);
        await set({ proxySpeedStatus: "Proxy apply failed: " + (e.message || e) });
      }
    }
    await scheduleProxyAlarm(data.proxyInterval, data.proxyUnit);
  }

  async function rotateProxy() {
    if (!proxyCheckRunning) scanCancel = false;       // a stale Cancel must not abort a fresh switch
    const data = await get({
      proxyList: [], proxyEnabled: false, proxyInterval: 5,
      proxyUnit: "minutes", proxyIndex: 0, proxyOrigin: "",
      proxyGlobalMode: false
    });
    const globalMode = !!data.proxyGlobalMode;
    const hostname = ProxyScope.hostnameOf(data.proxyOrigin);
    if (!data.proxyEnabled || !data.proxyList.length || (!globalMode && !hostname)) {
      await chrome.alarms.clear(PROXY_ALARM);
      await setProxyConfig(null);
      return;
    }
    const list = data.proxyList;
    const cur = Math.max(0, Number(data.proxyIndex) || 0) % list.length;
    const health = (await get({ proxyHealth: {} })).proxyHealth || {};
    const curParsed = parseProxyLine(list[cur]);
    await set({ proxySpeedStatus: "Switching server…" });

    // Next candidates after the current one, previously-good ones first. Tested 8 at a time.
    const cands = [];
    for (let n = 1; n <= list.length && cands.length < 24; n++) {
      const i = (cur + n) % list.length;
      if (i === cur && list.length > 1) continue;
      if (health[String(i)] && health[String(i)].ok === false && Date.now() - (health[String(i)].at || 0) < 10 * 60 * 1000) continue;
      cands.push(i);
    }
    cands.sort((a, b) => ((health[String(b)] && health[String(b)].ok === true) ? 1 : 0) - ((health[String(a)] && health[String(a)].ok === true) ? 1 : 0));
    let chosen = null;
    for (let off = 0; off < cands.length && !chosen && !scanCancel; off += PROBE_LANES.length) {
      const idxs = cands.slice(off, off + PROBE_LANES.length);
      const parsedList = idxs.map(i => parseProxyLine(list[i]));
      let res;
      try { res = await probeBatch(parsedList, SPEED_TIMEOUT_MS, curParsed); } catch (_) { res = idxs.map(() => null); }
      for (let n = 0; n < idxs.length; n++) await markProxyHealth(idxs[n], res[n] != null, res[n]);
      let best = -1;
      res.forEach((ms, n) => { if (ms != null && (best === -1 || ms < res[best])) best = n; });
      if (best !== -1) chosen = { idx: idxs[best], parsed: parsedList[best], ms: res[best] };
    }
    if (chosen) {
      try {
        await setProxyConfig(chosen.parsed, hostname, globalMode);
        await set({
          proxyIndex: chosen.idx,
          proxyBestLatency: chosen.ms,
          proxySpeedStatus: `Connected · ${chosen.parsed.host}:${chosen.parsed.port} · ${chosen.ms} ms`
        });
        refreshExitInfo().catch(() => {});
      } catch (e) {
        console.warn("proxy rotate failed", e);
        await set({ proxySpeedStatus: "Proxy switch failed: " + (e.message || e) });
      }
    } else {
      // Nothing answered: go back to the server we were on rather than leaving a dead one active.
      if (curParsed) { try { await setProxyConfig(curParsed, hostname, globalMode); } catch (_) {} }
      await set({ proxySpeedStatus: "No other working server found. Staying on the current one." });
      // The list may simply be stale: pull fresh servers once in the background.
      if (!proxyCheckRunning && !refetching) {
        refetching = true;
        fastConnectWorkingProxy({ forceFetch: true }).finally(() => { refetching = false; });
      }
    }
    // Restart timer duration after every manual/auto switch (unless Stable Proxy)
    await scheduleProxyAlarm(data.proxyInterval, data.proxyUnit);
  }

  /** Connect to one specific server (tapped in the list). */
  async function selectProxy(index) {
    if (!proxyCheckRunning) scanCancel = false;
    const data = await get({ proxyList: [], proxyOrigin: "", proxyGlobalMode: true, proxyInterval: 5, proxyUnit: "minutes" });
    const list = data.proxyList || [];
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { ok: false, error: "That server no longer exists." };
    const parsed = parseProxyLine(list[idx]);
    if (!parsed) return { ok: false, error: "That server line is not valid." };
    if (parsed.unsupported) {
      await markProxyHealth(idx, false, null);
      await set({ proxySpeedStatus: "Chrome cannot send a username/password to a SOCKS proxy. Use an HTTP/HTTPS proxy." });
      return { ok: false, error: "Chrome cannot use a username/password with a SOCKS proxy. Use an HTTP/HTTPS proxy." };
    }
    const globalMode = data.proxyGlobalMode !== false;
    const hostname = ProxyScope.hostnameOf(data.proxyOrigin);
    await set({ proxySpeedStatus: `Connecting to ${String(parsed.host).slice(0, 40)}…` });
    const ms = await measureProxyLatency(parsed, hostname, globalMode);
    await markProxyHealth(idx, ms != null, ms);
    if (ms == null) {
      const st = await get({ proxyEnabled: false, proxyIndex: 0 });
      const back = parseProxyLine(list[Math.max(0, st.proxyIndex) % list.length]);
      if (st.proxyEnabled && back) { try { await setProxyConfig(back, hostname, globalMode); } catch (_) {} } else { try { await setProxyConfig(null); } catch (_) {} }
      await set({ proxySpeedStatus: `${String(parsed.host).slice(0, 40)} did not respond.` });
      return { ok: false, error: "That server did not respond." };
    }
    await setProxyConfig(parsed, hostname, globalMode);
    await set({
      proxyEnabled: true, proxyGlobalMode: globalMode || true, proxyIndex: idx, proxyBestLatency: ms,
      proxySpeedStatus: `Connected · ${parsed.host}:${parsed.port} · ${ms} ms`
    });
    await scheduleProxyAlarm(data.proxyInterval, data.proxyUnit);
    refreshExitInfo().catch(() => {});
    return { ok: true, ping: ms, index: idx };
  }

  /* ---------- Adblock filter updates ---------- */
  // The GitHub releases API is rate-limited and can return 403 to extensions.
  // Updates therefore use the filter files directly, with CDN fallbacks.
  const FILTER_SOURCES = [
    {
      id: "easylist",
      urls: [
        "https://easylist.to/easylist/easylist.txt",
        "https://cdn.jsdelivr.net/gh/easylist/easylist@master/easylist/easylist.txt",
        "https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist.txt"
      ]
    },
    {
      id: "easyprivacy",
      urls: [
        "https://easylist.to/easylist/easyprivacy.txt",
        "https://cdn.jsdelivr.net/gh/easylist/easylist@master/easylist/easyprivacy.txt",
        "https://raw.githubusercontent.com/easylist/easylist/master/easyprivacy/easyprivacy.txt"
      ]
    },
    {
      id: "ublock-filters",
      urls: [
        "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/filters.txt",
        "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"
      ]
    },
    {
      id: "ublock-privacy",
      urls: [
        "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/privacy.txt",
        "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"
      ]
    }
  ];
  const AD_UPDATE_ALARM = "adblock-auto-update";
  const DYN_RULE_START = 200000;
  const DYN_RULE_MAX = 4500; // stay under Chrome dynamic rule limit
  const DYN_BANK_SIZE = DYN_RULE_MAX;
  const DYN_BANK_STARTS = [DYN_RULE_START, DYN_RULE_START + DYN_BANK_SIZE + 500];
  let adblockUpdateRunning = false;

  async function sha256(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function fetchFilterSource(source) {
    let lastError = null;
    for (const url of source.urls) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Accept: "text/plain, */*" }
        });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        const text = await response.text();
        if (text.trim().length < 64) {
          lastError = new Error("empty filter response");
          continue;
        }
        return { text, url, hash: await sha256(text) };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`${source.id}: ${lastError?.message || "all sources failed"}`);
  }

  async function loadFilterSources() {
    const loaded = [];
    const errors = [];
    for (const source of FILTER_SOURCES) {
      try {
        loaded.push({ ...source, ...(await fetchFilterSource(source)) });
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }
    return { loaded, errors };
  }

  async function checkUbolRelease() {
    const { loaded, errors } = await loadFilterSources();
    const previous = await get({ adblockSourceHashes: {} });
    const hashes = Object.fromEntries(loaded.map(source => [source.id, source.hash]));
    const changed = loaded.length > 0 && loaded.some(source => previous.adblockSourceHashes?.[source.id] !== source.hash);
    const tag = loaded.length
      ? `sources-${(await sha256(Object.values(hashes).sort().join("|"))).slice(0, 12)}`
      : "";
    await set({
      adblockRemoteVersion: tag,
      adblockRemotePublished: new Date().toISOString(),
      adblockUpdateAvailable: !!changed,
      adblockSourceStatus: errors.length ? errors.join(" · ") : `Ready · ${loaded.length}/${FILTER_SOURCES.length} sources`
    });
    if (!loaded.length) return { error: errors.join(" · ") || "No filter sources available." };
    const local = (await get({ adblockListVersion: "bundled" })).adblockListVersion || "bundled";
    return { tag, local, available: changed, sources: loaded.length, errors };
  }

  function parseFilterHosts(text) {
    const hosts = new Set();
    const lines = String(text || "").split(/\r?\n/);
    for (const raw of lines) {
      let line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) continue;
      if (line.startsWith("@@")) continue; // exception — skip for dynamic block set
      // ||domain^ or ||domain^$third-party
      let m = line.match(/^\|\|([a-z0-9._-]+)\^/i);
      if (m) {
        const h = m[1].toLowerCase();
        if (h.includes(".") && !h.startsWith(".")) hosts.add(h);
        continue;
      }
      // 0.0.0.0 domain / 127.0.0.1 domain
      m = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9._-]+)/i);
      if (m) {
        const h = m[1].toLowerCase();
        if (h.includes(".")) hosts.add(h);
      }
    }
    return hosts;
  }

  async function removeDynamicBank(start) {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const end = start + DYN_BANK_SIZE;
    const ids = existing
      .map(rule => Number(rule.id))
      .filter(id => id >= start && id < end);
    if (!ids.length) return;
    const chunk = 500;
    for (let i = 0; i < ids.length; i += chunk) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids.slice(i, i + chunk) });
    }
  }

  async function applyDynamicHostBlocks(hosts) {
    const list = [...hosts].slice(0, DYN_RULE_MAX);
    const stored = await get({ adblockDynamicBank: 0 });
    const activeBank = Number(stored.adblockDynamicBank) === 1 ? 1 : 0;
    const targetBank = activeBank === 0 ? 1 : 0;
    const targetStart = DYN_BANK_STARTS[targetBank];
    const oldStart = DYN_BANK_STARTS[activeBank];
    const addRules = list.map((host, i) => ({
      id: targetStart + i,
      priority: 80,
      action: { type: "block" },
      condition: {
        requestDomains: [host],
        resourceTypes: [
          "script", "image", "xmlhttprequest", "sub_frame", "media",
          "websocket", "ping", "font", "other"
        ]
      }
    }));
    // Build the replacement bank while the current bank stays active.
    const chunk = 500;
    await removeDynamicBank(targetStart);
    try {
      for (let i = 0; i < addRules.length; i += chunk) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: addRules.slice(i, i + chunk)
        });
      }
    } catch (error) {
      try { await removeDynamicBank(targetStart); } catch (_) {}
      throw error;
    }
    await removeDynamicBank(oldStart);
    await set({ adblockDynamicBank: targetBank });
    return list.length;
  }

  async function runAdblockFilterUpdate({ manual } = {}) {
    if (adblockUpdateRunning) return { ok: false, error: "An adblock update is already running." };
    adblockUpdateRunning = true;
    try {
      await set({ adblockUpdateStatus: manual ? "Updating…" : "Auto-updating…" });
      const { loaded, errors } = await loadFilterSources();
      const allHosts = new Set();
      for (const src of loaded) for (const h of parseFilterHosts(src.text)) allHosts.add(h);
      // Never replace a known-good dynamic ruleset with an empty one because
      // a CDN/GitHub request failed or returned unusable data.
      if (!loaded.length || !allHosts.size) {
        const message = `Update skipped · no usable filter sources (${loaded.length}/${FILTER_SOURCES.length})`;
        await set({ adblockUpdateStatus: message, adblockLastAttempted: Date.now() });
        return { ok: false, error: message };
      }
      const count = await applyDynamicHostBlocks(allHosts);
      const hashes = Object.fromEntries(loaded.map(source => [source.id, source.hash]));
      const ver = `sources-${(await sha256(Object.values(hashes).sort().join("|"))).slice(0, 12)}`;
      await set({
        adblockListVersion: ver,
        adblockUpdateAvailable: false,
        adblockLastUpdated: Date.now(),
        adblockUpdateStatus: `Updated to ${ver} · ${count} host rules`,
        adblockHostRuleCount: count,
        adblockLastAttempted: Date.now(),
        adblockLastSuccessful: Date.now(),
        adblockSourceCount: loaded.length,
        adblockSourceHashes: hashes,
        adblockSourceStatus: errors.length ? errors.join(" · ") : `Ready · ${loaded.length}/${FILTER_SOURCES.length} sources`
      });
      return { ok: true, version: ver, count };
    } catch (e) {
      await set({ adblockUpdateStatus: "Update failed: " + (e.message || e) });
      return { ok: false, error: e.message || String(e) };
    } finally {
      adblockUpdateRunning = false;
    }
  }

  async function scheduleAdblockAutoUpdate() {
    await chrome.alarms.clear(AD_UPDATE_ALARM);
    const { adblockAutoUpdate } = await get({ adblockAutoUpdate: true });
    if (!adblockAutoUpdate) return;
    // Refresh hourly so newly published ad domains are picked up promptly.
    await chrome.alarms.create(AD_UPDATE_ALARM, { periodInMinutes: 60 });
  }

  /* ---------- adblock + anti-adblock (declarativeNetRequest) ---------- */
  const ADBLOCK_RULESETS = [
    "extra-trackers", "easylist", "easyprivacy", "community-filters", "security-filters", "pgl",
    "annoyances-overlays", "annoyances-others", "annoyances-notifications", "extra-ads",
    "superadblock-hosts"
  ];
  const ANTI_ADBLOCK_RULESETS = ["anti-adblock"];


  /* ---------- blocked ads / trackers counter ---------- */
  const TRACKER_RULESETS = new Set(["easyprivacy", "pgl", "security-filters", "extra-trackers"]);
  const TRACKER_URL_RE = /analytic|track|telemetry|metric|pixel|beacon|collect|hotjar|clarity|sentry|bugsnag|newrelic|nr-data|segment|mixpanel|amplitude|heap|fullstory|mouseflow|scorecard|quantserve|quantcast|statcounter|chartbeat|facebook\.net|connect\.facebook|snap\.licdn|googletagmanager|datadog|logrocket|crazyegg|luckyorange|optimizely|comscore|demdex|krxd|bluekai|crwdcntrl|rlcdn|criteo\.net|stats\./i;
  let pendingStats = { ads: 0, trackers: 0 };
  let flushTimer = null;
  const tabCounts = new Map();

  function bumpBadge(tabId) {
    if (tabId == null || tabId < 0) return;
    const n = (tabCounts.get(tabId) || 0) + 1;
    tabCounts.set(tabId, n);
    try {
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#2fa36b" });
      chrome.action.setBadgeText({ tabId, text: n > 999 ? "999+" : String(n) });
    } catch (_) {}
  }
  async function flushStats() {
    flushTimer = null;
    const add = pendingStats; pendingStats = { ads: 0, trackers: 0 };
    if (!add.ads && !add.trackers) return;
    const d = await get({ blockStats: { ads: 0, trackers: 0, since: Date.now() } });
    const cur = d.blockStats || { ads: 0, trackers: 0, since: Date.now() };
    await set({ blockStats: { ads: (cur.ads || 0) + add.ads, trackers: (cur.trackers || 0) + add.trackers, since: cur.since || Date.now() } });
  }
  try {
    if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
        const rs = info && info.rule && info.rule.rulesetId;
        if (!rs || rs === "cloudflare-allow") return;
        if (info.rule.ruleId >= 900000 && rs === "cloudflare-allow") return;
        const u = (info.request && info.request.url) || "";
        if (TRACKER_RULESETS.has(rs) || TRACKER_URL_RE.test(u)) pendingStats.trackers++; else pendingStats.ads++;
        bumpBadge(info.request && info.request.tabId);
        if (!flushTimer) flushTimer = setTimeout(flushStats, 1500);
      });
    }
    chrome.tabs.onUpdated.addListener((tabId, ch) => { if (ch.status === "loading" && ch.url !== undefined) { tabCounts.delete(tabId); try { chrome.action.setBadgeText({ tabId, text: "" }); } catch (_) {} } });
    chrome.tabs.onRemoved.addListener(tabId => tabCounts.delete(tabId));
  } catch (e) { console.warn("block counter unavailable", e); }

  async function applyAdblockSettings() {
    const data = await get({ adblockEnabled: true });
    const adOn = data.adblockEnabled !== false;
    const antiOn = adOn; // always on with adblock — not a separate option
    await set({ antiAdblockEnabled: antiOn });
    const enable = ["cloudflare-allow"]; // never block CF challenges
    const disable = [];
    for (const id of ADBLOCK_RULESETS) (adOn ? enable : disable).push(id);
    for (const id of ANTI_ADBLOCK_RULESETS) (antiOn ? enable : disable).push(id);
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enable,
        disableRulesetIds: disable
      });
    } catch (e) {
      console.warn("adblock ruleset update failed", e);
    }
  }




  /* ---------- Lightweight proxy speed picker ---------- */
  // Probes a small sample only; sticks with winner until it slows/fails.
  // Does not hammer the browser: few timed fetches, long interval between rechecks.

  const SPEED_PROBE_URLS = [
    "https://www.gstatic.com/generate_204",
    "https://clients3.google.com/generate_204"
  ];

  // Resolves with round-trip ms only when the probe URL answers exactly like the real server (HTTP 204).
  // Anything else (captive page, hijack, TLS failure, timeout) counts as a dead proxy.
  function probeLatency(msLimit, url) {
    return new Promise(resolve => {
      const ctrl = new AbortController();
      const t0 = performance.now();
      const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, msLimit);
      fetch(url || SPEED_PROBE_URL, {
        method: "GET", cache: "no-store", credentials: "omit", signal: ctrl.signal, redirect: "manual"
      }).then(res => {
        clearTimeout(timer);
        resolve(res && res.status === 204 ? Math.max(1, Math.round(performance.now() - t0)) : null);
      }).catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // Always tests THROUGH the candidate proxy (a scoped PAC would send the probe DIRECT and
  // report every dead proxy as working), then restores the real scoped config.
  async function measureProxyLatency(parsed, hostname, globalMode) {
    try {
      if (!parsed || parsed.unsupported) return null;
      await setProxyConfig(parsed, "", true);
      const ms = await withAuthCandidates([parsed], () => probeLatency(SPEED_TIMEOUT_MS));
      if (!globalMode) await setProxyConfig(parsed, hostname || "", false);
      return ms;
    } catch (_) {
      return null;
    }
  }

  let proxyCheckRunning = false;
  let scanCancel = false;
  let refetching = false;

  // Probe hostnames that all answer HTTP 204 over HTTPS. Each one is routed through a different candidate
  // proxy by a PAC script, so a whole batch is tested in parallel instead of one server at a time.
  const PROBE_LANES = [
    "www.gstatic.com", "connectivitycheck.gstatic.com", "www.google.com", "clients1.google.com",
    "clients2.google.com", "clients3.google.com", "clients4.google.com", "clients5.google.com"
  ];

  /** Tests up to PROBE_LANES.length proxies at once. Returns ms (or null) per input. `keep` stays in use for other traffic. */
  async function probeBatch(parsedList, timeoutMs, keep) {
    const lanes = parsedList.slice(0, PROBE_LANES.length);
    const map = {};
    lanes.forEach((p, i) => { if (p && !p.unsupported) map[PROBE_LANES[i]] = ProxyScope.directiveFor(p); });
    if (!Object.keys(map).length) return lanes.map(() => null);
    const pac = ProxyScope.buildLanePac(map, keep && !keep.unsupported ? ProxyScope.directiveFor(keep) : "DIRECT", directHosts());
    await chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: pac } }, scope: "regular" });
    const stamp = Date.now();
    return withAuthCandidates(lanes.concat(keep ? [keep] : []), () => Promise.all(lanes.map((p, i) => map[PROBE_LANES[i]]
      ? probeLatency(timeoutMs, `https://${PROBE_LANES[i]}/generate_204?m=${stamp}${i}`)
      : Promise.resolve(null))));
  }


  // Best of several probes = the proxy's real round-trip ping.
  async function measurePing(parsed, tries) {
    let best = null;
    for (let k = 0; k < tries; k++) {
      const ms = await probeLatency(3500);
      if (ms != null && (best == null || ms < best)) best = ms;
      if (ms == null && k === 0) break; // dead on first probe: do not waste time
    }
    return best;
  }

  
  // Public lists that are re-published every few minutes to every hour. Unreachable ones are simply skipped.
  const PROXY_SOURCES = [
    { u: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/socks5/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", s: "http" },
    { u: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt", s: "socks5" },
    { u: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", s: "http" },
    { u: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=6000", s: "http" },
    { u: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text&timeout=6000", s: "socks5" },
    { u: "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=6000&country=all&ssl=all&anonymity=all", s: "http" },
    { u: "https://www.proxy-list.download/api/v1/get?type=https", s: "http" },
    { u: "https://www.proxy-list.download/api/v1/get?type=socks5", s: "socks5" },
    { u: "https://openproxylist.xyz/http.txt", s: "http" },
    { u: "https://openproxylist.xyz/socks5.txt", s: "socks5" },
    { u: "https://spys.me/proxy.txt", s: "http" },
    { u: "https://proxylist.geonode.com/api/proxy-list?limit=300&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps%2Csocks5&speed=fast", s: "http", f: "geonode" },
    { u: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt", s: "http" },
    { u: "https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt", s: "http" }
  ];
  const PER_SOURCE_SAMPLE = 300;     // random sample per source, so repeated refreshes try different servers
  const POOL_CAP = 1500;

  let allowLocalProxies = false;   // internal switch (storage key proxyAllowLocal), used only by automated tests
  function validPublicIpv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return false;
    if (allowLocalProxies) return true;
    if (o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    return true;
  }

  function extractProxyLines(text, scheme) {
    const out = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const token = raw.trim().split(/\s+/)[0];
      if (!token || token[0] === "#") continue;
      const m = /^(?:([a-z0-9]+):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/i.exec(token);
      if (!m) continue;
      const port = Number(m[3]);
      if (port < 1 || port > 65535 || !validPublicIpv4(m[2])) continue;
      let sch = (m[1] || scheme).toLowerCase().replace("socks5h", "socks5");
      if (!/^(http|https|socks4|socks5)$/.test(sch)) sch = scheme;
      out.push(`${sch}://${m[2]}:${port}`);
    }
    return out;
  }

  function extractGeonode(json) {
    const out = [];
    for (const p of (json && json.data) || []) {
      const protos = (p.protocols || []).map(String);
      const sch = protos.includes("socks5") ? "socks5" : (protos.includes("https") || protos.includes("http")) ? "http" : "";
      if (!sch || !p.ip || !p.port || !validPublicIpv4(p.ip)) continue;
      out.push(`${sch}://${p.ip}:${p.port}`);
    }
    return out;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  async function fetchFreshProxies() {
    // Fetched with no proxy active, otherwise a dead proxy would block the list download.
    const prev = await get({ proxyList: [], proxyHealth: {}, proxyEnabled: false, proxyAllowLocal: false });
    allowLocalProxies = prev.proxyAllowLocal === true;
    if (prev.proxyEnabled) { try { await chrome.proxy.settings.clear({ scope: "regular" }); } catch (_) {} }

    const seen = new Set();
    const keep = [];
    // Keep the user's own proxies (anything with credentials) and previously verified ones at the front.
    (prev.proxyList || []).forEach((line, i) => {
      const parsed = parseProxyLine(line);
      if (!parsed) return;
      const h = (prev.proxyHealth || {})[String(i)];
      if (parsed.user || (h && h.ok === true)) {
        const key = proxyKey(parsed);
        if (!seen.has(key)) { seen.add(key); keep.push(line); }
      }
    });

    let reachable = 0;
    const buckets = await Promise.all(PROXY_SOURCES.map(async src => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(src.u, { cache: "no-store", credentials: "omit", signal: ctrl.signal });
        if (!res.ok) return [];
        let lines;
        if (src.f === "geonode") lines = extractGeonode(await res.json());
        else lines = extractProxyLines((await res.text()).slice(0, 4 * 1024 * 1024), src.s);
        if (lines.length) reachable++;
        return shuffle(lines).slice(0, PER_SOURCE_SAMPLE);
      } catch (_) {
        return [];
      } finally {
        clearTimeout(timer);
      }
    }));

    // Round-robin across sources so one huge list cannot crowd out the others.
    const list = keep.slice();
    for (let i = 0; i < PER_SOURCE_SAMPLE && list.length < POOL_CAP; i++) {
      for (const b of buckets) {
        if (i >= b.length) continue;
        const parsed = parseProxyLine(b[i]);
        if (!parsed) continue;
        const key = proxyKey(parsed);
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(b[i]);
        if (list.length >= POOL_CAP) break;
      }
    }
    if (!list.length) return { ok: false, error: "Could not download any server list. Check your internet connection." };
    await set({
      proxyList: list,
      proxyIndex: 0,
      proxyHealth: {},
      proxyCheck: { running: false, done: 0, total: list.length, working: 0, dead: 0 },
      proxySpeedStatus: `Fetched ${list.length} servers from ${reachable} live sources — testing…`
    });
    return { ok: true, count: list.length, sources: reachable };
  }

async function probeProxyListSample(options = {}) {
    const checkAll = !!options.checkAll;
    if (proxyCheckRunning) return { checked: 0, kept: 0, busy: true };
    proxyCheckRunning = true;
    scanCancel = false;
    try {
      const data = await get({
        proxyList: [], proxyEnabled: false, proxyGlobalMode: true, proxyOrigin: "", proxyIndex: 0, proxyHealth: {}
      });
      let list = Array.isArray(data.proxyList) ? data.proxyList.slice() : [];
      if (!list.length) return { checked: 0, kept: 0 };
      const curIdx = Math.max(0, Number(data.proxyIndex) || 0) % list.length;
      const connectedLine = data.proxyEnabled ? list[curIdx] : null;
      const keep = connectedLine ? parseProxyLine(connectedLine) : null;   // keeps carrying the user's traffic during the test
      const max = checkAll ? Math.min(list.length, 200) : Math.min(8, list.length);
      const start = checkAll ? 0 : curIdx;
      const health = checkAll ? {} : { ...(data.proxyHealth || {}) };
      const okIndexes = [];
      let working = 0, dead = 0, done = 0;

      const publish = async () => {
        await set({
          proxyHealth: health,
          proxyCheck: { running: true, current: -1, done, total: max, working, dead },
          proxySpeedStatus: `Checking ${done}/${max} · ${working} working · ${dead} dead`
        });
      };
      await publish();

      const BATCH = PROBE_LANES.length;
      const deadline = Date.now() + 110000;
      for (let off = 0; off < max && Date.now() < deadline && !scanCancel; off += BATCH) {
        const idxs = [];
        for (let k = off; k < Math.min(max, off + BATCH); k++) idxs.push(checkAll ? k : (start + k) % list.length);
        const parsed = idxs.map(i => parseProxyLine(list[i]));
        let res;
        try { res = await probeBatch(parsed, SPEED_TIMEOUT_MS, keep); } catch (_) { res = idxs.map(() => null); }
        idxs.forEach((i, n) => {
          const ok = res[n] != null;
          health[String(i)] = { ok, ping: ok ? res[n] : null, at: Date.now(), line: String(list[i]).slice(0, 120) };
          if (ok) { okIndexes.push(i); working++; } else dead++;
        });
        done += idxs.length;
        await publish();
      }
      const tested = done;

      if (checkAll) {
        // Keep working servers, fastest first. Dead ones are removed. Untested ones stay at the end.
        const ranked = okIndexes.map(i => ({ line: list[i], ping: health[String(i)].ping })).sort((x, y) => x.ping - y.ping);
        const unchecked = list.slice(tested);
        list = ranked.map(x => x.line).concat(unchecked);
        const newHealth = {};
        ranked.forEach((x, i) => { newHealth[String(i)] = { ok: true, ping: x.ping, at: Date.now(), line: String(x.line).slice(0, 120) }; });
        // Stay on the connected server if it is still working; otherwise move to the fastest one.
        let newIdx = 0;
        if (connectedLine) { const at = list.indexOf(connectedLine); if (at !== -1 && newHealth[String(at)]) newIdx = at; }
        await set({
          proxyList: list,
          proxyIndex: newIdx,
          proxyHealth: newHealth,
          proxyBestLatency: ranked.length ? ranked[0].ping : null,
          proxyCheck: { running: false, done: tested, total: max, working: ranked.length, dead, removed: dead },
          proxySpeedStatus: scanCancel ? "Cancelled." : (ranked.length
            ? `Done · ${ranked.length} working · ${dead} not working · fastest ${ranked[0].ping} ms`
            : `Done · 0 working · ${dead} not working`)
        });
        if (data.proxyEnabled && list.length && newHealth[String(newIdx)]) {
          const p = parseProxyLine(list[newIdx]);
          if (p) { try { await setProxyConfig(p, ProxyScope.hostnameOf(data.proxyOrigin), !!data.proxyGlobalMode); await applyFingerprint(newIdx); } catch (_) {} }
        } else if (data.proxyEnabled) {
          // The connected server died and nothing else works: disconnect cleanly rather than leave a dead proxy active.
          await set({ proxyEnabled: false, unblockEnabled: false });
          try { await setProxyConfig(null); } catch (_) {}
        } else {
          try { await setProxyConfig(null); } catch (_) {}
        }
        return { checked: tested, kept: ranked.length, removed: dead };
      }

      await set({ proxyHealth: health, proxyCheck: { running: false, done: tested, total: max, working, dead },
        proxySpeedStatus: `Checked ${tested} · ${working} working · ${dead} dead` });
      if (keep && data.proxyEnabled) {
        try { await setProxyConfig(keep, ProxyScope.hostnameOf(data.proxyOrigin), !!data.proxyGlobalMode); } catch (_) {}
      } else {
        try { await setProxyConfig(null); } catch (_) {}
      }
      return { checked: tested, kept: working };
    } finally {
      proxyCheckRunning = false;
      try { await set({ proxyCheck: { ...(await get({ proxyCheck: {} })).proxyCheck, running: false } }); } catch (_) {}
    }
  }

  // Promise wrappers — chrome.privacy may be callback-only on some builds
  function privacyGet(setting) {
    return new Promise((resolve, reject) => {
      try {
        if (!setting || typeof setting.get !== "function") {
          reject(new Error("setting unavailable"));
          return;
        }
        const ret = setting.get({}, details => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(details || {});
        });
        // Promise-based API (no callback used by Chrome)
        if (ret && typeof ret.then === "function") {
          ret.then(resolve).catch(reject);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  function privacySet(setting, value) {
    return new Promise((resolve, reject) => {
      try {
        if (!setting || typeof setting.set !== "function") {
          reject(new Error("setting unavailable"));
          return;
        }
        const ret = setting.set({ value }, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
        if (ret && typeof ret.then === "function") {
          ret.then(() => resolve()).catch(reject);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  function privacyClear(setting) {
    return new Promise((resolve) => {
      try {
        if (!setting || typeof setting.clear !== "function") {
          resolve();
          return;
        }
        const ret = setting.clear({}, () => resolve());
        if (ret && typeof ret.then === "function") ret.then(() => resolve()).catch(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  
  /* ---------- captcha: scan frames, solve reCAPTCHA by audio, or via a paid token API ---------- */
  const RC_ANCHOR_RE = /\/recaptcha\/(api2|enterprise)\/anchor/;
  const RC_BFRAME_RE = /\/recaptcha\/(api2|enterprise)\/bframe/;
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || "Timed out")), ms))]);

  function isRecaptchaFrame(url, re) {
    try { const u = new URL(url); return /(^|\.)(google\.[a-z.]+|recaptcha\.net)$/.test(u.hostname) && re.test(u.pathname); } catch (_) { return false; }
  }
  async function captchaFrames(tabId) {
    try { return (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch (_) { return []; }
  }

  // Make sure the captcha scripts run in every frame (tabs opened before the extension was installed/updated).
  async function ensureCaptchaScripts(tabId) {
    const frames = await captchaFrames(tabId);
    const missing = [];
    await Promise.all(frames.filter(f => /^https?:/i.test(f.url)).map(async f => {
      try { await chrome.tabs.sendMessage(tabId, { type: "captchaPing" }, { frameId: f.frameId }); } catch (_) { missing.push(f.frameId); }
    }));
    if (missing.length) {
      try { await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: ["content/captcha-main.js"], world: "MAIN" }); } catch (_) {}
      try { await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: ["content/captcha-frame.js"] }); } catch (_) {}
    }
    return frames;
  }

  async function captchaScan(tabId) {
    const frames = await ensureCaptchaScripts(tabId);
    const out = [];
    await Promise.all(frames.filter(f => /^https?:/i.test(f.url)).map(async f => {
      try {
        const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "captchaRescan" }, { frameId: f.frameId }), 4000, "scan timeout");
        if (r && r.ok) out.push({ frameId: f.frameId, role: r.role, url: r.url, top: r.top, finds: Array.isArray(r.finds) ? r.finds : [] });
      } catch (_) {}
    }));
    return out;
  }

  // One row per (type, sitekey): the page frame, anchor frame and challenge frame all describe the same widget.
  function summarizeCaptcha(results) {
    const map = new Map();
    for (const fr of results) for (const f of fr.finds) {
      const key = f.type + "|" + (f.sitekey || "");
      const cur = map.get(key) || { type: f.type, sitekey: f.sitekey || "", count: 0, visible: false, invisible: false, challenge: false, checked: false, audio: false, blocked: false, frames: [] };
      cur.count++;
      cur.visible = cur.visible || !!f.visible;
      cur.invisible = cur.invisible || !!f.invisible;
      cur.challenge = cur.challenge || f.kind === "challenge";
      cur.checked = cur.checked || !!f.checked;
      cur.audio = cur.audio || !!f.audio;
      cur.blocked = cur.blocked || !!f.blocked;
      cur.frames.push(fr.frameId);
      map.set(key, cur);
    }
    let list = Array.from(map.values());
    list = list.filter(x => x.sitekey || !list.some(y => y.type === x.type && y.sitekey));   // drop key-less duplicates
    return list;
  }

  async function readCaptchaToken(tabId, frames) {
    const reads = await Promise.all((frames || await captchaFrames(tabId)).filter(f => /^https?:/i.test(f.url)).map(f =>
      chrome.tabs.sendMessage(tabId, { type: "captchaReadToken" }, { frameId: f.frameId }).then(r => (r && r.token) || "", () => "")));
    return reads.find(Boolean) || "";
  }
  async function anyAnchorChecked(tabId, frames) {
    const anchors = frames.filter(f => isRecaptchaFrame(f.url, RC_ANCHOR_RE));
    const rs = await Promise.all(anchors.map(f => chrome.tabs.sendMessage(tabId, { type: "captchaAnchorState" }, { frameId: f.frameId }).then(r => !!(r && r.checked), () => false)));
    return rs.some(Boolean);
  }

  async function solveRecaptchaAudio(tabId, preferFrameId) {
    const st = await get({ captchaWitToken: "" });
    if (!st.captchaWitToken) throw new Error("Add a free Wit.ai token in Captcha settings first (wit.ai → New app → Settings → Server Access Token).");
    let frames = await ensureCaptchaScripts(tabId);
    const challengeFrames = fr => fr.filter(f => isRecaptchaFrame(f.url, RC_BFRAME_RE));

    let bframe = preferFrameId != null ? frames.find(f => f.frameId === preferFrameId) : null;
    if (!bframe) {
      if (await readCaptchaToken(tabId, frames)) return { ok: true, note: "Already solved." };
      const cands = challengeFrames(frames);
      if (cands.length) bframe = cands[cands.length - 1];
    }
    if (!bframe) {
      const anchors = frames.filter(f => isRecaptchaFrame(f.url, RC_ANCHOR_RE));
      if (!anchors.length) throw new Error("No reCAPTCHA checkbox or challenge found on this page.");
      let clicked = false;
      for (const a of anchors) {
        const state = await chrome.tabs.sendMessage(tabId, { type: "captchaAnchorState" }, { frameId: a.frameId }).catch(() => null);
        if (state && state.checked) continue;
        const r = await chrome.tabs.sendMessage(tabId, { type: "captchaClickCheckbox" }, { frameId: a.frameId }).catch(() => null);
        if (r && r.ok) { clicked = true; break; }
      }
      if (!clicked) {
        if (await readCaptchaToken(tabId, frames) || await anyAnchorChecked(tabId, frames)) return { ok: true, note: "Already solved." };
        throw new Error("Could not click the reCAPTCHA checkbox.");
      }
      const end = Date.now() + 12000;
      while (Date.now() < end && !bframe) {
        await sleepMs(500);
        frames = await captchaFrames(tabId);
        const c = challengeFrames(frames);
        if (c.length) { bframe = c[c.length - 1]; break; }
        if (await readCaptchaToken(tabId, frames)) return { ok: true, note: "Solved by the checkbox alone (no challenge was needed)." };
      }
      if (!bframe) throw new Error("No challenge appeared after clicking the checkbox.");
      await sleepMs(900);          // let the challenge finish rendering
    }

    let lastErr = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      let r;
      try { r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "captchaSolveAudioOnce" }, { frameId: bframe.frameId }), 75000, "The challenge frame did not answer."); }
      catch (e) { r = { ok: false, phase: "error", error: e.message || String(e) }; }
      if (r && (r.phase === "blocked" || r.phase === "stt-error" || r.phase === "no-audio")) throw new Error(r.error);
      if (r && r.ok) {
        let accepted = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !accepted) {
          await sleepMs(500);
          frames = await captchaFrames(tabId);
          accepted = !!(await readCaptchaToken(tabId, frames)) || await anyAnchorChecked(tabId, frames);
        }
        if (accepted) return { ok: true, attempts: attempt, text: r.text };
        lastErr = `the answer “${r.text}” was not accepted`;
      } else {
        lastErr = (r && r.error) || "unknown error";
      }
      await sleepMs(900);
    }
    throw new Error(`Not solved after 4 tries (${lastErr}). Speech recognition can mishear; try again.`);
  }

  const CAPTCHA_TYPE_KEY = { "reCAPTCHA v2": "recaptcha_v2", "reCAPTCHA Enterprise": "recaptcha_v2", "reCAPTCHA v3": "recaptcha_v3", "hCaptcha": "hcaptcha", "Cloudflare Turnstile": "turnstile" };

  async function captchaSolveTab(tab) {
    const store = await get({ captchaProvider: "audio", captchaKey: "", captchaUrl: "", captchaWitToken: "" });
    const results = await captchaScan(tab.id);
    const list = summarizeCaptcha(results);
    if (!list.length) {
      return { ok: false, error: "No captcha found on this page. If it appears after you click something, click it first, then tap Solve." };
    }
    const tokenReady = !!store.captchaKey && store.captchaProvider !== "audio" && store.captchaProvider !== "none";
    const rc = list.find(x => /^reCAPTCHA (v2|Enterprise)$/.test(x.type) && !x.invisible);
    const frames = await captchaFrames(tab.id);
    const hasRcFrames = frames.some(f => isRecaptchaFrame(f.url, RC_ANCHOR_RE) || isRecaptchaFrame(f.url, RC_BFRAME_RE));

    if (!tokenReady && rc && hasRcFrames) {
      await set({ captchaSolveStatus: "Solving the audio challenge…" });
      const r = await solveRecaptchaAudio(tab.id);
      await set({ captchaSolveStatus: "Solved." });
      return { ok: true, method: "audio", ...r, injected: true };
    }
    if (!tokenReady) {
      const names = list.map(x => x.type).join(", ");
      return { ok: false, error: `${names} found, but the free audio method only works for the visible reCAPTCHA v2 checkbox. For this one, choose 2Captcha or Anti-Captcha in settings and add an API key.` };
    }

    const pick = list.filter(x => x.sitekey && CAPTCHA_TYPE_KEY[x.type]).sort((a, b) => (b.visible - a.visible) || (a.invisible - b.invisible))[0];
    if (!pick) return { ok: false, error: "A captcha was detected but its sitekey could not be read, so an API solver cannot be used for it." };
    await set({ captchaSolveStatus: "Solving via " + store.captchaProvider + "…" });
    const result = await CaptchaSolver.solve({
      provider: store.captchaProvider, key: store.captchaKey, type: CAPTCHA_TYPE_KEY[pick.type],
      sitekey: pick.sitekey, pageurl: tab.url, action: "", customUrl: store.captchaUrl
    });
    let filled = 0;
    await Promise.all(frames.filter(f => /^https?:/i.test(f.url)).map(async f => {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "captchaInjectToken", token: result.token }, { frameId: f.frameId }).catch(() => null);
      if (r && r.filled) filled += r.filled;
    }));
    await set({ captchaSolveStatus: filled ? "Token filled in — submit the form." : "Solved, but no response field was found — try submitting." });
    return { ok: true, method: "api", injected: filled > 0, provider: result.provider };
  }

  /* ---------- ad-blocker allowlist ---------- */
  const ALLOW_RULE_BASE = 940001;      // 940001..949999 reserved for allowlist rules

  function cleanAllowList(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const h = MemikAllow.normalizeHost(raw);
      if (h && !out.includes(h)) out.push(h);
    }
    return out.slice(0, 500);
  }

  // Two high-priority rules per site: `allowAllRequests` (everything a page on that site loads) and
  // `allow` (any request TO that site). Both outrank every static block rule (max priority 10000).
  // Serialised: the storage listener and the message handlers both call this, and two overlapping runs would
  // try to add the same rule ids ("does not have a unique ID").
  let allowSyncChain = Promise.resolve();
  function syncAllowRules() {
    allowSyncChain = allowSyncChain.then(doSyncAllowRules, doSyncAllowRules);
    return allowSyncChain;
  }
  async function doSyncAllowRules() {
    const d = await get({ adblockAllow: [] });
    const hosts = [];
    for (const h of MemikAllow.BUILTIN.concat(cleanAllowList(d.adblockAllow))) if (!hosts.includes(h)) hosts.push(h);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.filter(r => r.id >= ALLOW_RULE_BASE && r.id < 950000).map(r => r.id);
    const addRules = [];
    hosts.forEach((h, i) => {
      addRules.push({ id: ALLOW_RULE_BASE + i * 2, priority: 1000000, action: { type: "allowAllRequests" },
        condition: { requestDomains: [h], resourceTypes: ["main_frame", "sub_frame"] } });
      addRules.push({ id: ALLOW_RULE_BASE + i * 2 + 1, priority: 1000000, action: { type: "allow" },
        condition: { requestDomains: [h] } });
    });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.adblockAllow) syncAllowRules().catch(() => {});
  });

  // "Disconnected" in storage must always mean "proxy cleared in Chrome", even if the popup closes before it
  // gets to send its settings message.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.proxyEnabled || changes.proxyEnabled.newValue !== false) return;
    if (proxyCheckRunning) return;                  // a running scan manages the proxy config itself
    applyProxySettings().catch(() => {});
  });

  // Some mail APIs refuse requests whose Origin is "chrome-extension://…" (they only expect their own website).
  // For requests made by the extension itself (tabId -1) to those APIs, present the provider's own site as the origin.
  const ORIGIN_RULE_BASE = 950001;
  async function ensureMailOriginRules() {
    const sites = [
      ["api.tempmail.lol", "https://tempmail.lol"],
      ["api.mail.tm", "https://mail.tm"],
      ["api.guerrillamail.com", "https://www.guerrillamail.com"],
      ["tempmail.plus", "https://tempmail.plus"]
    ];
    const addRules = sites.map(([host, origin], i) => ({
      id: ORIGIN_RULE_BASE + i,
      priority: 2000000,            // must outrank the allow rules (1000000), which would otherwise suppress this rewrite
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "origin", operation: "set", value: origin },
        { header: "referer", operation: "set", value: origin + "/" }
      ] },
      condition: { requestDomains: [host], tabIds: [-1], resourceTypes: ["xmlhttprequest", "other"] }
    }));
    // tabIds ("requests that do not come from a tab") is only valid in session rules.
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map(r => r.id), addRules });
  }
  ensureMailOriginRules().catch(e => console.warn("mail origin rules", e));   // also on every worker start

  async function ensureTempMailAllowRules() {
    // High-priority allow so adblock rulesets never block inbox APIs
    const hosts = (typeof TempMail !== "undefined" && TempMail.HOSTS) ? TempMail.HOSTS : [
      "api.mail.tm", "api.tempmail.lol", "api.guerrillamail.com", "www.guerrillamail.com"
    ];
    const rules = hosts.map((h, i) => ({
      id: 930001 + i,
      priority: 1000000,
      action: { type: "allow" },
      condition: {
        requestDomains: [h],
        resourceTypes: ["xmlhttprequest", "other", "main_frame", "sub_frame"]
      }
    }));
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map(r => r.id),
        addRules: rules
      });
    } catch (e) {
      console.warn("temp-mail allow rules", e);
    }
  }

async function applyCloudflareDns(enabled) {
    try {
      if (!chrome.privacy || !chrome.privacy.network) {
        return { ok: false, error: "Privacy API missing — use desktop Chrome/Edge" };
      }

      const mode = chrome.privacy.network.secureDNSMode;
      const templates = chrome.privacy.network.secureDNSTemplates;

      // Cloudflare 1.1.1.1 family (DoH)
      const CF_DOH = [
        "https://chrome.cloudflare-dns.com/dns-query",
        "https://1.1.1.1/dns-query",
        "https://1.0.0.1/dns-query",
        "https://cloudflare-dns.com/dns-query",
        "https://[2606:4700:4700::1111]/dns-query"
      ];

      if (!enabled) {
        if (mode) {
          try { await privacySet(mode, "automatic"); } catch (_) {
            try { await privacySet(mode, "off"); } catch (__) {}
          }
        }
        if (templates) await privacyClear(templates);
        await set({ cfDnsEnabled: false });
        return { ok: true, enabled: false };
      }

      // Enable path
      if (!mode) {
        return {
          ok: false,
          error: "This browser build has no Secure DNS API. Use Chrome/Edge on desktop (not mobile) and enable chrome://flags/#dns-over-https if needed."
        };
      }

      let control = {};
      try { control = await privacyGet(mode); } catch (e) {
        return { ok: false, error: "Cannot read Secure DNS: " + (e.message || e) };
      }
      const level = control.levelOfControl || "";
      if (level === "not_controllable") {
        return {
          ok: false,
          error: "Chrome policy blocks Secure DNS. Check chrome://settings/security → Use secure DNS, or enterprise policy."
        };
      }
      if (level === "controlled_by_other_extensions") {
        return { ok: false, error: "Another extension controls DNS — disable it first" };
      }

      // Templates first (custom Cloudflare), then force secure mode
      if (templates) {
        try {
          await privacySet(templates, CF_DOH);
        } catch (e1) {
          // Some builds only accept a single template string in older formats — try one
          try {
            await privacySet(templates, ["https://1.1.1.1/dns-query"]);
          } catch (e2) {
            console.warn("DoH templates failed", e1, e2);
          }
        }
      }

      try {
        await privacySet(mode, "secure");
      } catch (e) {
        return {
          ok: false,
          error: "Could not set Secure DNS on: " + (e.message || e) +
            ". Open chrome://settings/security and set Use secure DNS → Cloudflare (1.1.1.1)."
        };
      }

      // Verify
      let after = {};
      try { after = await privacyGet(mode); } catch (_) {}
      await set({ cfDnsEnabled: true });
      return {
        ok: true,
        enabled: true,
        value: after.value || "secure",
        note: "Cloudflare 1.1.1.1 DoH active"
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function pickFastestProxy({ force } = {}) {
    const data = await get({
      proxyList: [], proxyEnabled: false, proxyGlobalMode: true,
      proxyOrigin: "", proxySpeedMode: false, proxyIndex: 0,
      proxyBestLatency: null
    });
    if (!data.proxySpeedMode && !force) return null;
    if (!data.proxyEnabled || !Array.isArray(data.proxyList) || !data.proxyList.length) return null;

    const globalMode = !!data.proxyGlobalMode;
    const hostname = ProxyScope.hostnameOf(data.proxyOrigin);
    if (!globalMode && !hostname) return null;

    // Sample only the first SPEED_SAMPLE entries (list should be speed-sorted if auto-fetched)
    const n = Math.min(Math.max(SPEED_SAMPLE, 10), data.proxyList.length);
    let bestIdx = 0;
    let bestMs = null;

    for (let i = 0; i < n; i++) {
      const parsed = parseProxyLine(data.proxyList[i]);
      if (!parsed) continue;
      let ms = await measureProxyLatency(parsed, hostname, globalMode);
      if (ms != null) { const ms2 = await probeLatency(SPEED_TIMEOUT_MS); if (ms2 != null && ms2 < ms) ms = ms2; }
      if (ms != null && (bestMs == null || ms < bestMs)) {
        bestMs = ms;
        bestIdx = i;
      }
      // tiny pause so we do not thrash proxy settings
      await new Promise(r => setTimeout(r, 80));
    }

    // Apply winner (or keep index 0 if all failed)
    const winParsed = parseProxyLine(data.proxyList[bestIdx]);
    if (winParsed) {
      try { await setProxyConfig(winParsed, hostname, globalMode); } catch (_) {}
    }
    await set({
      proxyIndex: bestIdx,
      proxyBestLatency: bestMs,
      proxySpeedStatus: bestMs != null
        ? `Fastest: #${bestIdx + 1} · ${bestMs} ms`
        : `No responsive proxy in top ${n}; using #${bestIdx + 1}`
    });
    return { index: bestIdx, latency: bestMs };
  }

  async function recheckProxySpeed() {
    const data = await get({
      proxyList: [], proxyEnabled: false, proxyGlobalMode: true,
      proxyOrigin: "", proxySpeedMode: false, proxyIndex: 0,
      proxyBestLatency: null
    });
    if (!data.proxySpeedMode || !data.proxyEnabled || !data.proxyList.length) {
      await chrome.alarms.clear(SPEED_ALARM);
      return;
    }
    const globalMode = !!data.proxyGlobalMode;
    const hostname = ProxyScope.hostnameOf(data.proxyOrigin);
    if (!globalMode && !hostname) return;

    const idx = Math.max(0, Number(data.proxyIndex) || 0) % data.proxyList.length;
    const parsed = parseProxyLine(data.proxyList[idx]);
    if (!parsed) {
      await pickFastestProxy({ force: true });
      return;
    }

    // One light probe of the current winner only
    const ms = await measureProxyLatency(parsed, hostname, globalMode);
    const baseline = data.proxyBestLatency;

    if (ms == null) {
      // Current failed → full pick among small sample
      await set({ proxySpeedStatus: `Proxy #${idx + 1} failed — picking another…` });
      await pickFastestProxy({ force: true });
      return;
    }

    if (baseline != null && ms > baseline * SPEED_SLOW_FACTOR) {
      await set({ proxySpeedStatus: `Proxy #${idx + 1} slowed (${ms} ms) — rechecking…` });
      await pickFastestProxy({ force: true });
      return;
    }

    // Still good — update baseline gently toward measured
    const nextBase = baseline == null ? ms : Math.round((baseline * 2 + ms) / 3);
    await set({
      proxyBestLatency: nextBase,
      proxySpeedStatus: `Fastest: #${idx + 1} · ${ms} ms`
    });
  }

  async function applySpeedMode() {
    const data = await get({ proxySpeedMode: false, proxyEnabled: false });
    await chrome.alarms.clear(SPEED_ALARM);
    if (!data.proxySpeedMode || !data.proxyEnabled) {
      await set({ proxySpeedStatus: data.proxySpeedMode ? "Turn Unblock on first." : "" });
      return { active: false };
    }
    // Initial pick, then light recheck every SPEED_RECHECK_MIN minutes
    const result = await pickFastestProxy({ force: true });
    await chrome.alarms.create(SPEED_ALARM, {
      delayInMinutes: SPEED_RECHECK_MIN,
      periodInMinutes: SPEED_RECHECK_MIN
    });
    return { active: true, result };
  }



  /* ---------- Auto-switch proxy when site is unreachable ---------- */
  // Only errors that point at the proxy itself. Unknown hostnames / being offline must NOT churn servers.
  const PROXY_FAIL_RE = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_AUTH|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/i;
  let lastAutoRotateAt = 0;
  const AUTO_ROTATE_COOLDOWN_MS = 8000; // avoid thrashing

  async function autoRotateOnce(reason) {
    const data = await get({ proxyEnabled: false, proxyList: [], proxyIndex: 0 });
    if (!data.proxyEnabled || !Array.isArray(data.proxyList) || data.proxyList.length < 2) return false;
    if (await anyTabOnCloudflareChallenge()) return false;
    const now = Date.now();
    if (now - lastAutoRotateAt < AUTO_ROTATE_COOLDOWN_MS) return false;
    lastAutoRotateAt = now;
    console.info("Auto-rotate proxy:", reason);
    await markProxyHealth(Math.max(0, Number(data.proxyIndex) || 0), false, null);
    await set({ proxySpeedStatus: "Server unavailable. Switching…" });
    await rotateProxy();
    return true;
  }

  if (chrome.webNavigation && chrome.webNavigation.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener(async details => {
      try {
        if (details.frameId !== 0) return;
        const err = details.error || "";
        if (!PROXY_FAIL_RE.test(err)) return;
        await autoRotateOnce(err + " " + details.url);
      } catch (e) {
        console.warn("auto-rotate failed", e);
      }
    });
  }

  /* ---------- SSL interstitial: ignore cert errors + rotate dead proxy ---------- */
  const CERT_ERRORS = new Set([
    "net::ERR_CERT_COMMON_NAME_INVALID",
    "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_CERT_DATE_INVALID",
    "net::ERR_CERT_INVALID",
    "net::ERR_SSL_PROTOCOL_ERROR",
    "net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
    "net::ERR_BAD_SSL_CLIENT_AUTH_CERT",
    "net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM",
    "net::ERR_CERT_WEAK_KEY",
    "net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED",
    "net::ERR_CERT_CONTAINS_ERRORS",
    "net::ERR_CERT_NAME_CONSTRAINT_VIOLATION",
    "net::ERR_CERT_VALIDITY_TOO_LONG",
    "net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN",
    "net::ERR_CERT_NON_UNIQUE_NAME"
  ]);

  // A certificate error while a proxy is active usually means that proxy is intercepting traffic.
  // Never bypass it: move to another server and reload the page instead.
  if (chrome.webNavigation && chrome.webNavigation.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener(async details => {
      try {
        if (details.frameId !== 0) return;
        const err = details.error || "";
        if (!CERT_ERRORS.has(err) && !/ERR_CERT|ERR_SSL|SSL_CLIENT|CERTIFICATE/i.test(err)) return;
        if (!details.url || !/^https:/i.test(details.url)) return;
        const st = await get({ proxyEnabled: false });
        if (!st.proxyEnabled) return;                   // no proxy: leave Chrome's normal warning alone
        if (await autoRotateOnce(err)) {
          await new Promise(r => setTimeout(r, 300));
          try { await chrome.tabs.update(details.tabId, { url: details.url }); } catch (_) {}
        }
      } catch (e) {
        console.warn("cert recovery failed", e);
      }
    });
  }

  // Proxy authentication: Oxylabs and any listed proxy written as user:pass@host:port.
  // Credentials are ONLY ever sent to the proxy that asked (details.isProxy), never to a website.
  const authAttempts = new Map();
  // Set while servers are being tested: the login challenge must be answered with the credentials of the
  // candidate under test, not those of another list entry that shares the same host:port.
  let authCandidates = null;
  function withAuthCandidates(parsedList, fn) {
    authCandidates = parsedList.filter(Boolean);
    return Promise.resolve().then(fn).finally(() => { authCandidates = null; });
  }
  try {
    if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
      chrome.webRequest.onAuthRequired.addListener(
        (details, asyncCallback) => {
          (async () => {
            try {
              if (!details.isProxy) { asyncCallback({}); return; }
              const now = Date.now();
              for (const [k, t] of authAttempts) if (now - t > 60000) authAttempts.delete(k);
              if (authAttempts.has(details.requestId)) { asyncCallback({}); return; }   // wrong creds: do not loop
              authAttempts.set(details.requestId, now);
              const ch = details.challenger || {};
              if (authCandidates) {
                const under = authCandidates.find(p => p.host.toLowerCase() === String(ch.host || "").toLowerCase() && (!ch.port || p.port === ch.port));
                if (under) {
                  asyncCallback(under.user ? { authCredentials: { username: under.user, password: under.pass || "" } } : {});
                  return;
                }
              }
              const data = await get({
                oxylabsEnabled: false, oxylabsUser: "", oxylabsPass: "", oxylabsHost: "unblock.oxylabs.io", oxylabsPort: 60000,
                proxyList: [], proxyIndex: 0, proxyEnabled: false
              });
              if (data.oxylabsEnabled && data.oxylabsUser && String(ch.host || "").toLowerCase() === String(data.oxylabsHost || "").toLowerCase()) {
                asyncCallback({ authCredentials: { username: data.oxylabsUser, password: data.oxylabsPass || "" } });
                return;
              }
              const list = data.proxyList || [];
              const idx = list.length ? Math.max(0, Number(data.proxyIndex) || 0) % list.length : -1;
              const candidates = (idx >= 0 ? [list[idx]] : []).concat(list);
              for (const line of candidates) {
                const p = parseProxyLine(line);
                if (p && p.user && p.host.toLowerCase() === String(ch.host || "").toLowerCase() && (!ch.port || p.port === ch.port)) {
                  asyncCallback({ authCredentials: { username: p.user, password: p.pass || "" } });
                  return;
                }
              }
            } catch (_) {}
            asyncCallback({});
          })();
        },
        { urls: ["<all_urls>"] },
        ["asyncBlocking"]
      );
    }
  } catch (e) {
    console.warn("onAuthRequired setup failed", e);
  }

})();