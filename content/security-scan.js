/**
 * MeMik site audit — passive XSS/SQLi surface analysis on the current page.
 * Safe for developers reviewing their own sites. Does not exploit findings.
 */
(function () {
  "use strict";
  if (window.__memikSecScan) return;
  window.__memikSecScan = true;

  function scoreToLevel(n) {
    if (n >= 8) return "high";
    if (n >= 4) return "medium";
    if (n >= 1) return "low";
    return "info";
  }

  function filterFindings(findings, mode) {
    if (!mode || mode === "all") return findings;
    const map = {
      info: ["info", "form", "link"],
      links: ["form", "link", "redirect"],
      headers: ["transport", "csp"],
      mixed: ["transport"],
      cookie: ["cookie"],
      csp: ["csp", "transport"],
      xss: ["xss"],
      sql: ["sqli", "sql"],
      redirect: ["redirect"]
    };
    const allow = map[mode];
    if (!allow) return findings;
    return findings.filter(f => allow.includes(String(f.type || "").toLowerCase()));
  }

  function scanPage() {
    const findings = [];
    const url = location.href;
    const qs = location.search || "";

    // --- XSS surfaces ---
    let inlineHandlers = 0;
    try {
      document.querySelectorAll("*").forEach(el => {
        for (const attr of el.attributes || []) {
          if (/^on/i.test(attr.name)) inlineHandlers++;
        }
      });
    } catch (_) {}
    if (inlineHandlers > 0) {
      findings.push({
        type: "xss",
        level: inlineHandlers > 10 ? "medium" : "low",
        title: "Inline event handlers",
        detail: `Found ${inlineHandlers} on* attributes (onclick, onerror, …). Prefer addEventListener.`
      });
    }

    let jsUris = 0;
    document.querySelectorAll("a[href], form[action]").forEach(el => {
      const v = (el.getAttribute("href") || el.getAttribute("action") || "").trim();
      if (/^\s*javascript:/i.test(v)) jsUris++;
    });
    if (jsUris) {
      findings.push({
        type: "xss",
        level: "medium",
        title: "javascript: URLs",
        detail: `${jsUris} link/form uses javascript: URI — XSS risk if user-controlled.`
      });
    }

    // document.write / innerHTML patterns in inline scripts
    let riskyScripts = 0;
    document.querySelectorAll("script:not([src])").forEach(s => {
      const t = s.textContent || "";
      if (/\.innerHTML\s*=|document\.write\s*\(|eval\s*\(|new\s+Function\s*\(/i.test(t)) riskyScripts++;
    });
    if (riskyScripts) {
      findings.push({
        type: "xss",
        level: "medium",
        title: "Risky DOM sinks in inline scripts",
        detail: `${riskyScripts} inline script(s) use innerHTML, document.write, eval, or Function.`
      });
    }

    // Reflected query into page HTML (basic)
    try {
      const params = new URLSearchParams(qs);
      params.forEach((val, key) => {
        if (!val || val.length < 3) return;
        const body = document.documentElement.innerHTML || "";
        if (body.includes(val)) {
          findings.push({
            type: "xss",
            level: "high",
            title: "Possible reflected parameter",
            detail: `Query param "${key}" value appears in page HTML. Check encoding to prevent reflected XSS.`
          });
        }
      });
    } catch (_) {}

    // --- SQL injection surfaces ---
    const forms = [...document.querySelectorAll("form")];
    const suspiciousFields = [];
    forms.forEach((form, fi) => {
      const inputs = form.querySelectorAll("input, textarea, select");
      inputs.forEach(inp => {
        const name = (inp.name || inp.id || "").toLowerCase();
        if (/(id|user|search|query|q|filter|sort|order|select|table|cat|page)$/i.test(name) ||
            /^(id|uid|pid|sid|qid)$/i.test(name)) {
          suspiciousFields.push({
            form: fi,
            name: inp.name || inp.id || "(unnamed)",
            method: (form.method || "get").toUpperCase(),
            action: form.action || location.href
          });
        }
      });
    });
    if (suspiciousFields.length) {
      findings.push({
        type: "sqli",
        level: "medium",
        title: "Forms with SQL-prone field names",
        detail: suspiciousFields.slice(0, 8).map(f =>
          `${f.method} ${f.name} → ${f.action}`
        ).join("; ") + (suspiciousFields.length > 8 ? "…" : "")
      });
    }

    // GET params that look ID-like
    try {
      const params = new URLSearchParams(qs);
      const idParams = [];
      params.forEach((val, key) => {
        if (/^(id|user_id|uid|pid|item|cat|page|sort|order)$/i.test(key) || /^\d+$/.test(val)) {
          idParams.push(`${key}=${val}`);
        }
      });
      if (idParams.length) {
        findings.push({
          type: "sqli",
          level: "low",
          title: "URL parameters worth parameterized queries",
          detail: idParams.slice(0, 12).join(", ") + " — ensure server uses prepared statements."
        });
      }
    } catch (_) {}

    // Error-based SQL messages already on page
    const pageText = (document.body && document.body.innerText) || "";
    if (/SQL syntax|mysql_fetch|ORA-\d{5}|PostgreSQL.*ERROR|Unclosed quotation mark|ODBC SQL/i.test(pageText)) {
      findings.push({
        type: "sqli",
        level: "high",
        title: "Database error text visible",
        detail: "Page shows SQL/database error messages — hide these in production and fix the query."
      });
    }

    // Security headers cannot be read from JS fully — note limitation
    findings.push({
      type: "info",
      level: "info",
      title: "Scan scope",
      detail: "Passive analysis of this page only. Server-side SQLi needs backend review. CSP/headers checked separately if available."
    });

    // CSP meta
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!csp) {
      findings.push({
        type: "xss",
        level: "low",
        title: "No CSP meta tag",
        detail: "Consider Content-Security-Policy header (preferred) or meta to mitigate XSS impact."
      });
    }
    // Mixed content
    try {
      if (location.protocol === "https:") {
        let mixed = 0;
        document.querySelectorAll("img[src], script[src], link[href], iframe[src]").forEach(el => {
          const v = el.getAttribute("src") || el.getAttribute("href") || "";
          if (/^http:\/\//i.test(v)) mixed++;
        });
        if (mixed) findings.push({ type: "transport", level: mixed > 3 ? "high" : "medium", title: "Mixed content", detail: `${mixed} http:// subresource(s) on an HTTPS page.` });
      }
    } catch (_) {}

    // Cookie flags (document.cookie only shows non-HttpOnly)
    try {
      const raw = document.cookie || "";
      if (raw) {
        const parts = raw.split(";").map(s => s.trim()).filter(Boolean);
        if (parts.length) {
          findings.push({
            type: "cookie",
            level: "info",
            title: "Readable cookies",
            detail: `${parts.length} cookie(s) visible to JS (HttpOnly cookies are not listed). Review Secure/SameSite in DevTools Application tab.`
          });
        }
      }
    } catch (_) {}

    // Forms without CSRF token hints
    try {
      let bare = 0;
      document.querySelectorAll("form").forEach(f => {
        const method = (f.getAttribute("method") || "get").toLowerCase();
        if (method !== "post") return;
        const has = f.querySelector('input[name*="csrf" i], input[name*="token" i], input[name="_token"], input[name="authenticity_token"]');
        if (!has) bare++;
      });
      if (bare) findings.push({ type: "csrf", level: "medium", title: "POST forms without obvious CSRF token", detail: `${bare} POST form(s) lack common CSRF field names. Confirm your framework still protects them.` });
    } catch (_) {}

    // Open redirect style params
    try {
      const params = new URLSearchParams(location.search || "");
      const keys = ["redirect", "return", "returnurl", "next", "url", "goto", "continue", "dest", "destination"];
      keys.forEach(k => {
        const v = params.get(k);
        if (v && /^https?:/i.test(v)) {
          findings.push({ type: "redirect", level: "medium", title: "Open-redirect style parameter", detail: `Query param "${k}" points to an absolute URL. Validate allow-lists server-side.` });
        }
      });
    } catch (_) {}

    // Autocomplete on password fields
    try {
      document.querySelectorAll('input[type="password"]').forEach(el => {
        if ((el.getAttribute("autocomplete") || "").toLowerCase() === "off") return;
        // info only
      });
      const pw = document.querySelectorAll('input[type="password"]').length;
      if (pw) findings.push({ type: "form", level: "info", title: "Password fields present", detail: `${pw} password input(s) on page. Prefer autocomplete="current-password" / "new-password".` });
    } catch (_) {}

    // Target blank without noopener
    try {
      let unsafe = 0;
      document.querySelectorAll('a[target="_blank"]').forEach(a => {
        const rel = (a.getAttribute("rel") || "").toLowerCase();
        if (!rel.includes("noopener") && !rel.includes("noreferrer")) unsafe++;
      });
      if (unsafe) findings.push({ type: "link", level: "low", title: "target=_blank without noopener", detail: `${unsafe} link(s) may expose window.opener. Add rel="noopener noreferrer".` });
    } catch (_) {}

    // Insecure form action
    try {
      let bad = 0;
      document.querySelectorAll("form[action]").forEach(f => {
        const a = f.getAttribute("action") || "";
        if (/^http:\/\//i.test(a)) bad++;
      });
      if (bad) findings.push({ type: "transport", level: "high", title: "Form posts to HTTP", detail: `${bad} form(s) action uses http:// — credentials may be exposed.` });
    } catch (_) {}



    return {
      url,
      scannedAt: Date.now(),
      findings,
      summary: {
        xss: findings.filter(f => f.type === "xss").length,
        sqli: findings.filter(f => f.type === "sqli").length,
        high: findings.filter(f => f.level === "high").length
      }
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && (msg.type === "securityScanPage" || msg.type === "detectiveScan")) {
      try {
        const mode = (msg && msg.mode) || "all"; const result = scanPage(); if (result && Array.isArray(result.findings)) result.findings = filterFindings(result.findings, mode); sendResponse({ ok: true, result });;
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
      return true;
    }
  });
})();
