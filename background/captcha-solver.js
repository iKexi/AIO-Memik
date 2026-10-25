/**
 * MeMik captcha solver — 2Captcha / Anti-Captcha style API clients.
 * Requires user-supplied API key. No free bypass of hard captchas.
 */
(function (global) {
  "use strict";

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function httpGet(url) {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    return text.trim();
  }

  async function httpPostForm(url, params) {
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    return (await res.text()).trim();
  }

  /** Classic 2captcha in.php / res.php */
  async function solve2captcha({ key, type, sitekey, pageurl, action, cdata }) {
    if (!key) throw new Error("Add a 2Captcha API key in Captcha settings.");
    const params = {
      key,
      json: "0",
      pageurl: pageurl || ""
    };
    if (type === "recaptcha_v2" || type === "recaptcha") {
      params.method = "userrecaptcha";
      params.googlekey = sitekey;
    } else if (type === "recaptcha_v3") {
      params.method = "userrecaptcha";
      params.googlekey = sitekey;
      params.version = "v3";
      params.action = action || "verify";
      params.min_score = "0.3";
    } else if (type === "hcaptcha") {
      params.method = "hcaptcha";
      params.sitekey = sitekey;
    } else if (type === "turnstile") {
      params.method = "turnstile";
      params.sitekey = sitekey;
    } else {
      params.method = "userrecaptcha";
      params.googlekey = sitekey;
    }

    const create = await httpPostForm("https://2captcha.com/in.php", params);
    if (create.startsWith("ERROR_")) throw new Error(create.replace(/^ERROR_/, "").replace(/_/g, " "));
    if (!create.startsWith("OK|")) throw new Error("2Captcha create failed: " + create.slice(0, 120));
    const id = create.slice(3);

    // Poll up to ~2 minutes
    for (let i = 0; i < 24; i++) {
      await sleep(i < 2 ? 5000 : 5000);
      const poll = await httpGet(
        `https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=get&id=${encodeURIComponent(id)}`
      );
      if (poll === "CAPCHA_NOT_READY" || poll === "CAPTCHA_NOT_READY") continue;
      if (poll.startsWith("ERROR_")) throw new Error(poll.replace(/^ERROR_/, "").replace(/_/g, " "));
      if (poll.startsWith("OK|")) return { token: poll.slice(3), provider: "2captcha", id };
      // sometimes plain token
      if (poll.length > 20 && !poll.includes(" ")) return { token: poll, provider: "2captcha", id };
    }
    throw new Error("2Captcha timed out waiting for a solution.");
  }

  async function solveAnticaptcha({ key, type, sitekey, pageurl, action }) {
    if (!key) throw new Error("Add an Anti-Captcha API key.");
    let taskType = "NoCaptchaTaskProxyless";
    const task = {
      type: taskType,
      websiteURL: pageurl,
      websiteKey: sitekey
    };
    if (type === "hcaptcha") {
      task.type = "HCaptchaTaskProxyless";
    } else if (type === "recaptcha_v3") {
      task.type = "RecaptchaV3TaskProxyless";
      task.minScore = 0.3;
      task.pageAction = action || "verify";
    } else if (type === "turnstile") {
      task.type = "TurnstileTaskProxyless";
    }

    const createRes = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, task })
    });
    const create = await createRes.json();
    if (create.errorId) throw new Error(create.errorDescription || create.errorCode || "Anti-Captcha error");
    const taskId = create.taskId;

    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: key, taskId })
      });
      const poll = await pollRes.json();
      if (poll.errorId) throw new Error(poll.errorDescription || poll.errorCode || "Anti-Captcha error");
      if (poll.status === "ready") {
        const token =
          poll.solution?.gRecaptchaResponse ||
          poll.solution?.token ||
          poll.solution?.text ||
          "";
        if (!token) throw new Error("Anti-Captcha returned empty token");
        return { token, provider: "anticaptcha", id: String(taskId) };
      }
    }
    throw new Error("Anti-Captcha timed out.");
  }

  async function solveCapmonster({ key, type, sitekey, pageurl, action }) {
    if (!key) throw new Error("Add a CapMonster API key.");
    let task = {
      type: "NoCaptchaTaskProxyless",
      websiteURL: pageurl,
      websiteKey: sitekey
    };
    if (type === "hcaptcha") task.type = "HCaptchaTaskProxyless";
    if (type === "recaptcha_v3") {
      task.type = "RecaptchaV3TaskProxyless";
      task.minScore = 0.3;
      task.pageAction = action || "verify";
    }
    if (type === "turnstile") task.type = "TurnstileTaskProxyless";

    const createRes = await fetch("https://api.capmonster.cloud/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, task })
    });
    const create = await createRes.json();
    if (create.errorId) throw new Error(create.errorDescription || create.errorCode || "CapMonster error");
    const taskId = create.taskId;
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const pollRes = await fetch("https://api.capmonster.cloud/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: key, taskId })
      });
      const poll = await pollRes.json();
      if (poll.errorId) throw new Error(poll.errorDescription || poll.errorCode || "CapMonster error");
      if (poll.status === "ready") {
        const token = poll.solution?.gRecaptchaResponse || poll.solution?.token || "";
        if (!token) throw new Error("CapMonster returned empty token");
        return { token, provider: "capmonster", id: String(taskId) };
      }
    }
    throw new Error("CapMonster timed out.");
  }

  /* ---------- speech to text for reCAPTCHA audio challenges (Wit.ai, free tier, user's own token) ---------- */

  // Wit streams several JSON objects back to back; return the final recognised text.
  function parseWitText(body) {
    const objs = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(body.slice(start, i + 1))); } catch (_) {} start = -1; } }
    }
    let text = "";
    for (const o of objs) {
      if (o && typeof o.text === "string" && o.text.trim()) { text = o.text; if (o.is_final) break; }
    }
    return text;
  }

  function normalizeSpeech(text) {
    return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  async function transcribeWit(bytes, token) {
    if (!token) throw new Error("Add a free Wit.ai token in Captcha settings.");
    let res;
    try {
      res = await fetch("https://api.wit.ai/speech?v=20240304", {
        method: "POST", cache: "no-store",
        headers: { Authorization: "Bearer " + token, "Content-Type": "audio/mpeg3" },
        body: bytes
      });
    } catch (e) {
      throw new Error("Could not reach Wit.ai (network error).");
    }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error("Wit.ai rejected the token. Copy the “Server Access Token” from your Wit.ai app → Settings.");
    if (res.status === 429) throw new Error("Wit.ai rate limit reached. Wait a minute and try again.");
    if (!res.ok) throw new Error("Wit.ai error (HTTP " + res.status + ").");
    return normalizeSpeech(parseWitText(body));
  }

  async function solve({ provider, key, type, sitekey, pageurl, action, cdata, customUrl }) {
    const p = (provider || "2captcha").toLowerCase();
    if (!sitekey) throw new Error("No captcha sitekey found on the page.");
    if (!pageurl) throw new Error("Missing page URL.");
    if (p === "2captcha") return solve2captcha({ key, type, sitekey, pageurl, action, cdata });
    if (p === "anticaptcha") return solveAnticaptcha({ key, type, sitekey, pageurl, action });
    if (p === "capmonster") return solveCapmonster({ key, type, sitekey, pageurl, action });
    if (p === "custom" && customUrl) {
      const res = await fetch(customUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, type, sitekey, pageurl, action })
      });
      const data = await res.json();
      if (data.token || data.solution) return { token: data.token || data.solution, provider: "custom" };
      throw new Error(data.error || "Custom solver failed");
    }
    if (p === "none" || !key) {
      throw new Error("Save a solver API key (2Captcha, etc.) to auto-solve. Assisted mode only focuses the challenge.");
    }
    return solve2captcha({ key, type, sitekey, pageurl, action, cdata });
  }

  global.CaptchaSolver = {
    transcribeWit, parseWitText, normalizeSpeech, solve };
})(globalThis);
