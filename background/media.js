(function (global) {
  "use strict";
  async function detectInTab(tabId) {
    try { return await chrome.tabs.sendMessage(tabId, { type: "mediaDetect" }); }
    catch (_) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/media-detect.js"] });
      return await chrome.tabs.sendMessage(tabId, { type: "mediaDetect" });
    }
  }
  async function downloadUrl(url, filename) {
    if (!url || !/^https?:/i.test(url)) throw new Error("Only http(s) media can be downloaded.");
    const id = await chrome.downloads.download({ url, filename: filename || undefined, saveAs: true, conflictAction: "uniquify" });
    return { ok: true, id };
  }
  function guessName(url, title) {
    try {
      const u = new URL(url);
      let base = u.pathname.split("/").filter(Boolean).pop() || "media";
      base = base.replace(/[^\w.\-]+/g, "_").slice(0, 80);
      if (!/\.\w{2,5}$/.test(base) && title) base = (title || "media").replace(/[^\w.\-]+/g, "_").slice(0, 60) + ".mp4";
      return base;
    } catch (_) { return "media.bin"; }
  }
  global.MeMikMedia = { detectInTab, downloadUrl, guessName };
})(globalThis);
