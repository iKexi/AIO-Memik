/*
 * Page-side recorder and replayer.
 * Injected automatically on page load, and on demand (chrome.scripting) into
 * tabs that were already open, so recording works without a page refresh.
 */
(function () {
  "use strict";
  if (window.__bcaLoaded) return;
  window.__bcaLoaded = true;

  const policy = globalThis.AutomationPolicy;
  if (!policy) return;

  const MAX_ACTIONS = 500;
  // password included so login automation can record credentials
  const TEXT_INPUTS = ["text", "search", "url", "email", "tel", "number", "password"];
  const INTERACTIVE = "button,a,summary,select,textarea,input,[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='option'],[role='checkbox'],[role='radio'],[role='switch']";

  /* ---------- small helpers ---------- */
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const fail = error => ({ ok: false, error });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function isVisible(el, loose) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return loose || (r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth);
  }

  function labelOf(el) {
    const parts = [el.getAttribute("aria-label")];
    const by = el.getAttribute("aria-labelledby");
    if (by) parts.push(by.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" "));
    if (el.labels) parts.push(...[...el.labels].map(l => l.textContent));
    parts.push(el.getAttribute("title"), el.getAttribute("placeholder"), el.getAttribute("alt"));
    let text = clean(parts.filter(Boolean).join(" "));
    if (!text && !el.matches("input,textarea,select,[contenteditable]")) text = clean(el.innerText || el.textContent);
    if (!text && el.matches("input[type=button],input[type=submit]")) text = clean(el.value);
    return text.slice(0, 160);
  }

  function uniqueId(id) {
    try { return document.querySelectorAll("#" + CSS.escape(id)).length === 1; } catch (_) { return false; }
  }

  function cssPath(el) {
    const sens = policy.sensitiveField;
    if (el.id && !sens.test(el.id) && uniqueId(el.id)) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node !== el && node.id && !sens.test(node.id) && uniqueId(node.id)) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const classes = [...node.classList].filter(c => /^[a-zA-Z][\w-]{0,30}$/.test(c) && !sens.test(c)).slice(0, 2);
      if (classes.length) part += "." + classes.map(CSS.escape).join(".");
      const siblings = node.parentElement ? [...node.parentElement.children].filter(x => x.tagName === node.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
      try { if (document.querySelectorAll(parts.join(" > ")).length === 1) break; } catch (_) { /* keep climbing */ }
    }
    return parts.join(" > ");
  }

  /* ---------- safety checks ---------- */
  // Allow login forms (password present) so login routines can finish.
  // Still block file uploads and non-http(s) / unsafe actions.
  function safeSubmit(el) {
    const form = el.form || el.closest("form");
    if (!form) return true;
    if (form.querySelector("input[type=file]")) return false;
    const action = form.getAttribute("action");
    if (action) {
      try {
        const href = new URL(action, location.href).href;
        if (!policy.pageUrl(href, location.origin)) return false;
        // Allow same-origin form posts (typical login); still refuse checkout/payment paths.
        if (!policy.safeUrl(href, location.origin)) {
          // login paths are ok when the form itself contains a password field
          if (!form.querySelector("input[type=password]")) return false;
        }
      } catch (_) { return false; }
    }
    return true;
  }

  // True when this control must be ignored by the recorder and refused by replay.
  function blocked(el, kind) {
    if (!(el instanceof Element) || !policy.pageUrl(location.href, location.origin)) return true;
    if (el.isContentEditable || el.disabled) return true;
    const fieldMeta = {
      name: el.getAttribute("name"), id: el.id, type: el.getAttribute("type") || el.type,
      autocomplete: el.getAttribute("autocomplete"), "aria-label": el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"), label: labelOf(el)
    };
    const isPw = policy.isPasswordField(fieldMeta);
    // Password fields are allowed for typing / Enter (login automation), not for clicks.
    if (policy.isSensitiveField(fieldMeta)) return true;
    if (isPw && kind === "click") return true;

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (kind === "click") {
        if (type === "submit") {
          if (!safeSubmit(el)) return true;
          // Allow submit on login forms even when the label matches "submit".
          const formEl = el.form || el.closest("form");
          const loginForm = formEl && formEl.querySelector("input[type=password]");
          if (!loginForm) {
            const meta = [el.getAttribute("name"), el.id, el.getAttribute("type"), labelOf(el)].filter(Boolean).join(" ");
            if (policy.sensitiveControl.test(meta)) return true;
          }
        } else if (!["button", "checkbox", "radio"].includes(type)) return true;
      } else if (!TEXT_INPUTS.includes(type) || el.readOnly) return true;
      else if (!isPw) {
        const meta = [el.getAttribute("name"), el.id, el.getAttribute("type"), el.getAttribute("autocomplete"),
          el.getAttribute("aria-label"), el.getAttribute("placeholder"), labelOf(el)].filter(Boolean).join(" ");
        if (policy.sensitiveControl.test(meta)) return true;
      }
    } else if (tag === "textarea") {
      if (kind === "click" || el.readOnly) return true;
    } else if (tag === "select") {
      if (kind === "click") return true;
    } else if (tag === "button") {
      const type = (el.getAttribute("type") || (el.form ? "submit" : "button")).toLowerCase();
      if (type === "reset" || (type === "submit" && !safeSubmit(el))) return true;
      const btnLabel = labelOf(el);
      // Login / continue on password forms is allowed; destructive actions stay blocked.
      const formEl = el.form || el.closest("form");
      const isLoginish = /log\s?in|sign\s?in|continue|next|submit/i.test(btnLabel)
        && !!(formEl && formEl.querySelector("input[type=password]"));
      if (policy.sensitiveControl.test(btnLabel) && !isLoginish) return true;
    }
    const link = el.closest("a");
    if (link) {
      const href = link.getAttribute("href") || "";
      if (href && !/^(#|javascript:)/i.test(href) && !policy.safeUrl(link.href, location.origin)) return true;
      if (policy.sensitiveControl.test(labelOf(link))) return true;
    } else if (tag !== "input" && tag !== "button" && tag !== "textarea" && tag !== "select") {
      if (policy.sensitiveControl.test(labelOf(el))) return true;
    }
    return false;
  }

  function describe(el, kind) {
    if (!el || blocked(el, kind) || !isVisible(el)) return null;
    const type = el.type || "";
    const target = { selector: cssPath(el), text: labelOf(el), tag: el.tagName.toLowerCase(), type };
    if (policy.isPasswordField({ type, autocomplete: el.getAttribute("autocomplete") })) target.isPassword = true;
    return target;
  }

  /* ---------- floating status (recording pill / replay progress bar) ---------- */
  let pillHost = null, pillRoot = null, pillTimer = null;
  function ensureHud() {
    if (pillHost && pillHost.isConnected) return;
    pillHost = document.createElement("div");
    pillHost.setAttribute("data-bca", "pill");
    pillHost.style.cssText = "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;";
    pillRoot = pillHost.attachShadow({ mode: "closed" });
    pillRoot.innerHTML = `<style>
      :host, * { box-sizing: border-box; }
      .wrap { pointer-events: none; font: 600 12px/1.2 "Segoe UI", system-ui, sans-serif; }
      /* Recording: compact pill top-right */
      .pill {
        pointer-events: auto; position: fixed; top: 14px; right: 14px;
        display: none; align-items: center; gap: 10px;
        padding: 8px 8px 8px 14px; border-radius: 999px; color: #fff;
        background: #1b1533; box-shadow: 0 8px 28px rgba(27,21,51,.35); max-width: 340px;
      }
      .pill.show { display: flex; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #ff4d5e; flex: none; }
      .rec .dot { animation: blink 1.2s ease-in-out infinite; }
      .done .dot { background: #3ddc97; animation: none; }
      .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; }
      .pill button {
        all: unset; cursor: pointer; pointer-events: auto;
        padding: 7px 12px; border-radius: 999px; background: #ff4d5e; color: #fff;
        font: 700 12px/1 "Segoe UI", system-ui, sans-serif;
      }
      .pill button:hover { filter: brightness(1.1); }
      /* Replay: slim top progress bar with percent — no big overlay */
      .bar-host {
        pointer-events: none; position: fixed; top: 0; left: 0; right: 0;
        display: none; flex-direction: column; align-items: stretch;
      }
      .bar-host.show { display: flex; }
      .track {
        height: 4px; background: rgba(27,21,51,.12);
        backdrop-filter: blur(6px);
      }
      .fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, #5b3df5, #8a6cff);
        transition: width .2s ease;
        box-shadow: 0 0 12px rgba(91, 61, 245, .45);
      }
      .meta {
        pointer-events: auto; align-self: flex-end; margin: 8px 12px 0;
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 6px 12px; border-radius: 999px;
        background: rgba(27,21,51,.92); color: #fff;
        box-shadow: 0 6px 20px rgba(27,21,51,.28);
        max-width: min(360px, calc(100vw - 24px));
      }
      .pct { font-variant-numeric: tabular-nums; font-weight: 700; min-width: 2.6em; }
      .meta .sub { opacity: .85; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
      .meta button {
        all: unset; cursor: pointer; pointer-events: auto;
        padding: 5px 10px; border-radius: 999px; background: #5b3df5; color: #fff;
        font: 700 11px/1 "Segoe UI", system-ui, sans-serif;
      }
      .meta button:hover { filter: brightness(1.1); }
      @keyframes blink { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) {
        .dot { animation: none !important; }
        .fill { transition: none; }
      }
    </style>
    <div class="wrap">
      <div class="pill" role="status"><i class="dot"></i><span class="label"></span><button type="button">Stop</button></div>
      <div class="bar-host" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="track"><div class="fill"></div></div>
        <div class="meta"><span class="pct">0%</span><span class="sub"></span><button type="button">Stop</button></div>
      </div>
    </div>`;
    (document.documentElement || document.body).appendChild(pillHost);
  }

  function pill(mode, text, onStop) {
    clearTimeout(pillTimer);
    ensureHud();
    const pillEl = pillRoot.querySelector(".pill");
    const barEl = pillRoot.querySelector(".bar-host");
    barEl.classList.remove("show");
    pillEl.className = "pill show " + (mode || "");
    pillRoot.querySelector(".pill .label").textContent = text || "";
    const button = pillRoot.querySelector(".pill button");
    button.style.display = onStop ? "" : "none";
    button.onclick = onStop || null;
  }

  function progressBar(info) {
    clearTimeout(pillTimer);
    ensureHud();
    const pillEl = pillRoot.querySelector(".pill");
    const barEl = pillRoot.querySelector(".bar-host");
    pillEl.classList.remove("show");
    barEl.classList.add("show");
    const pct = Math.max(0, Math.min(100, Math.round(Number(info.percent) || 0)));
    barEl.setAttribute("aria-valuenow", String(pct));
    pillRoot.querySelector(".fill").style.width = pct + "%";
    pillRoot.querySelector(".pct").textContent = pct + "%";
    const name = info.name ? String(info.name).slice(0, 28) : "";
    const detail = info.text || (info.unlimited
      ? `Loop ${info.loop || 1} · step ${info.step || 0}/${info.steps || 0}`
      : `Loop ${info.loop || 1}/${info.loops || 1} · ${info.step || 0}/${info.steps || 0}`);
    pillRoot.querySelector(".bar-host .sub").textContent = name ? `${name} · ${detail}` : detail;
    const stopBtn = pillRoot.querySelector(".bar-host button");
    stopBtn.onclick = () => chrome.runtime.sendMessage({ type: "stopRoutine" }).catch(() => {});
  }

  function hidePill(delay) {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => {
      if (pillHost) {
        pillHost.remove();
        pillHost = pillRoot = null;
      }
    }, delay || 0);
  }

  /* ---------- recorder ---------- */
  let recording = false;
  let recorded = [];
  let draft = null;
  let saveTimer = null, scrollTimer = null;
  const handlers = [];
  const isPill = e => pillHost && e.target === pillHost;

  function persist(now) {
    if (!draft) return;
    const write = () => {
      saveTimer = null;
      draft.actions = recorded;
      draft.updatedAt = Date.now();
      try { chrome.storage.local.set({ recordingDraft: draft }); } catch (_) { /* extension reloaded */ }
    };
    if (now) { clearTimeout(saveTimer); write(); } else if (!saveTimer) saveTimer = setTimeout(write, 150);
    if (recording) pill("rec", `Recording · ${recorded.length} step${recorded.length === 1 ? "" : "s"}`, () => stopRecording());
  }

  function add(action) {
    if (!recording || !policy.validAction(action)) return false;
    const last = recorded[recorded.length - 1];
    if (last) {
      const same = last.target && action.target && last.target.selector === action.target.selector;
      if (action.kind === "scroll" && last.kind === "scroll") { recorded[recorded.length - 1] = action; persist(); return true; }
      if ((action.kind === "input" || action.kind === "change") && last.kind === action.kind && same) { recorded[recorded.length - 1] = action; persist(); return true; }
      if (action.kind === "click" && last.kind === "click" && same && action.at - last.at < 25) return false; // label + input double click
      // Avoid duplicate consecutive history steps of the same direction
      if (action.kind === "history" && last.kind === "history" && last.direction === action.direction && action.at - last.at < 800) return false;
    }
    recorded.push(action);
    persist();
    if (recorded.length >= MAX_ACTIONS) { draft.note = `Stopped at the ${MAX_ACTIONS}-step limit.`; stopRecording(); }
    return true;
  }
  function skip() { if (draft) { draft.skipped = (draft.skipped || 0) + 1; persist(); } }

  /* ---------- history / back-forward tracking ---------- */
  function navState() {
    if (!draft) return { stack: [location.href], index: 0 };
    if (!Array.isArray(draft.navStack) || !draft.navStack.length) {
      draft.navStack = [location.href];
      draft.navIndex = 0;
    }
    return { stack: draft.navStack, index: Number.isFinite(draft.navIndex) ? draft.navIndex : 0 };
  }

  function rememberUrl(href) {
    if (!draft) return;
    const { stack, index } = navState();
    const url = href || location.href;
    // Truncate forward branch when the user navigates to a new page after going back
    const next = stack.slice(0, index + 1);
    if (next[next.length - 1] !== url) next.push(url);
    draft.navStack = next.slice(-40); // cap memory
    draft.navIndex = draft.navStack.length - 1;
  }

  function recordHistoryDirection(direction) {
    if (!recording || (direction !== "back" && direction !== "forward")) return false;
    return add({ kind: "history", direction, at: Date.now() });
  }

  // Same-document history (SPA hash/pushState back-forward)
  function onPopState() {
    if (!recording || !draft) return;
    const { stack, index } = navState();
    const url = location.href;
    let direction = "back";
    const found = stack.indexOf(url);
    if (found >= 0 && found < index) direction = "back";
    else if (found > index) direction = "forward";
    else if (found < 0) {
      // Unknown URL after popstate — treat as back (most common) and extend stack
      direction = "back";
    }
    recordHistoryDirection(direction);
    if (found >= 0) draft.navIndex = found;
    else {
      const next = stack.slice(0, Math.max(0, index));
      next.push(url);
      draft.navStack = next.slice(-40);
      draft.navIndex = draft.navStack.length - 1;
    }
    persist(true);
  }

  function navigationType() {
    try {
      const entries = performance.getEntriesByType && performance.getEntriesByType("navigation");
      if (entries && entries[0] && entries[0].type) return entries[0].type; // "navigate" | "reload" | "back_forward" | "prerender"
    } catch (_) { /* older browsers */ }
    try {
      // Legacy PerformanceNavigation: 0=navigate, 1=reload, 2=back_forward
      if (performance.navigation && performance.navigation.type === 2) return "back_forward";
      if (performance.navigation && performance.navigation.type === 1) return "reload";
    } catch (_) { /* ignore */ }
    return "navigate";
  }

  // Called when recording resumes on a new document after a full navigation.
  function absorbBackForwardIfNeeded(saved) {
    const type = navigationType();
    if (type !== "back_forward") {
      rememberUrl(location.href);
      return;
    }
    const stack = Array.isArray(saved.navStack) ? saved.navStack.slice() : [];
    let index = Number.isFinite(saved.navIndex) ? saved.navIndex : Math.max(0, stack.length - 1);
    const url = location.href;
    let direction = "back";
    const found = stack.lastIndexOf(url);
    if (found >= 0 && found < index) {
      direction = "back";
      index = found;
    } else if (found > index) {
      direction = "forward";
      index = found;
    } else if (found === index && found >= 0) {
      direction = "back";
    } else {
      // URL not in stack yet — still a back/forward load; default to back and place URL
      direction = "back";
      const insertAt = Math.max(0, index);
      stack.splice(insertAt, 0, url);
      index = insertAt;
    }

    draft.navStack = stack.slice(-40);
    draft.navIndex = Math.max(0, Math.min(draft.navStack.length - 1, index));
    const last = recorded[recorded.length - 1];
    if (!(last && last.kind === "history" && last.direction === direction)) {
      recorded.push({ kind: "history", direction, at: Date.now() });
    }
    persist(true);
  }

  function onPageHide() {
    if (!draft || !recording) return;
    draft.lastUrl = location.href;
    draft.lastHistoryLength = history.length;
    persist(true);
  }

  let lastEnterAt = 0;
  function onClick(e) {
    if (!e.isTrusted || isPill(e) || !(e.target instanceof Element)) return;
    // Pressing Enter in a field makes the browser "click" the form's submit button; that is already covered by the Enter step.
    if (e.detail === 0 && Date.now() - lastEnterAt < 200 && e.target.closest("button,input[type=submit]")) return;
    let node = e.target.closest(INTERACTIVE + ",label");
    if (node && node.tagName === "LABEL") node = node.control || null;
    if (!node) {
      let walk = e.target;
      for (let i = 0; i < 4 && walk && walk !== document.body; i++, walk = walk.parentElement) {
        if (getComputedStyle(walk).cursor === "pointer") { node = walk; break; }
      }
    }
    if (!node) return;
    if (node.matches("textarea,select") || (node.matches("input") && !/^(button|submit|checkbox|radio)$/i.test(node.type))) return; // typing is captured by input events
    const target = describe(node, "click");
    if (!target) { skip(); return; }
    add({ kind: "click", target, at: Date.now() });
  }
  function onInput(e) {
    if (!e.isTrusted || isPill(e) || !(e.target instanceof Element) || !e.target.matches("input,textarea")) return;
    const target = describe(e.target, "input");
    if (!target) { skip(); return; }
    const action = { kind: "input", target, value: e.target.value, at: Date.now() };
    if (target.isPassword) action.isPassword = true;
    add(action);
  }
  function onChange(e) {
    if (!e.isTrusted || isPill(e) || !(e.target instanceof Element) || !e.target.matches("select")) return;
    const target = describe(e.target, "change");
    if (!target) { skip(); return; }
    add({ kind: "change", target, value: e.target.value, at: Date.now() });
  }
  function onKey(e) {
    if (!e.isTrusted || e.key !== "Enter" || isPill(e) || !(e.target instanceof Element) || !e.target.matches("input")) return;
    lastEnterAt = Date.now();
    const form = e.target.form;
    if (form && !safeSubmit(e.target)) { skip(); return; }
    const target = describe(e.target, "input");
    if (!target) { skip(); return; }
    add({ kind: "enter", target, at: Date.now() });
  }
  function onScroll(e) {
    if (!e.isTrusted || (e.target !== document && e.target !== window)) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => add({ kind: "scroll", x: Math.round(scrollX), y: Math.round(scrollY), at: Date.now() }), 220);
  }

  function attach() {
    detach();
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); handlers.push([target, type, fn, opts]); };
    on(document, "click", onClick, true);
    on(document, "input", onInput, true);
    on(document, "change", onChange, true);
    on(document, "keydown", onKey, true);
    on(window, "scroll", onScroll, { capture: true, passive: true });
    on(window, "pagehide", onPageHide, true);
    on(window, "popstate", onPopState, true);
    // Hash-only changes also fire hashchange; treat like popstate for SPA sites
    on(window, "hashchange", onPopState, true);
  }
  function detach() {
    handlers.forEach(([target, type, fn, opts]) => target.removeEventListener(type, fn, opts));
    handlers.length = 0;
  }

  function startRecording(message) {
    if (recording) return { ok: true, detail: "Already recording." };
    if (!policy.recordableUrl(location.href)) return fail("Recording works on http(s) pages without a username or password in the address.");
    recorded = [];
    draft = {
      origin: location.origin, startUrl: location.href, tabId: message.tabId,
      recording: true, startedAt: Date.now(), skipped: 0, actions: [],
      navStack: [location.href], navIndex: 0, lastUrl: location.href
    };
    recording = true;
    attach();
    persist(true);
    return { ok: true, detail: "Recording started." };
  }
  function resumeRecording(saved) {
    recorded = Array.isArray(saved.actions) ? saved.actions.slice() : [];
    draft = { ...saved, recording: true };
    if (!Array.isArray(draft.navStack)) draft.navStack = [location.href];
    if (!Number.isFinite(draft.navIndex)) draft.navIndex = draft.navStack.length - 1;
    recording = true;
    attach();
    // Detect browser Back / Forward that caused this document load
    absorbBackForwardIfNeeded(saved);
    persist(true);
  }
  function stopRecording() {
    clearTimeout(scrollTimer);
    if (recording && scrollTimer === null) { /* nothing pending */ }
    recording = false;
    detach();
    if (draft) { draft.recording = false; draft.stoppedAt = Date.now(); }
    persist(true);
    const count = recorded.length;
    pill("done", count ? `Saved ${count} step${count === 1 ? "" : "s"}. Open the extension to name it.` : "Nothing recorded yet.", null);
    hidePill(4500);
    return { ok: true, actions: recorded.slice(), detail: `Recording stopped (${count} steps).` };
  }

  /* ---------- replay ---------- */
  function locate(target) {
    const text = (target.text || "").toLowerCase();
    const fits = el => !text || labelOf(el).toLowerCase().includes(text) || (labelOf(el) && text.includes(labelOf(el).toLowerCase()));
    let bySelector = [];
    try { bySelector = [...document.querySelectorAll(target.selector)].filter(el => el.tagName.toLowerCase() === target.tag); } catch (_) { /* bad selector */ }
    if (bySelector.length === 1 && isVisible(bySelector[0], true) && fits(bySelector[0])) return bySelector[0];

    const pool = [...document.getElementsByTagName(target.tag)].filter(el => isVisible(el, true) && (el.type || "") === (target.type || ""));
    if (text) {
      const exact = pool.filter(el => labelOf(el).toLowerCase() === text);
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return exact.find(el => bySelector.includes(el)) || null;
      const contains = pool.filter(el => labelOf(el).toLowerCase().includes(text));
      if (contains.length === 1) return contains[0];
    } else if (bySelector.length === 1) return bySelector[0];
    return null;
  }

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const found = fn();
      if (found || Date.now() > end) return found;
      await sleep(150);
    }
  }

  function setValue(el, value) {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function resolvePasswordValue(action) {
    // Prefer an explicit value recorded in the step; otherwise look up the saved vault entry.
    if (typeof action.value === "string" && action.value.length) return action.value;
    if (action.passwordId) {
      try {
        const { savedPasswords } = await chrome.storage.local.get({ savedPasswords: [] });
        const entry = (savedPasswords || []).find(p => p.id === action.passwordId);
        if (entry && typeof entry.password === "string") return entry.password;
      } catch (_) { /* storage unavailable */ }
    }
    return action.value || "";
  }

  async function replay(action, origin) {
    if (recording) return fail("Stop recording before replaying.");
    if (!origin || !policy.pageUrl(location.href, origin) || !policy.validAction(action)) return fail("This page is outside the recorded site, so the step was skipped.");
    if (action.kind === "scroll") { window.scrollTo(action.x, action.y); return { ok: true }; }
    if (action.kind === "history") {
      const before = location.href;
      return await new Promise(resolve => {
        let settled = false;
        let check, timeout;
        const onNavigate = () => finish(location.href !== before);
        const finish = changed => {
          if (settled) return;
          settled = true;
          removeEventListener("popstate", onNavigate, true);
          removeEventListener("hashchange", onNavigate, true);
          removeEventListener("pageshow", onNavigate, true);
          clearInterval(check); clearTimeout(timeout);
          resolve(!policy.pageUrl(location.href, origin)
            ? fail("History navigation left the recorded site.")
            : changed ? { ok: true } : fail("History navigation did not complete."));
        };
        addEventListener("popstate", onNavigate, true);
        addEventListener("hashchange", onNavigate, true);
        addEventListener("pageshow", onNavigate, true);
        check = setInterval(() => { if (location.href !== before) finish(true); }, 100);
        timeout = setTimeout(() => finish(false), 8000);
        try { action.direction === "back" ? history.back() : history.forward(); } catch (_) { finish(false); }
      });
    }

    const el = await waitFor(() => locate(action.target), 5000);
    if (!el) return fail(`Couldn't find “${action.target.text || action.target.tag}” on the page.`);
    if (blocked(el, action.kind === "enter" ? "input" : action.kind)) return fail("Replay skipped a sensitive control.");
    el.scrollIntoView({ block: "center", inline: "nearest" });

    if (action.kind === "click") {
      // Answer first: a click may navigate away and close the message channel.
      setTimeout(() => {
        for (const type of ["mousedown", "mouseup"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        el.click();
      }, 40);
      return { ok: true };
    }
    if (action.kind === "input" || action.kind === "change") {
      const value = (action.isPassword || action.target?.isPassword || action.passwordId)
        ? await resolvePasswordValue(action)
        : (action.value || "");
      setValue(el, value);
      return { ok: true };
    }
    if (action.kind === "enter") {
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.focus();
      const down = el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      const form = el.form;
      if (down && form && safeSubmit(el)) setTimeout(() => { try { form.requestSubmit(); } catch (_) { /* no submit button */ } }, 40);
      return { ok: true };
    }
    return fail("Unsupported step.");
  }

  /* ---------- messages ---------- */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "ping": sendResponse({ ok: true, recording }); return;
      case "startRecording": sendResponse(startRecording(message)); return;
      case "stopRecording": sendResponse(recording ? stopRecording() : { ok: true, actions: recorded.slice() }); return;
      case "replayAction": replay(message.action, message.origin).then(sendResponse); return true;
      case "runProgress":
        progressBar({
          text: message.text,
          percent: message.percent,
          loop: message.loop,
          loops: message.loops,
          step: message.step,
          steps: message.steps,
          unlimited: message.unlimited,
          name: message.name
        });
        sendResponse({ ok: true });
        return;
      case "routineFinished":
        // Brief success state on the bar, then clear — no full-screen overlay
        progressBar({ text: message.text || "Done", percent: 100, name: "" });
        setTimeout(() => hidePill(0), 1200);
        sendResponse({ ok: true });
        return;
      default: return;
    }
  });

  /* ---------- keep recording across page loads ---------- */
  (async function resume() {
    try {
      const [who, data] = await Promise.all([
        chrome.runtime.sendMessage({ type: "whoami" }),
        chrome.storage.local.get({ recordingDraft: null })
      ]);
      const saved = data.recordingDraft;
      if (!saved?.recording || saved.tabId !== who?.tabId) return;
      if (saved.origin === location.origin && policy.recordableUrl(location.href)) resumeRecording(saved);
      else chrome.storage.local.set({ recordingDraft: { ...saved, recording: false, stoppedAt: Date.now(), note: "Recording stopped because the tab moved to another site." } });
    } catch (_) { /* not ready */ }
  })();
})();

/* Captcha detection and solving moved to content/captcha-frame.js (runs in every frame). */
