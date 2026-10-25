/**
 * MeMik captcha module. Runs in EVERY frame (manifest all_frames), because captchas live in iframes:
 *   page frame        finds widgets + sitekeys, fills response tokens
 *   reCAPTCHA anchor  the "I'm not a robot" checkbox frame
 *   reCAPTCHA bframe  the challenge frame: audio solver button + audio solving
 *   hCaptcha / Turnstile frames are reported only.
 * The audio-challenge technique (switch to audio, speech-to-text, type the answer) follows the approach used by
 * the Buster extension; this is an independent implementation.
 */
(function () {
  "use strict";
  if (window.__memikCaptchaFrame) return;
  window.__memikCaptchaFrame = true;

  const OUT = "memik:captcha-info", IN = "memik:captcha-cmd";
  const host = (location.hostname || "").toLowerCase();
  const path = location.pathname || "";
  const isGoogleHost = /(^|\.)(google\.[a-z.]+|recaptcha\.net)$/.test(host);

  let role = "page";
  if (isGoogleHost && /\/recaptcha\/(api2|enterprise)\/anchor/.test(path)) role = "anchor";
  else if (isGoogleHost && /\/recaptcha\/(api2|enterprise)\/bframe/.test(path)) role = "challenge";
  else if (/(^|\.)hcaptcha\.com$/.test(host) && /\/captcha\//.test(path)) role = "hcaptcha-frame";
  else if (host === "challenges.cloudflare.com") role = "turnstile-frame";

  // Cloudflare's own challenge pages are left completely alone.
  if (host === "challenges.cloudflare.com" || /\/cdn-cgi\/challenge-platform\//.test(path)) role = "turnstile-frame";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const visible = el => {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    } catch (_) {}
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const send = msg => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch (_) { return Promise.resolve(null); } };

  /* ================= page-world info (sitekeys of JS-rendered widgets) ================= */
  let mainInfo = { recaptcha: [], hcaptcha: false, turnstile: false, enterprise: false };
  document.addEventListener(OUT, ev => { try { mainInfo = JSON.parse(ev.detail); } catch (_) {} });
  function askMain(cmd) { try { document.dispatchEvent(new CustomEvent(IN, { detail: JSON.stringify(cmd) })); } catch (_) {} }

  /* ================= detection ================= */
  function param(url, name) {
    try {
      const u = new URL(url, location.href);
      const v = u.searchParams.get(name);
      if (v) return v;
      const h = new URLSearchParams(u.hash.replace(/^#/, "").replace(/&amp;/g, "&"));
      return h.get(name) || "";
    } catch (_) { return ""; }
  }

  function findsInPage() {
    const finds = [];
    const seen = new Set();
    const add = f => {
      const key = [f.type, f.sitekey || "", f.kind || ""].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      finds.push(f);
    };

    // iframes loaded by the widgets themselves
    for (const fr of qa("iframe[src]")) {
      const src = fr.getAttribute("src") || "";
      let m;
      if (/\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/.test(src) && /(google\.|recaptcha\.net)/.test(src)) {
        const enterprise = /\/recaptcha\/enterprise\//.test(src);
        const size = param(src, "size");
        add({ type: enterprise ? "reCAPTCHA Enterprise" : "reCAPTCHA v2", sitekey: param(src, "k"), size, kind: /bframe/.test(src) ? "challenge" : "widget", visible: visible(fr), invisible: size === "invisible" });
      } else if (/hcaptcha\.com\/captcha/.test(src)) {
        add({ type: "hCaptcha", sitekey: param(src, "sitekey"), kind: "widget", visible: visible(fr) });
      } else if (/challenges\.cloudflare\.com/.test(src) && (m = /\/(0x[0-9A-Za-z_-]{10,})(?:\/|$)/.exec(src))) {
        add({ type: "Cloudflare Turnstile", sitekey: m[1], kind: "widget", visible: visible(fr) });
      } else if (/arkoselabs\.com|funcaptcha\.com/.test(src)) {
        add({ type: "Arkose Labs", sitekey: param(src, "pk"), kind: "widget", visible: visible(fr) });
      } else if (/geetest\.com/.test(src)) {
        add({ type: "GeeTest", sitekey: "", kind: "widget", visible: visible(fr) });
      }
    }

    // markup the site wrote itself
    for (const el of qa("[data-sitekey]")) {
      const key = el.getAttribute("data-sitekey") || "";
      if (key.length < 10) continue;
      const cls = ((el.className && el.className.toString()) || "") + " " + (el.id || "");
      let type = "reCAPTCHA v2";
      if (/h-captcha|hcaptcha/i.test(cls)) type = "hCaptcha";
      else if (/cf-turnstile|turnstile/i.test(cls) || /^0x[0-9A-Za-z_-]{10,}$/.test(key)) type = "Cloudflare Turnstile";
      else if (/enterprise/i.test(cls)) type = "reCAPTCHA Enterprise";
      add({ type, sitekey: key, size: el.getAttribute("data-size") || "", action: el.getAttribute("data-action") || "", kind: "widget", visible: visible(el), invisible: (el.getAttribute("data-size") || "") === "invisible" });
    }
    if (qa(".g-recaptcha, #g-recaptcha, .grecaptcha-badge").length && !finds.some(f => /reCAPTCHA/.test(f.type)) && !mainInfo.recaptcha.length) {
      add({ type: "reCAPTCHA v2", sitekey: "", kind: "widget", visible: true });
    }

    // reCAPTCHA v3 / explicit loader: <script src=".../api.js?render=SITEKEY">
    for (const s of qa("script[src*='recaptcha']")) {
      const src = s.getAttribute("src") || "";
      const render = param(src, "render");
      if (render && render !== "explicit" && render.length > 10) {
        add({ type: /\/enterprise\.js/.test(src) ? "reCAPTCHA Enterprise" : "reCAPTCHA v3", sitekey: render, kind: "script", visible: false, invisible: true });
      }
    }
    if (qa("script[src*='hcaptcha.com']").length && !finds.some(f => f.type === "hCaptcha")) add({ type: "hCaptcha", sitekey: "", kind: "script", visible: false });
    if (qa("script[src*='challenges.cloudflare.com/turnstile']").length && !finds.some(f => f.type === "Cloudflare Turnstile")) add({ type: "Cloudflare Turnstile", sitekey: "", kind: "script", visible: false });

    // sitekeys found in the page world (grecaptcha.render(...) etc.)
    for (const r of mainInfo.recaptcha || []) {
      if (!/^6L[0-9A-Za-z_-]{20,}$/.test(r.sitekey)) continue;
      add({ type: mainInfo.enterprise ? "reCAPTCHA Enterprise" : "reCAPTCHA v2", sitekey: r.sitekey, size: r.size, kind: "widget", visible: true, invisible: r.size === "invisible", hasCallback: r.hasCallback });
    }

    // other vendors, by their DOM hooks (attributes only; never page text)
    if (qa("[class*='geetest_'], .geetest_holder, [id^='geetest']").length) add({ type: "GeeTest", sitekey: "", kind: "widget", visible: true });
    if (qa(".frc-captcha, [class*='friendly-captcha']").length) add({ type: "Friendly Captcha", sitekey: (q(".frc-captcha") || {}).getAttribute ? (q(".frc-captcha").getAttribute("data-sitekey") || "") : "", kind: "widget", visible: true });
    if (qa("#aws-waf-captcha, [id*='awswaf']").length) add({ type: "AWS WAF", sitekey: "", kind: "widget", visible: true });
    return finds;
  }

  function describe() {
    const base = { role, url: location.href, top: window === window.top };
    if (role === "anchor") {
      const checked = (q("#recaptcha-anchor") || {}).getAttribute ? q("#recaptcha-anchor").getAttribute("aria-checked") === "true" : false;
      const k = param(location.href, "k");
      const enterprise = /\/recaptcha\/enterprise\//.test(path);
      return { ...base, finds: [{ type: enterprise ? "reCAPTCHA Enterprise" : "reCAPTCHA v2", sitekey: k, kind: "anchor", visible: true, checked }] };
    }
    if (role === "challenge") {
      return { ...base, finds: [{ type: /\/recaptcha\/enterprise\//.test(path) ? "reCAPTCHA Enterprise" : "reCAPTCHA v2", sitekey: param(location.href, "k"), kind: "challenge", visible: visible(document.body) && (document.body.offsetHeight > 0), audio: !!q("#recaptcha-audio-button"), blocked: visible(q(".rc-doscaptcha-body")) }] };
    }
    if (role === "hcaptcha-frame") return { ...base, finds: [{ type: "hCaptcha", sitekey: param(location.href, "sitekey"), kind: "frame", visible: true }] };
    if (role === "turnstile-frame") return { ...base, finds: [] };
    return { ...base, finds: findsInPage() };
  }

  /* ================= response tokens ================= */
  const RESPONSE_SEL = "textarea[name='g-recaptcha-response'], #g-recaptcha-response, textarea.g-recaptcha-response, [name='h-captcha-response'], textarea[name='h-captcha-response'], [name='cf-turnstile-response'], input[name='cf-turnstile-response']";
  function readToken() {
    for (const el of qa(RESPONSE_SEL)) { const v = (el.value || el.textContent || "").trim(); if (v.length > 20) return v; }
    return "";
  }
  function setNativeValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
    } catch (_) { el.value = value; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function injectToken(token) {
    let filled = 0;
    qa(RESPONSE_SEL).forEach(el => { try { setNativeValue(el, token); try { el.textContent = token; } catch (_) {} filled++; } catch (_) {} });
    if (!filled && window === window.top) {
      const form = q("form");
      if (form) { const ta = document.createElement("textarea"); ta.name = "g-recaptcha-response"; ta.id = "g-recaptcha-response"; ta.style.display = "none"; ta.value = token; form.appendChild(ta); filled++; }
    }
    askMain({ cmd: "token", token });
    return filled;
  }

  /* ================= reCAPTCHA audio solver (challenge frame) ================= */
  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function until(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 150); }
  }

  const BLOCKED_MSG = "Google is showing “Try again later” for this connection (it detected automated traffic). Wait a while or switch server, then try again.";

  async function solveAudioOnce() {
    if (role !== "challenge") return { ok: false, phase: "not-challenge", error: "This is not a reCAPTCHA challenge frame." };
    if (visible(q(".rc-doscaptcha-body"))) return { ok: false, phase: "blocked", error: BLOCKED_MSG };

    // 1. make sure the audio challenge is showing
    let audioEl = q("audio#audio-source");
    const input = () => q("#audio-response");
    if (!audioEl || !visible(input())) {
      const btn = q("#recaptcha-audio-button");
      if (!btn) return { ok: false, phase: "no-audio", error: "This challenge has no audio option." };
      await sleep(jitter(250, 650));
      btn.click();
      const ready = await until(() => (q("audio#audio-source") && q("audio#audio-source").src && visible(input())) || visible(q(".rc-doscaptcha-body")), 12000);
      if (visible(q(".rc-doscaptcha-body"))) return { ok: false, phase: "blocked", error: BLOCKED_MSG };
      if (!ready) return { ok: false, phase: "no-audio", error: "The audio challenge did not load." };
      audioEl = q("audio#audio-source");
    }

    // 2. wait for a NEW audio clip after a wrong answer (the old one is still in the page for a moment)
    let src = audioEl.src || (q(".rc-audiochallenge-tdownload-link") || {}).href || "";
    if (src && src === window.__memikLastAudio) {
      const changed = await until(() => { const s = (q("audio#audio-source") || {}).src; return s && s !== window.__memikLastAudio ? s : null; }, 3500);
      if (changed) src = changed;
      else { const r = q("#recaptcha-reload-button"); if (r) { r.click(); const s2 = await until(() => { const s = (q("audio#audio-source") || {}).src; return s && s !== window.__memikLastAudio ? s : null; }, 8000); if (s2) src = s2; } }
    }
    if (!src) return { ok: false, phase: "no-src", error: "The audio clip has no address." };
    window.__memikLastAudio = src;

    // 3. fetch the clip from inside the frame (same origin as Google, so it works like a normal player would)
    let audioB64 = "", mime = "";
    try {
      const res = await fetch(src, { credentials: "include" });
      if (!res.ok) return { ok: false, phase: "audio-fetch", error: `Could not download the audio (HTTP ${res.status}).` };
      mime = res.headers.get("content-type") || "";
      if (/text\/html/i.test(mime)) return { ok: false, phase: "blocked", error: BLOCKED_MSG };
      audioB64 = toBase64(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, phase: "audio-fetch", error: "Could not download the audio: " + (e && e.message || e) };
    }

    // 4. speech to text (done by the extension background)
    const reply = await send({ type: "captchaTranscribe", audio: audioB64, mime });
    if (!reply || !reply.ok) return { ok: false, phase: "stt-error", error: (reply && reply.error) || "Speech recognition failed." };
    const text = String(reply.text || "").trim();
    if (!text) {
      const r = q("#recaptcha-reload-button"); if (r) r.click();
      return { ok: false, phase: "empty", error: "No speech was recognised in the clip. Requested a new one." };
    }

    // 5. type the answer and verify
    const field = input();
    if (!field) return { ok: false, phase: "no-input", error: "The answer box is missing." };
    field.focus();
    setNativeValue(field, text);
    await sleep(jitter(350, 900));
    const verify = q("#recaptcha-verify-button");
    if (!verify) return { ok: false, phase: "no-verify", error: "The Verify button is missing." };
    verify.click();
    return { ok: true, phase: "submitted", text };
  }

  function addSolverButton() {
    if (role !== "challenge" || q("#memik-solve-btn")) return;
    const btn = document.createElement("button");
    btn.id = "memik-solve-btn";
    btn.type = "button";
    btn.title = "Solve this challenge with MeMik (audio)";
    btn.setAttribute("aria-label", "Solve with MeMik");
    btn.textContent = "Solve";
    btn.style.cssText = "all:initial;font:600 12px/1 system-ui,sans-serif;cursor:pointer;color:#fff;background:#4687ff;padding:7px 12px;border-radius:999px;margin:0 6px;display:inline-block;box-shadow:0 1px 3px rgba(0,0,0,.3)";
    btn.addEventListener("click", async () => {
      btn.textContent = "Solving…"; btn.disabled = true;
      const r = await send({ type: "captchaSolveFromFrame" });
      btn.textContent = r && r.ok ? "Solved ✓" : "Retry";
      btn.title = (r && (r.error || (r.ok ? "Solved" : ""))) || btn.title;
      btn.disabled = false;
    });
    const holder = q(".help-button-holder") || q("#recaptcha-help-button") || q(".rc-footer");
    if (holder) holder.appendChild(btn);
    else { btn.style.position = "fixed"; btn.style.left = "8px"; btn.style.bottom = "8px"; btn.style.zIndex = "2147483647"; (document.body || document.documentElement).appendChild(btn); }
  }

  let autoStarted = false;
  async function maybeAutoSolve() {
    if (role !== "challenge" || autoStarted) return;
    let cfg;
    try { cfg = await chrome.storage.local.get({ captchaAuto: false, captchaWitToken: "" }); } catch (_) { return; }
    if (!cfg.captchaAuto || !cfg.captchaWitToken) return;
    autoStarted = true;
    await sleep(jitter(1200, 2600));
    send({ type: "captchaSolveFromFrame", auto: true });
  }

  /* ================= messages ================= */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "captchaPing": sendResponse({ ok: true, role }); return;
      case "captchaRescan": askMain({ cmd: "scan" }); setTimeout(() => sendResponse({ ok: true, ...describe() }), 120); return true;
      case "captchaClickCheckbox": {
        if (role !== "anchor") { sendResponse({ ok: false }); return; }
        const box = q(".recaptcha-checkbox-border") || q("#recaptcha-anchor");
        if (box) { box.click(); sendResponse({ ok: true }); } else sendResponse({ ok: false });
        return;
      }
      case "captchaAnchorState": {
        const el = q("#recaptcha-anchor");
        sendResponse({ ok: true, role, checked: !!el && el.getAttribute("aria-checked") === "true" });
        return;
      }
      case "captchaSolveAudioOnce": solveAudioOnce().then(sendResponse, e => sendResponse({ ok: false, phase: "error", error: String(e && e.message || e) })); return true;
      case "captchaReadToken": sendResponse({ ok: true, token: readToken() }); return;
      case "captchaInjectToken": sendResponse({ ok: true, filled: injectToken(String(msg.token || "")) }); return;
      case "captchaFocus": {
        const el = q("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare.com'], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]");
        if (el) { try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }
        sendResponse({ ok: !!el });
        return;
      }
    }
  });

  /* ================= start ================= */
  if (role === "challenge") {
    chrome.storage.local.get({ captchaAssistEnabled: true }).then(cfg => {
      if (cfg.captchaAssistEnabled === false) return;
      addSolverButton();
      new MutationObserver(() => addSolverButton()).observe(document.documentElement, { childList: true, subtree: true });
      maybeAutoSolve();
    }).catch(() => {});
  }
})();
