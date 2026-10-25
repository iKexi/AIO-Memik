/**
 * Cosmetic ad hiding + anti-adblock (always on with adblock).
 * Spoofs popup permission checks without opening real popups.
 */
(function () {
  "use strict";
  if (window.__memikAdPage) return;
  try {
    const h = location.hostname || "";
    const path = location.pathname || "";
    if (/(?:^|\.)challenges\.cloudflare\.com$/i.test(h) ||
        (/cloudflare\.com$/i.test(h) && path.includes("/cdn-cgi/")) ||
        path.includes("/cdn-cgi/challenge-platform/")) {
      return;
    }
  } catch (_) {}
  window.__memikAdPage = true;

  // Allowed sites (built-in mail services + the user's list) get no hiding and no anti-adblock script at all.
  var hostNow = (location.hostname || "").toLowerCase();
  var builtinAllowed = false;
  try { builtinAllowed = !!(self.MemikAllow && MemikAllow.hostMatches(hostNow, MemikAllow.BUILTIN)); } catch (_) {}
  if (builtinAllowed) return;
  var userAllowed = false;

  const ADBLOCK_CSS = `
[id*="google_ads" i], [id*="googleads" i], [id^="ad-"], [id^="ad_"], [id^="ads-"], [id^="ads_"],
[id*="adcontainer" i], [id*="ad-container" i], [id*="adwrapper" i], [id*="bannerad" i],
[class*="google-ad" i], [class*="googlead" i], [class*="adsbygoogle" i],
[class*="ad-slot" i], [class*="ad_slot" i], [class*="ad-unit" i], [class*="ad_unit" i],
[class*="ad-banner" i], [class*="adbanner" i], [class*="ad-container" i], [class*="adcontainer" i],
[class*="advertisement" i], [class*="sponsored-content" i],
ins.adsbygoogle, amp-ad, amp-embed[type="ad"],
iframe[src*="doubleclick" i], iframe[src*="googlesyndication" i],
iframe[src*="amazon-adsystem" i], iframe[src*="adnxs" i], iframe[src*="taboola" i],
iframe[src*="outbrain" i], iframe[src*="criteo" i], iframe[src*="adservice" i],
iframe[src*="abenergy" i], iframe[src*="propeller" i], iframe[src*="popads" i],
div[data-ad], div[data-ads], div[data-ad-slot], div[data-adunit],
div[data-google-query-id], [id*="div-gpt-ad" i], [class*="dfp-ad" i],
.taboola, .OUTBRAIN, .adsbox, .ad-box, .adbox,
[class*="ad-placeholder" i], [class*="promo-banner" i],
[data-ad-client], [data-ad-channel], div[id^="google_ads_iframe"],
[class*="sticky-ad" i], [class*="footer-ad" i]
{ display: none !important; visibility: hidden !important; height: 0 !important;
  max-height: 0 !important; overflow: hidden !important; opacity: 0 !important;
  pointer-events: none !important; }
`;

  const ANTI_CSS = `
[class*="adblock-popup" i], [class*="adblock_popup" i], [class*="adblock-modal" i],
[class*="adblock-overlay" i], [class*="adb-overlay" i], [class*="adb-popup" i],
[class*="anti-adblock" i], [class*="antiadblock" i], [class*="adblocker-detected" i],
[class*="adblock-detected" i], [class*="blockadblock" i], [class*="adsblocked" i],
[id*="adblock-popup" i], [id*="adblock-modal" i], [id*="adblock-overlay" i],
[id*="disable-adblock" i], [id*="adblock-detected" i], [id*="adblocker-detected" i],
[id*="detect-adblock" i], [class*="detect-adblock" i],
.fc-ab-root, .fc-dialog-container, #AdWidgetContainer,
.adblock_message, .adblock-message, .adblock_screen, .adblock-screen,
.adb-enabled-message, #adb-enabled, .wrap-ban-adblock, .ban-adblock,
.adblockWarning, .adblock-warning, .adblock_info, #adblock_info, .ftwp-adblock,
/* LuluStream / video host walls */
.videoplayer [class*="adblock" i], .videoplayer-embed [class*="adblock" i],
div[class*="player"] [class*="message" i], .jw-error, .vjs-modal-dialog-content
{ display: none !important; visibility: hidden !important; pointer-events: none !important;
  opacity: 0 !important; z-index: -1 !important; max-height: 0 !important; }
html.adb-detected, body.adb-detected, html.adblock-on, body.adblock-on,
html.has-adblock, body.has-adblock {
  overflow: auto !important; position: static !important;
}
`;

  function injectStyle(id, css) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
    return el;
  }

  function removeStyle(id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  }

  // Page-world script (anti-main.js) is a manifest MAIN-world content script; we just signal it.
  function signalMain(on) {
    try { document.dispatchEvent(new CustomEvent("memik:anti", { detail: !!on })); } catch (e) {}
  }

  var adblockOn = null;       // unknown until storage answers, so nothing runs on an allowed site first

  function applyAll() {
    if (adblockOn) {
      injectStyle("memik-adblock-css", ADBLOCK_CSS);
      injectStyle("memik-anti-css", ANTI_CSS);
      signalMain(true);
    } else {
      removeStyle("memik-adblock-css");
      removeStyle("memik-anti-css");
    }
  }

  try {
    document.addEventListener("DOMContentLoaded", function () { if (adblockOn === true) signalMain(true); });
  } catch (_) {}

  try {
    chrome.storage.local.get({ adblockEnabled: true, adblockAllow: [] }, function (data) {
      userAllowed = !!(self.MemikAllow && MemikAllow.hostMatches(hostNow, data.adblockAllow));
      adblockOn = data.adblockEnabled !== false && !userAllowed;
      applyAll();
    });
  } catch (_) {
    applyAll();
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if ("adblockEnabled" in changes || "adblockAllow" in changes) {
        chrome.storage.local.get({ adblockEnabled: true, adblockAllow: [] }, function (data) {
          userAllowed = !!(self.MemikAllow && MemikAllow.hostMatches(hostNow, data.adblockAllow));
          adblockOn = data.adblockEnabled !== false && !userAllowed;
          applyAll();
        });
      }
    });
  } catch (_) {}
})();
