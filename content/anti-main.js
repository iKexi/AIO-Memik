/**
 * MeMik anti-adblock page-world script (manifest "world": "MAIN").
 * Loaded by the browser as a real extension file, so it is never blocked by a
 * page's Content-Security-Policy (the old inline <script> injection was).
 * Activated/deactivated by adblock-page.js through a "memik:anti" CustomEvent.
 */
(function () {
  "use strict";
  if (window.__memikAntiLoader) return;
  window.__memikAntiLoader = true;
  try {
    var h = location.hostname || "";
    var path = location.pathname || "";
    if (/(?:^|\.)challenges\.cloudflare\.com$/i.test(h) ||
        (/cloudflare\.com$/i.test(h) && path.indexOf("/cdn-cgi/") !== -1) ||
        path.indexOf("/cdn-cgi/challenge-platform/") !== -1) {
      return;
    }
  } catch (e) {}

  var started = false;
  function start() {
    if (started) return;
    started = true;
    if (window.__memikAntiMain) return;
    window.__memikAntiMain = true;

    // --- Fake popup success (no real popup) ---
    function fakeWin() {
      var closed = false;
      var w = {
        closed: false,
        opener: window,
        focus: function () {},
        blur: function () {},
        close: function () { closed = true; w.closed = true; },
        open: function () { return fakeWin(); },
        postMessage: function () {},
        location: {
          href: "about:blank",
          replace: function () {},
          assign: function () {},
          reload: function () {}
        },
        document: {
          write: function () {},
          writeln: function () {},
          close: function () {},
          open: function () {},
          body: null,
          documentElement: null
        },
        screen: window.screen,
        innerWidth: 800,
        innerHeight: 600
      };
      try {
        Object.defineProperty(w, "closed", {
          get: function () { return closed; },
          set: function (v) { closed = !!v; }
        });
      } catch (e) {}
      // auto-mark closed shortly so site thinks user closed the pop under
      setTimeout(function () { try { w.close(); } catch (e) {} }, 1200);
      return w;
    }

    try {
      window.open = function (url, name, specs) {
        // Pretend popup worked — do not open a real window
        return fakeWin();
      };
    } catch (e) {}

    // Detectors that check window.open === native still fail sometimes; also patch showModalDialog
    try { window.showModalDialog = function () { return true; }; } catch (e) {}

    // --- FuckAdBlock family ---
    function FakeAdBlock() {
      this.version = "3.2.1";
      this.checking = false;
    }
    FakeAdBlock.prototype.setOption = function () { return this; };
    FakeAdBlock.prototype.check = function (cb) {
      if (typeof cb === "function") setTimeout(function () { cb(false); }, 1);
      return this;
    };
    FakeAdBlock.prototype.on = function (ev, cb) {
      if ((ev === "notDetected" || ev === "not-detected") && typeof cb === "function") setTimeout(cb, 1);
      return this;
    };
    FakeAdBlock.prototype.onDetected = function () { return this; };
    FakeAdBlock.prototype.onNotDetected = function (cb) {
      if (typeof cb === "function") setTimeout(cb, 1);
      return this;
    };
    var fab = new FakeAdBlock();
    try {
      window.FuckAdBlock = FakeAdBlock;
      window.BlockAdBlock = FakeAdBlock;
      window.SniffAdBlock = FakeAdBlock;
      window.fuckAdBlock = fab;
      window.blockAdBlock = fab;
      window.sniffAdBlock = fab;
    } catch (e) {}

    try {
      window.adblock = false;
      window.adblocker = false;
      window.canRunAds = true;
      window.isAdBlockActive = false;
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.loaded = true;
      window.google_ad_status = 1;
    } catch (e) {}

    // Bait with non-zero size
    function ensureBait() {
      try {
        var id = "adsbox_bait_memik";
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.className = "ads ad adsbox doubleclick ad-placement carbon-ads pub_300x250";
          el.textContent = "\u00a0";
          el.style.cssText = "width:1px!important;height:1px!important;position:absolute!important;left:-10000px!important;top:-1000px!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;";
          (document.documentElement || document.body).appendChild(el);
        }
        try {
          Object.defineProperty(el, "offsetHeight", { get: function () { return 1; } });
          Object.defineProperty(el, "offsetWidth", { get: function () { return 1; } });
          Object.defineProperty(el, "clientHeight", { get: function () { return 1; } });
          Object.defineProperty(el, "clientWidth", { get: function () { return 1; } });
          el.getBoundingClientRect = function () {
            return { width: 1, height: 1, top: -1000, left: -10000, bottom: -999, right: -9999, x: 0, y: 0, toJSON: function () { return {}; } };
          };
        } catch (e) {}
      } catch (e) {}
    }

    var WALL_RE = /disable\s*adblock|adblock\s*detected|please\s*disable|allow\s*pop-?up|click\s*allow\s*pop/i;

    function scrubWalls() {
      try {
        var nodes = document.querySelectorAll("div,section,aside,span,p,h1,h2,h3,h4,button,a");
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var t = "";
          try { t = (n.innerText || n.textContent || "").trim(); } catch (e) { continue; }
          if (!t || t.length > 280) continue;
          if (!WALL_RE.test(t)) continue;
          // Hide the wall node and a few parents that act as overlays
          var cur = n;
          for (var d = 0; d < 4 && cur && cur !== document.body; d++) {
            try {
              cur.style.setProperty("display", "none", "important");
              cur.style.setProperty("visibility", "hidden", "important");
              cur.style.setProperty("pointer-events", "none", "important");
              cur.style.setProperty("opacity", "0", "important");
            } catch (e) {}
            cur = cur.parentElement;
          }
        }
        try {
          document.documentElement.style.removeProperty("overflow");
          if (document.body) {
            document.body.style.removeProperty("overflow");
            document.body.style.removeProperty("position");
          }
        } catch (e) {}
      } catch (e) {}
    }

    // If site replaces player HTML with the wall, try to keep video containers clickable
    function unlockPlayer() {
      try {
        document.querySelectorAll(".videoplayer, .videoplayer-embed, [class*='player'], video, iframe").forEach(function (el) {
          try {
            el.style.removeProperty("pointer-events");
            el.style.setProperty("pointer-events", "auto", "important");
          } catch (e) {}
        });
      } catch (e) {}
    }

    ensureBait();
    scrubWalls();
    unlockPlayer();

    try {
      var mo = new MutationObserver(function () {
        ensureBait();
        scrubWalls();
        unlockPlayer();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {}

    setInterval(function () {
      scrubWalls();
      unlockPlayer();
    }, 800);
    // --- Bait requests: pretend ad hosts are reachable so "adblock detected" checks pass ---
    var AD_HOST_RE = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.[a-z.]+|adnxs\.com|amazon-adsystem\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|pubmatic\.com|rubiconproject\.com|openx\.net|adsterra\.com|exoclick\.com|popads\.net|propellerads\.com|ads\.[a-z0-9-]+\.[a-z.]+|adserver\.[a-z0-9-]+\.[a-z.]+)$/i;
    function isAdUrl(u) {
      try { return AD_HOST_RE.test(new URL(String(u), location.href).hostname); } catch (e) { return false; }
    }
    try {
      var realFetch = window.fetch;
      if (typeof realFetch === "function") {
        window.fetch = function (input, init) {
          var u = (input && input.url) || input;
          var p = realFetch.apply(this, arguments);
          if (!isAdUrl(u)) return p;
          return p.catch(function () {
            try { return new Response("", { status: 200, statusText: "OK" }); } catch (e) { throw e; }
          });
        };
      }
    } catch (e) {}
    try {
      var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__memikAd = isAdUrl(u); return XO.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var x = this;
        if (x.__memikAd) {
          x.addEventListener("error", function () {
            try {
              Object.defineProperty(x, "status", { get: function () { return 200; } });
              Object.defineProperty(x, "readyState", { get: function () { return 4; } });
              Object.defineProperty(x, "responseText", { get: function () { return ""; } });
              if (typeof x.onload === "function") x.onload(new Event("load"));
              x.dispatchEvent(new Event("load"));
            } catch (e) {}
          }, true);
        }
        return XS.apply(this, arguments);
      };
    } catch (e) {}
    // A blocked ad <script>/<img>/<link> normally fires "error" (the classic detection). Report "load" instead.
    try {
      window.addEventListener("error", function (ev) {
        var t = ev && ev.target;
        if (!t || t === window || !t.tagName) return;
        var tag = t.tagName.toLowerCase();
        if (tag !== "script" && tag !== "img" && tag !== "link" && tag !== "iframe") return;
        var src = t.src || t.href;
        if (!src || !isAdUrl(src)) return;
        ev.stopImmediatePropagation();
        try { t.dispatchEvent(new Event("load")); } catch (e) {}
        try { if (typeof t.onload === "function") t.onload(new Event("load")); } catch (e) {}
      }, true);
    } catch (e) {}
    // Common ad-library globals that detectors look for
    try {
      if (!window.googletag) window.googletag = { cmd: [], apiReady: true, pubadsReady: true, display: function () {}, defineSlot: function () { return { addService: function () { return this; } }; }, pubads: function () { return { enableSingleRequest: function () {}, collapseEmptyDivs: function () {}, addEventListener: function () {} }; }, enableServices: function () {} };
      if (window.adsbygoogle && typeof window.adsbygoogle.push !== "function") window.adsbygoogle.push = function () {};
      window.google_ad_client = window.google_ad_client || "ca-pub-0000000000000000";
    } catch (e) {}

  }

  document.addEventListener("memik:anti", function (ev) {
    if (ev && ev.detail === true) start();
  });
})();
