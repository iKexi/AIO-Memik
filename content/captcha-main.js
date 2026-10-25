/**
 * MeMik captcha helper, page world (manifest "world": "MAIN").
 * A content script's isolated world cannot see window.___grecaptcha_cfg, window.hcaptcha or window.turnstile,
 * which is where sites that render widgets from JavaScript keep their sitekeys and callbacks.
 * Talks to content/captcha-frame.js through CustomEvents carrying JSON strings.
 */
(function () {
  "use strict";
  if (window.__memikCaptchaMain) return;
  window.__memikCaptchaMain = true;
  var OUT = "memik:captcha-info", IN = "memik:captcha-cmd";

  function walk(obj, visit, depth, seen) {
    if (!obj || typeof obj !== "object" || depth > 7) return;
    if (seen.has(obj)) return;
    seen.add(obj);
    var keys;
    try { keys = Object.keys(obj); } catch (e) { return; }
    visit(obj);
    for (var i = 0; i < keys.length && i < 60; i++) {
      var v;
      try { v = obj[keys[i]]; } catch (e) { continue; }
      if (v && typeof v === "object") walk(v, visit, depth + 1, seen);
    }
  }

  function collect() {
    var out = { recaptcha: [], hcaptcha: false, turnstile: false, enterprise: false };
    try {
      var cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        var seen = new WeakSet();
        walk(cfg.clients, function (o) {
          var key = null;
          try { key = typeof o.sitekey === "string" ? o.sitekey : (typeof o.siteKey === "string" ? o.siteKey : null); } catch (e) {}
          if (key && key.length > 10) {
            var cb = false, size = "";
            try { cb = typeof o.callback === "function" || typeof o.callback === "string"; } catch (e) {}
            try { size = typeof o.size === "string" ? o.size : ""; } catch (e) {}
            out.recaptcha.push({ sitekey: key, size: size, hasCallback: cb });
          }
        }, 0, seen);
      }
    } catch (e) {}
    try { if (window.grecaptcha && window.grecaptcha.enterprise) out.enterprise = true; } catch (e) {}
    try { if (window.hcaptcha) out.hcaptcha = true; } catch (e) {}
    try { if (window.turnstile) out.turnstile = true; } catch (e) {}
    return out;
  }

  function publish() {
    try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(collect()) })); } catch (e) {}
  }

  // After a token is obtained, run the page's own "captcha solved" callback so the site proceeds.
  function runCallbacks(token) {
    var called = 0;
    try {
      var cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        var seen = new WeakSet();
        walk(cfg.clients, function (o) {
          var cb;
          try { cb = o.callback; } catch (e) { return; }
          try {
            if (typeof cb === "function") { cb(token); called++; }
            else if (typeof cb === "string" && typeof window[cb] === "function") { window[cb](token); called++; }
          } catch (e) {}
        }, 0, seen);
      }
    } catch (e) {}
    try {
      document.querySelectorAll("[data-callback]").forEach(function (el) {
        var name = el.getAttribute("data-callback");
        try { if (name && typeof window[name] === "function") { window[name](token); called++; } } catch (e) {}
      });
    } catch (e) {}
    return called;
  }

  document.addEventListener(IN, function (ev) {
    var cmd;
    try { cmd = JSON.parse(ev.detail); } catch (e) { return; }
    if (cmd && cmd.cmd === "scan") publish();
    else if (cmd && cmd.cmd === "token") {
      var n = runCallbacks(String(cmd.token || ""));
      try { document.dispatchEvent(new CustomEvent(OUT + "-token", { detail: JSON.stringify({ called: n }) })); } catch (e) {}
    }
  });

  [0, 700, 1800, 4000, 8000].forEach(function (ms) { setTimeout(publish, ms); });
})();
