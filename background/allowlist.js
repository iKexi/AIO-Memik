// Ad-blocker allowlist helpers. Shared by the service worker, the popup and the page content script.
(function (root) {
  "use strict";

  // Always allowed: temporary-mail services and the sites around them. The ad blocker never touches
  // these (page requests, ad rules, cosmetic hiding), so inboxes and their websites load normally.
  const BUILTIN = [
    "mail.tm", "api.mail.tm", "tempmail.lol", "api.tempmail.lol",
    "guerrillamail.com", "guerrillamailblock.com", "sharklasers.com", "grr.la", "guerrillamail.net",
    "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de", "pokemail.net", "spam4.me",
    "temp-mail.org", "temp-mail.io", "tempmail.plus", "dropmail.me", "10minutemail.com", "10minutemail.net",
    "mailto.plus", "fexpost.com", "fexbox.org", "mailbox.in.ua", "rover.info", "chitthi.in", "fextemp.com",
    "any.pink", "merepost.com"
  ];

  // Accepts "example.com", "https://www.example.com/path?x", "*.example.com", "Example.COM:8080".
  function normalizeHost(input) {
    let s = String(input == null ? "" : input).trim().toLowerCase();
    if (!s || s.length > 300) return "";
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // scheme
    s = s.replace(/^[^@/]*@/, "");                    // user:pass@
    s = s.split(/[\/?#]/)[0];                         // path, query, hash
    s = s.replace(/:\d{1,5}$/, "");                   // port
    s = s.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
    if (s.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return "";
    return s;
  }

  // True when `host` is one of the entries or a subdomain of one.
  function hostMatches(host, entries) {
    const h = String(host || "").toLowerCase();
    if (!h) return false;
    for (const e of entries || []) {
      if (h === e || h.endsWith("." + e)) return true;
    }
    return false;
  }

  root.MemikAllow = { BUILTIN, normalizeHost, hostMatches };
  if (typeof module !== "undefined") module.exports = root.MemikAllow;
})(globalThis);
