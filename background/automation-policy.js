/*
 * Shared safety policy for recording and replay.
 * Loaded by the content script, the background worker and the tests.
 *
 * Password fields are allowed for login automation (user-managed vault).
 * Payment cards, OTP/tokens, bank details, and destructive side-effects stay blocked.
 */
(function (root) {
  "use strict";

  // Fields whose values must never be recorded or replayed — except plain password
  // (handled separately so login automation can capture type=password).
  const sensitiveField = new RegExp([
    "passcode", "passwd", "pwd", "secret", "token", "bearer",
    "api[\\s_-]?key", "access[\\s_-]?key", "private[\\s_-]?key", "client[\\s_-]?secret",
    "(credit|debit|prepaid)[\\s_-]?card", "card[\\s_-]?(number|holder|no\\b|expiry|expiration)",
    "security[\\s_-]?code", "one[\\s_-]?time", "verification[\\s_-]?(code|token)",
    "social[\\s_-]?security", "account[\\s_-]?number", "routing[\\s_-]?number",
    "payment", "billing", "credential", "recovery[\\s_-]?code",
    "(?<![a-z])(pin|otp|cvv|cvc|csc|ssn|iban|bank)(?![a-z])", "cc-[a-z]+"
  ].join("|"), "i");

  // "password" alone is allowed; only compound forms and other secrets stay blocked.
  const passwordWord = /password/i;

  const sensitiveAutocomplete = /^(?:cc-|one-time-code$|webauthn$|security-code$|transaction-amount$)/i;
  // type=password is allowed; hidden/file stay blocked. tel is allowed for phone fields.
  const sensitiveTypes = /^(?:hidden|file)$/i;

  function isPasswordField(meta) {
    if (!meta) return false;
    const type = String(meta.type || "").toLowerCase();
    if (type === "password") return true;
    const autocomplete = String(meta.autocomplete || "").toLowerCase();
    if (autocomplete === "current-password" || autocomplete === "new-password") return true;
    return false;
  }

  function isSensitiveField(meta) {
    if (!meta) return false;
    // Explicit login password fields are allowed for automation.
    if (isPasswordField(meta)) return false;
    const values = typeof meta === "string" ? [meta] : [meta.name, meta.id, meta.type, meta.autocomplete,
      meta["aria-label"], meta.placeholder, meta.label, meta.selector, meta.text];
    return values.filter(Boolean).some(value => {
      const s = String(value);
      if (sensitiveField.test(s) || sensitiveAutocomplete.test(s) || sensitiveTypes.test(s)) return true;
      // Bare "password" in labels is fine when type is already handled; compound forms above catch secrets.
      return false;
    });
  }

  // Buttons and links that cause real-world side effects. They are never recorded.
  // "Submit" is intentionally omitted so login form buttons can be recorded; content.js
  // still gates actual form submit via safeSubmit. Log-out and payments stay blocked.
  const sideEffect = /(?<![a-z])(send|delete|remove|upload|download|transfer|confirm|subscribe|unsubscribe|purchase|buy|checkout|pay|place order|log ?out|sign ?out)(?![a-z])/i;

  // Anything a recorded control must not look like (except allowed password fields).
  const sensitiveControl = new RegExp(sensitiveField.source + "|" + sideEffect.source, "i");

  // Page addresses that are never opened or followed automatically by links.
  const sensitiveUrl = /(^|[\/?#&=._-])(log-?out|sign-?out|register|checkout|payment|billing|passwd|reset|auth|oauth|authorize|purchase|delete|unsubscribe|transfer)([\/?#&=._-]|$)/i;

  function parse(value) { try { return new URL(value); } catch (_) { return null; } }

  // Ordinary web page, no embedded credentials, optionally on a given origin.
  function pageUrl(value, origin) {
    const url = parse(value);
    return !!url && /^https?:$/.test(url.protocol) && !url.username && !url.password && (!origin || url.origin === origin);
  }
  // Recording works on any ordinary web page, even one called /login.
  const recordableUrl = pageUrl;

  function safeUrl(value, origin) {
    const url = parse(value);
    if (!pageUrl(value, origin)) return false;
    let path = url.pathname + url.search + url.hash;
    try { path = decodeURIComponent(path); } catch (_) { /* keep raw */ }
    return !sensitiveUrl.test(path);
  }

  function validAction(a) {
    if (!a || typeof a !== "object" || !["click", "input", "change", "enter", "scroll", "history"].includes(a.kind)) return false;
    if (a.kind === "history") return a.direction === "back" || a.direction === "forward";
    if (a.kind === "scroll") return Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.y >= 0;
    const t = a.target;
    if (!t || typeof t.selector !== "string" || t.selector.length > 1500 || typeof t.text !== "string" || t.text.length > 160) return false;
    if (typeof t.tag !== "string" || !/^[a-z][a-z0-9-]*$/i.test(t.tag)) return false;
    // Password fields are allowed for input/enter (login automation).
    if (isPasswordField(t)) {
      if (a.kind === "click") return false; // never "click" a password field
      if (a.kind === "input" || a.kind === "enter") {
        if (a.kind === "input") {
          // Value may be empty (vault-linked) or a string; optional passwordId reference.
          if (a.passwordId != null && (typeof a.passwordId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(a.passwordId))) return false;
          if (a.value != null && typeof a.value !== "string") return false;
          if (typeof a.value === "string" && a.value.length > 10000) return false;
        }
        return true;
      }
      return false;
    }
    if (isSensitiveField(t) || sensitiveControl.test(t.text)) return false;
    if (a.kind === "click" || a.kind === "enter") return true;
    return typeof a.value === "string" && a.value.length <= 10000;
  }

  root.AutomationPolicy = {
    sensitiveField, sensitiveAutocomplete, sensitiveTypes, sensitiveControl, sensitiveUrl,
    pageUrl, recordableUrl, safeUrl, isSensitiveField, isPasswordField, validAction, passwordWord
  };
  if (typeof module !== "undefined") module.exports = root.AutomationPolicy;
})(globalThis);
