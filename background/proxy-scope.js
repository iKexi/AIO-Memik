// Shared helpers for proxy rotation (scoped or global).
// Loaded by background.js (importScripts) and popup.html (<script>).
(function (root) {
  "use strict";

  function normalizeOrigin(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    try {
      const u = new URL(text.includes("://") ? text : "https://" + text);
      if (!/^https?:$/.test(u.protocol)) return null;
      if (u.username || u.password) return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  function hostnameOf(raw) {
    const origin = normalizeOrigin(raw);
    if (!origin) return null;
    try { return new URL(origin).hostname.toLowerCase(); } catch (_) { return null; }
  }

  const PAC_KEYWORD = { http: "PROXY", https: "HTTPS", socks4: "SOCKS", socks5: "SOCKS5" };

  /**
   * PAC: if globalMode, all non-local traffic goes through the proxy.
   * Otherwise only hostname (+ subdomains) uses the proxy.
   * SOCKS5 is preferred for remote DNS (helps when local DNS is censored).
   */
  function buildPacScript(hostname, proxy, globalMode, directHosts) {
    const keyword = PAC_KEYWORD[proxy.scheme] || "PROXY";
    // SOCKS5 keyword also lets Chrome fall back to SOCKS4; DIRECT is deliberately NOT a fallback, so a dead
    // proxy fails closed instead of silently leaking the real IP.
    const directive = JSON.stringify(`${keyword} ${proxy.host}:${proxy.port}`);
    const direct = JSON.stringify(Array.isArray(directHosts) ? directHosts.map(h => String(h).toLowerCase()) : []);
    const head = [
      "function FindProxyForURL(url, host) {",
      "  host = (host || '').toLowerCase();",
      `  var direct = ${direct};`,
      "  for (var i = 0; i < direct.length; i++) { if (host === direct[i]) return 'DIRECT'; }",
      "  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return 'DIRECT';",
      "  if (isPlainHostName(host)) return 'DIRECT';"
    ];
    if (globalMode) {
      return head.concat([`  return ${directive};`, "}"]).join("\n");
    }
    const target = JSON.stringify(String(hostname || "").toLowerCase());
    return head.concat([
      `  var target = ${target};`,
      "  if (!target) return 'DIRECT';",
      '  if (host === target || host.slice(-(target.length + 1)) === "." + target) {',
      `    return ${directive};`,
      "  }",
      '  return "DIRECT";',
      "}"
    ]).join("\n");
  }

  function directiveFor(proxy) {
    return `${PAC_KEYWORD[proxy.scheme] || "PROXY"} ${proxy.host}:${proxy.port}`;
  }

  // PAC that sends each probe hostname ("lane") through its own proxy so several servers can be
  // tested at the same time. No DIRECT fallback inside a lane: a dead proxy must fail, not leak.
  function buildLanePac(laneMap, fallback, directHosts) {
    const direct = JSON.stringify((directHosts || []).map(h => String(h).toLowerCase()));
    return [
      "function FindProxyForURL(url, host) {",
      "  host = (host || '').toLowerCase();",
      `  var direct = ${direct};`,
      "  for (var i = 0; i < direct.length; i++) { if (host === direct[i]) return 'DIRECT'; }",
      `  var lanes = ${JSON.stringify(laneMap)};`,
      "  if (Object.prototype.hasOwnProperty.call(lanes, host)) return lanes[host];",
      "  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || isPlainHostName(host)) return 'DIRECT';",
      `  return ${JSON.stringify(fallback || "DIRECT")};`,
      "}"
    ].join("\n");
  }

  root.ProxyScope = { normalizeOrigin, hostnameOf, buildPacScript, directiveFor, buildLanePac };
  if (typeof module !== "undefined") module.exports = root.ProxyScope;
})(globalThis);
