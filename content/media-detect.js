(function () {
  "use strict";
  if (window.__memikMediaDetect) return;
  window.__memikMediaDetect = true;

  function absUrl(u) { try { return new URL(u, location.href).href; } catch (_) { return ""; } }
  function sniffType(url, el) {
    const u = (url || "").toLowerCase();
    if (/\.m3u8(\?|$)/.test(u)) return "hls";
    if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)/.test(u)) return "audio";
    if (/\.(mp4|webm|mkv|mov)(\?|$)/.test(u)) return "video";
    if (el && el.tagName === "AUDIO") return "audio";
    if (el && el.tagName === "VIDEO") return "video";
    return "media";
  }

  function collect() {
    const seen = new Set();
    const items = [];
    function add(url, meta) {
      const href = absUrl(url);
      if (!href || !/^https?:/i.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      items.push({
        url: href,
        type: meta.type || sniffType(href, meta.el),
        label: meta.label || href.split("/").pop().split("?")[0] || href,
        width: meta.width || 0,
        height: meta.height || 0
      });
    }
    document.querySelectorAll("video, audio").forEach((el, i) => {
      const src = el.currentSrc || el.src;
      if (src) add(src, {
        el,
        label: el.getAttribute("title") || (el.tagName.toLowerCase() + " " + (i + 1)),
        width: el.videoWidth || 0,
        height: el.videoHeight || 0
      });
      el.querySelectorAll("source[src]").forEach(s => add(s.getAttribute("src"), { el }));
    });
    document.querySelectorAll("source[src], a[href]").forEach(el => {
      const href = el.getAttribute("src") || el.getAttribute("href") || "";
      if (/\.(mp4|webm|mkv|mov|m3u8|mp3|m4a)(\?|$)/i.test(href)) add(href, {});
    });
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach(m => {
      const c = m.getAttribute("content");
      if (c) add(c, { label: "og:video" });
    });
    return { pageUrl: location.href, title: document.title || "", items: items.slice(0, 40), at: Date.now() };
  }

  let lastSig = "";
  function publish() {
    const result = collect();
    const sig = JSON.stringify(result.items.map(i => i.url));
    if (sig === lastSig) return result;
    lastSig = sig;
    chrome.storage.local.set({ mediaDetected: result }).catch(() => {});
    return result;
  }

  function applyPlayer(opts) {
    const videos = [...document.querySelectorAll("video")];
    if (!videos.length) return { ok: false, error: "No video element on page" };
    const el = videos[0];
    try {
      if (opts.speed != null) el.playbackRate = Math.min(4, Math.max(0.25, Number(opts.speed) || 1));
      if (opts.pip) {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else if (el.requestPictureInPicture) el.requestPictureInPicture();
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === "mediaDetect") {
      try { sendResponse({ ok: true, result: publish() }); }
      catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
      return true;
    }
    if (msg && msg.type === "mediaPlayerControl") {
      sendResponse(applyPlayer(msg.opts || {}));
      return true;
    }
  });

  const run = () => { try { publish(); } catch (_) {} };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
  new MutationObserver(() => run()).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  setInterval(run, 4000);
})();
