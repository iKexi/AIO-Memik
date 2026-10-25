// Isolated world: load profile from storage and inject MAIN-world spoof (sites cannot see real specs).
(function () {
  "use strict";
  if (window.__memikBridge) return;
  window.__memikBridge = true;

  function injectMain(fp) {
    try {
      const payload = JSON.stringify(fp || null);
      const code = "window.__memikFpData=" + payload + ";\n" + MAIN_SOURCE;
      const s = document.createElement("script");
      s.textContent = code;
      s.setAttribute("data-memik", "fp");
      const root = document.documentElement || document.head || document;
      root.insertBefore(s, root.firstChild);
      s.remove();
    } catch (_) {}
  }

  // MAIN-world spoof (string so it runs in page context)
  const MAIN_SOURCE = `
(function(){
  "use strict";
  if (window.__memikMainFp) return;
  window.__memikMainFp = true;
  var fp = window.__memikFpData;
  if (!fp || typeof fp !== "object") return;

  function def(obj, prop, val) {
    try {
      Object.defineProperty(obj, prop, {
        get: function () { return val; },
        configurable: true,
        enumerable: true
      });
      return true;
    } catch (e) { return false; }
  }

  var realMobile = false;
  try {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean")
      realMobile = navigator.userAgentData.mobile;
    else
      realMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  } catch (e) {}

  var wantMobile = !!(fp.uaData && fp.uaData.mobile) || /\\bMobile\\b/i.test(fp.ua || "");
  // Keep form factor so sites do not flip desktop/mobile layout
  if (wantMobile !== realMobile) {
    // Still spoof hardware numbers; only skip UA swap across form factors
  }

  var cores = fp.cores != null ? fp.cores : 8;
  var memory = fp.memory != null ? fp.memory : 8;
  var touch = fp.touchPoints != null ? fp.touchPoints : (realMobile ? 5 : 0);

  // Only apply UA if same form factor
  if (wantMobile === realMobile) {
    def(Navigator.prototype, "userAgent", fp.ua);
    def(Navigator.prototype, "platform", fp.platform);
    def(Navigator.prototype, "vendor", fp.vendor || "Google Inc.");
    def(Navigator.prototype, "language", fp.language || "en-US");
    def(Navigator.prototype, "languages", Object.freeze(fp.languages || ["en-US", "en"]));
  }

  def(Navigator.prototype, "hardwareConcurrency", cores);
  def(Navigator.prototype, "deviceMemory", memory);
  def(Navigator.prototype, "maxTouchPoints", touch);

  if (fp.uaData && wantMobile === realMobile) {
    var mobileFlag = realMobile;
    var brands = fp.uaData.brands || [];
    var uad = {
      brands: brands,
      mobile: mobileFlag,
      platform: fp.uaData.platform || "",
      getHighEntropyValues: function () {
        return Promise.resolve({
          architecture: fp.uaData.architecture || (mobileFlag ? "arm" : "x86"),
          bitness: fp.uaData.bitness || "64",
          model: fp.uaData.model || "",
          platform: fp.uaData.platform || (mobileFlag ? "Android" : "Windows"),
          platformVersion: fp.uaData.platformVersion || "",
          uaFullVersion: fp.uaData.uaFullVersion || "121.0.0.0",
          fullVersionList: brands
        });
      }
    };
    def(Navigator.prototype, "userAgentData", uad);
  }

  // Screen (JS readers only — does not resize window)
  if (fp.screen) {
    try {
      def(Screen.prototype, "width", fp.screen.w);
      def(Screen.prototype, "height", fp.screen.h);
      def(Screen.prototype, "availWidth", fp.screen.w);
      def(Screen.prototype, "availHeight", fp.screen.h);
      def(Screen.prototype, "colorDepth", fp.screen.colorDepth || 24);
      def(Screen.prototype, "pixelDepth", fp.screen.colorDepth || 24);
    } catch (e) {}
  }

  // Network Information
  try {
    if (typeof NetworkInformation !== "undefined") {
      def(NetworkInformation.prototype, "effectiveType", fp.connection || "4g");
      def(NetworkInformation.prototype, "downlink", fp.downlink != null ? fp.downlink : 10);
      def(NetworkInformation.prototype, "rtt", fp.rtt != null ? fp.rtt : 50);
      def(NetworkInformation.prototype, "saveData", false);
    }
  } catch (e) {}

  // WebGL renderer
  if (fp.webglRenderer) {
    try {
      var patch = function (Proto) {
        if (!Proto || !Proto.prototype || !Proto.prototype.getParameter) return;
        var orig = Proto.prototype.getParameter;
        Proto.prototype.getParameter = function (p) {
          try {
            var dbg = this.getExtension && this.getExtension("WEBGL_debug_renderer_info");
            if (dbg) {
              if (p === dbg.UNMASKED_VENDOR_WEBGL) return fp.webglVendor || "Google Inc.";
              if (p === dbg.UNMASKED_RENDERER_WEBGL) return fp.webglRenderer;
            }
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      };
      patch(window.WebGLRenderingContext);
      patch(window.WebGL2RenderingContext);
    } catch (e) {}
  }

  // Battery — generic
  try {
    if (navigator.getBattery) {
      var fakeBatt = function () {
        return Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 0.87,
          addEventListener: function () {},
          removeEventListener: function () {},
          onchargingchange: null,
          onlevelchange: null
        });
      };
      def(Navigator.prototype, "getBattery", fakeBatt);
    }
  } catch (e) {}
})();
`;

  // Prefer sync-ish path: inject cached session data immediately if present
  try {
    const cached = sessionStorage.getItem("__memik_fp");
    if (cached) injectMain(JSON.parse(cached));
  } catch (_) {}

  try {
    chrome.storage.local.get({ fingerprint: null }, data => {
      const fp = data && data.fingerprint;
      if (fp) {
        try { sessionStorage.setItem("__memik_fp", JSON.stringify(fp)); } catch (_) {}
        injectMain(fp);
      }
    });
  } catch (_) {}

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.fingerprint) return;
      const fp = changes.fingerprint.newValue;
      if (!fp) return;
      try { sessionStorage.setItem("__memik_fp", JSON.stringify(fp)); } catch (_) {}
      // Next navigation will apply; soft re-inject for SPA
      injectMain(fp);
    });
  } catch (_) {}
})();
