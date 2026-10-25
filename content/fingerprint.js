// MeMik — spoof site-readable identity only. Viewport/CSS layout for the user is unchanged.
(function () {
  "use strict";
  try {
    if (window.__memikFp) return;
    window.__memikFp = true;
    const KEY = "__memik_fp";

    const realMobile = (function () {
      try {
        if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
          return navigator.userAgentData.mobile;
        }
      } catch (_) {}
      try {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
      } catch (_) {
        return false;
      }
    })();

    function define(obj, prop, getter) {
      try {
        Object.defineProperty(obj, prop, {
          get: getter,
          configurable: true,
          enumerable: true
        });
        return true;
      } catch (_) {
        return false;
      }
    }

    function apply(fp) {
      if (!fp || typeof fp !== "object") return;
      const wantMobile = !!(fp.uaData && fp.uaData.mobile) || /\bMobile\b/i.test(fp.ua || "");
      if (wantMobile !== realMobile) return;

      // --- Core navigator ---
      const navDefs = {
        userAgent: fp.ua,
        platform: fp.platform,
        vendor: fp.vendor || "Google Inc.",
        language: fp.language || "en-US",
        languages: Object.freeze(fp.languages || ["en-US", "en"]),
        hardwareConcurrency: fp.cores || (realMobile ? 8 : 8),
        deviceMemory: fp.memory || (realMobile ? 8 : 8),
        maxTouchPoints: fp.touchPoints != null ? fp.touchPoints : (realMobile ? 5 : 0)
      };
      for (const [k, v] of Object.entries(navDefs)) {
        if (v == null) continue;
        define(Navigator.prototype, k, () => v) || define(navigator, k, () => v);
      }

      // Client hints
      if (fp.uaData) {
        const mobileFlag = realMobile;
        const uad = {
          brands: fp.uaData.brands || [],
          mobile: mobileFlag,
          platform: fp.uaData.platform || fp.platform || "",
          getHighEntropyValues: async () => ({
            architecture: fp.uaData.architecture || (mobileFlag ? "arm" : "x86"),
            bitness: fp.uaData.bitness || "64",
            model: fp.uaData.model || (mobileFlag ? "Pixel 7" : ""),
            platform: fp.uaData.platform || (mobileFlag ? "Android" : "Windows"),
            platformVersion: fp.uaData.platformVersion || (mobileFlag ? "13.0.0" : "15.0.0"),
            uaFullVersion: fp.uaData.uaFullVersion || "121.0.0.0",
            fullVersionList: fp.uaData.brands || []
          })
        };
        define(Navigator.prototype, "userAgentData", () => uad) ||
          define(navigator, "userAgentData", () => uad);
      }

      // Network info (sites use this for "4G/LTE" style labels)
      try {
        if (navigator.connection) {
          const conn = {
            effectiveType: fp.connection || "4g",
            downlink: fp.downlink != null ? fp.downlink : 10,
            rtt: fp.rtt != null ? fp.rtt : 50,
            saveData: false,
            type: "wifi"
          };
          define(NetworkInformation.prototype, "effectiveType", () => conn.effectiveType);
          define(NetworkInformation.prototype, "downlink", () => conn.downlink);
          define(NetworkInformation.prototype, "rtt", () => conn.rtt);
          define(NetworkInformation.prototype, "type", () => conn.type);
        }
      } catch (_) {}

      // Screen metrics for JS readers only (does not resize the window)
      if (fp.screen) {
        try {
          define(Screen.prototype, "width", () => fp.screen.w);
          define(Screen.prototype, "height", () => fp.screen.h);
          define(Screen.prototype, "availWidth", () => fp.screen.w);
          define(Screen.prototype, "availHeight", () => fp.screen.h);
          define(Screen.prototype, "colorDepth", () => fp.screen.colorDepth || 24);
          define(Screen.prototype, "pixelDepth", () => fp.screen.colorDepth || 24);
        } catch (_) {}
      }

      // WebGL unmasked renderer (common device fingerprint)
      if (fp.webglRenderer) {
        try {
          const proto = WebGLRenderingContext && WebGLRenderingContext.prototype;
          if (proto && proto.getParameter) {
            const orig = proto.getParameter;
            proto.getParameter = function (p) {
              const dbg = this.getExtension && this.getExtension("WEBGL_debug_renderer_info");
              if (dbg) {
                if (p === dbg.UNMASKED_VENDOR_WEBGL) return fp.webglVendor || "Google Inc. (Intel)";
                if (p === dbg.UNMASKED_RENDERER_WEBGL) return fp.webglRenderer;
              }
              return orig.apply(this, arguments);
            };
          }
        } catch (_) {}
      }
    }

    try {
      const cached = sessionStorage.getItem(KEY);
      if (cached) apply(JSON.parse(cached));
    } catch (_) {}

    chrome.storage.local.get({ fingerprint: null }, data => {
      if (data && data.fingerprint) {
        try { sessionStorage.setItem(KEY, JSON.stringify(data.fingerprint)); } catch (_) {}
        apply(data.fingerprint);
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.fingerprint) return;
      const fp = changes.fingerprint.newValue;
      if (fp) {
        try { sessionStorage.setItem(KEY, JSON.stringify(fp)); } catch (_) {}
        apply(fp);
      }
    });
  } catch (_) {}
})();
