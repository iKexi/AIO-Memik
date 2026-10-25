(function (global) {
  "use strict";

  const STORAGE_KEY = "tempMailState";
  const ALARM = "temp-mail-refresh";
  const REFRESH_MINUTES = 1;
  const REQUEST_TIMEOUT_MS = 10000;

  /** Every provider the UI can offer. "auto" walks AUTO_ORDER until one works. */
  const SERVICES = {
    tempmaillol: { name: "TempMail.lol", site: "https://tempmail.lol/", kind: "tempmaillol" },
    mailtm:      { name: "Mail.tm",      site: "https://mail.tm/",      kind: "hydra", base: "https://api.mail.tm" },
    guerrilla:   { name: "Guerrilla Mail", site: "https://www.guerrillamail.com/", kind: "guerrilla" },
    tempmailplus:{ name: "Tempmail.plus", site: "https://tempmail.plus/", kind: "tempmailplus" },
    onesecmail:  { name: "1secmail",     site: "https://www.1secmail.com/", kind: "onesecmail", hidden: true }
  };
  const AUTO_ORDER = ["tempmaillol", "mailtm", "guerrilla", "tempmailplus"];

  /** Hostnames the proxy layer must always reach DIRECT so inbox traffic never goes through a free proxy. */
  const HOSTS = [
    "api.mail.tm", "api.tempmail.lol",
    "api.guerrillamail.com", "www.guerrillamail.com", "tempmail.plus", "www.1secmail.com"
  ];

  const get = defaults => chrome.storage.local.get(defaults);
  const set = value => chrome.storage.local.set(value);

  const stateDefaults = {
    provider: "auto",
    mailbox: null,
    messages: [],
    selectedId: "",
    status: "",
    error: "",
    lastSync: 0
  };

  function randomText(length) {
    const chars = "abcdefghijkmnopqrstuvwxyz23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => chars[byte % chars.length]).join("");
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function normalizeProvider(id) {
    const k = String(id || "").toLowerCase().replace(/[\s._-]+/g, "");
    if (k === "mailtm") return "mailtm";
    if (k === "tempmaillol" || k === "tempmail") return "tempmaillol";
    if (k === "guerrillamail" || k === "guerrilla") return "guerrilla";
    if (k === "tempmailplus" || k === "tempmailpl") return "tempmailplus";
    if (k === "1secmail" || k === "onesecmail") return "onesecmail";
    if (k === "auto" || k === "") return "auto";
    return k;
  }

  function friendlyError(err) {
    const raw = String(err && err.message ? err.message : err || "Unknown error");
    if (err && err.blocked) return err.blockedWhy || "blocked by the provider";
    if (/HTTP\s*429/i.test(raw) || /rate.?limit/i.test(raw)) return "rate-limited, try again in a moment";
    if (/HTTP\s*5\d\d/i.test(raw)) return "temporarily unavailable";
    if (/HTTP\s*401|HTTP\s*403/i.test(raw)) return "session rejected";
    if (/HTTP\s*404/i.test(raw)) return "mailbox not found (it may have expired)";
    if (/abort|timeout|timed out/i.test(raw)) return "timed out";
    if (/network|Failed to fetch|Load failed/i.test(raw)) return "network error";
    return raw.replace(/^HTTP\s+\d+\s*:?\s*/i, "").slice(0, 140) || "unknown error";
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
        headers: Object.assign({ Accept: "application/json" }, options.headers || {}),
        body: options.body
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
      // Bot protection answers with an HTML challenge page (often with HTTP 200), never with JSON.
      if (typeof body === "string" && /<html|<!doctype|just a moment|attention required|cf-browser-verification|captcha/i.test(body.slice(0, 2000))) {
        const err = new Error(`HTTP ${response.status}: blocked`);
        err.status = response.status; err.blocked = true;
        err.blockedWhy = "blocked by the provider's bot protection (it returned a verification page)";
        throw err;
      }
      if (!response.ok) {
        let detail = "";
        if (body && typeof body === "object") {
          detail = body.message || body.error || body["hydra:description"] || body.detail || "";
          if (Array.isArray(body.violations) && body.violations[0]) {
            detail = body.violations.map(v => v.message || v.propertyPath).join("; ");
          }
        } else if (typeof body === "string") {
          detail = body.slice(0, 120);
        }
        const err = new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
        err.status = response.status;
        if (response.status === 403 || response.status === 451 || /blocked|forbidden|not allowed|banned|vpn|proxy|captcha/i.test(String(detail))) {
          err.blocked = true;
          err.blockedWhy = `blocked by the provider (HTTP ${response.status}${detail ? ": " + String(detail).slice(0, 80) : ""})`;
        }
        throw err;
      }
      return body;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Request timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const asList = data => {
    if (Array.isArray(data)) return data;
    return data?.["hydra:member"] || data?.member || data?.messages || data?.emails || data?.list || [];
  };

  const safeIso = value => {
    if (value == null || value === "") return "";
    const d = typeof value === "number" || /^\d+$/.test(String(value))
      ? new Date(Number(value) < 1e12 ? Number(value) * 1000 : Number(value))
      : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
  };

  const stripTags = html => String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

  /* ---------- Hydra API (Mail.tm) ---------- */

  function hydraDomains(data) {
    return asList(data)
      .filter(item => !(item && typeof item === "object" && item.isActive === false))
      .map(item => (typeof item === "string" ? item : item.domain || item.name || ""))
      .map(value => String(value).trim().toLowerCase())
      .filter(value => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value));
  }

  async function hydraToken(base, address, password) {
    const token = await request(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password })
    });
    if (!token || !token.token) throw new Error("no session token");
    return token.token;
  }

  async function createHydra(providerId) {
    const base = SERVICES[providerId].base;
    const domains = hydraDomains(await request(`${base}/domains?page=1`));
    if (!domains.length) throw new Error("no domains available");
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const domain = domains[Math.floor(Math.random() * domains.length)];
      const address = `${randomText(10)}${Date.now().toString(36).slice(-3)}@${domain}`;
      const password = `${randomText(8)}A1!${randomText(8)}`;
      try {
        await request(`${base}/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password })
        });
        const token = await hydraToken(base, address, password);
        return {
          provider: providerId,
          email: address.toLowerCase(),
          token,
          password,
          apiBase: base,
          createdAt: Date.now(),
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
        };
      } catch (e) {
        lastErr = e;
        if (e && e.status === 429) await sleep(1200 * (attempt + 1));
        else if (!(e && (e.status === 422 || e.status === 400))) break;
      }
    }
    throw lastErr || new Error("could not create account");
  }

  /** Runs a Hydra call; on 401 logs in again with the stored password and retries once. */
  async function hydraCall(mailbox, path) {
    const base = mailbox.apiBase || SERVICES[mailbox.provider]?.base;
    const run = () => request(`${base}${path}`, { headers: { Authorization: `Bearer ${mailbox.token}` } });
    try {
      return await run();
    } catch (e) {
      if (e && e.status === 401 && mailbox.password) {
        mailbox.token = await hydraToken(base, mailbox.email, mailbox.password);
        const st = await readState();
        if (st.mailbox && st.mailbox.email === mailbox.email) await set({ [STORAGE_KEY]: { ...st, mailbox: { ...st.mailbox, token: mailbox.token } } });
        return run();
      }
      throw e;
    }
  }

  async function listHydra(mailbox) {
    const data = await hydraCall(mailbox, "/messages?page=1");
    return asList(data)
      .map(item => ({
        id: String(item.id || ""),
        subject: String(item.subject || "No subject"),
        from: String(item.from?.address || item.from || "Unknown sender"),
        date: safeIso(item.createdAt),
        intro: String(item.intro || item.text || "").slice(0, 200)
      }))
      .filter(item => item.id);
  }

  async function readHydra(mailbox, id) {
    const item = await hydraCall(mailbox, `/messages/${encodeURIComponent(id)}`);
    const html = Array.isArray(item.html) ? item.html.join("") : String(item.html || "");
    return {
      id: String(item.id || id),
      subject: String(item.subject || "No subject"),
      from: String(item.from?.address || item.from || "Unknown sender"),
      date: safeIso(item.createdAt),
      text: String(item.text || item.intro || "") || stripTags(html),
      html
    };
  }

  /* ---------- TempMail.lol ---------- */

  async function createTempMailLol() {
    let data = null;
    let lastErr = null;
    const attempts = [
      () => request("https://api.tempmail.lol/v2/inbox/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      () => request("https://api.tempmail.lol/v2/inbox/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: null, captcha: null }) }),
      () => request("https://api.tempmail.lol/v2/inbox/create"),
      () => request("https://api.tempmail.lol/generate")
    ];
    for (const run of attempts) {
      try {
        data = await run();
        if (data && (data.address || data.email) && data.token) break;
        lastErr = new Error("empty response");
        data = null;
      } catch (e) {
        // Keep the most informative failure: a "blocked" answer beats a generic one.
        if (!lastErr || e.blocked || !lastErr.blocked) lastErr = e;
        data = null;
        if (e && e.status === 429) break;          // rate limited: more attempts only make it worse
        if (e && /timed out/i.test(String(e.message))) break;   // unreachable: other request shapes will hang too
      }
    }
    if (!data) throw lastErr || new Error("no address returned");
    const email = String(data.address || data.email || "").toLowerCase();
    const token = String(data.token || "");
    if (!email || !token) throw new Error("no address returned");
    return { provider: "tempmaillol", email, token, createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 };
  }

  // TempMail.lol messages carry no stable id, so derive one from their content.
  function lolId(item) {
    if (item.id || item._id) return String(item.id || item._id);
    const seed = `${item.date || ""}|${item.from || ""}|${item.subject || ""}`;
    let h = 5381;
    for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
    return `lol-${h.toString(36)}`;
  }

  async function fetchLolInbox(mailbox) {
    const data = await request(`https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(mailbox.token)}`);
    if (data && data.expired) throw new Error("HTTP 404: inbox expired");
    return asList(data);
  }

  async function listTempMailLol(mailbox) {
    return (await fetchLolInbox(mailbox)).map(item => ({
      id: lolId(item),
      subject: String(item.subject || "No subject"),
      from: String(item.from || item.sender || "Unknown sender"),
      date: safeIso(item.date || item.createdAt),
      intro: stripTags(item.body || item.text || item.html || "").slice(0, 200)
    }));
  }

  async function readTempMailLol(mailbox, id) {
    const full = (await fetchLolInbox(mailbox)).find(e => lolId(e) === id);
    if (!full) throw new Error("Message not found.");
    const html = String(full.html || "");
    return {
      id,
      subject: String(full.subject || "No subject"),
      from: String(full.from || full.sender || "Unknown sender"),
      date: safeIso(full.date || full.createdAt),
      text: String(full.body || full.text || "") || stripTags(html),
      html
    };
  }

  /* ---------- Guerrilla Mail ---------- */

  const GM = "https://api.guerrillamail.com/ajax.php";

  async function createGuerrilla() {
    const data = await request(`${GM}?f=get_email_address&lang=en&ip=127.0.0.1&agent=MeMik`);
    if (!data?.email_addr || !data?.sid_token) throw new Error("no address returned");
    return {
      provider: "guerrilla",
      email: String(data.email_addr).toLowerCase(),
      token: String(data.sid_token),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000
    };
  }

  async function listGuerrilla(mailbox) {
    const data = await request(`${GM}?f=get_email_list&sid_token=${encodeURIComponent(mailbox.token)}&offset=0&ip=127.0.0.1&agent=MeMik`);
    return asList(data)
      .map(item => ({
        id: String(item.mail_id || item.email_id || ""),
        subject: String(item.mail_subject || "No subject"),
        from: String(item.mail_from || "Unknown sender"),
        date: item.mail_timestamp ? safeIso(Number(item.mail_timestamp)) : safeIso(item.mail_date),
        intro: String(item.mail_excerpt || "").slice(0, 200)
      }))
      .filter(item => item.id && item.id !== "0");
  }

  async function readGuerrilla(mailbox, id) {
    const item = await request(`${GM}?f=fetch_email&sid_token=${encodeURIComponent(mailbox.token)}&email_id=${encodeURIComponent(id)}&ip=127.0.0.1&agent=MeMik`);
    if (!item || !item.mail_id) throw new Error("Message not found.");
    const html = String(item.mail_body || "");
    return {
      id: String(item.mail_id || id),
      subject: String(item.mail_subject || "No subject"),
      from: String(item.mail_from || "Unknown sender"),
      date: item.mail_timestamp ? safeIso(Number(item.mail_timestamp)) : safeIso(item.mail_date),
      text: stripTags(html) || String(item.mail_excerpt || ""),
      html
    };
  }

  /* ---------- Tempmail.plus (stateless: any address on its domains is a mailbox) ---------- */

  const TMP_DOMAINS = ["mailto.plus", "fexpost.com", "fexbox.org", "mailbox.in.ua", "rover.info", "chitthi.in", "fextemp.com", "any.pink", "merepost.com"];
  const tmpUrl = (path, email) => `https://tempmail.plus/api/mails${path}${path.includes("?") ? "&" : "?"}email=${encodeURIComponent(email)}&epin=`;

  async function createTempMailPlus() {
    const domain = TMP_DOMAINS[Math.floor(Math.random() * TMP_DOMAINS.length)];
    const email = `${randomText(10)}@${domain}`;
    // The address needs no registration, so prove the service is reachable before handing it out.
    const data = await request(tmpUrl("?limit=20", email));
    if (!data || data.result === false) throw new Error("service rejected the address");
    return { provider: "tempmailplus", email, token: email, createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 };
  }
  async function listTempMailPlus(mailbox) {
    const data = await request(tmpUrl("?limit=20", mailbox.email));
    if (data && data.result === false) throw new Error("HTTP 404: mailbox unavailable");
    return asList(data && data.mail_list).map(m => ({
      id: String(m.mail_id), subject: String(m.subject || "No subject"),
      from: String(m.from_mail || m.from_name || "Unknown sender"), date: safeIso(m.time), intro: ""
    })).filter(m => m.id && m.id !== "undefined");
  }
  async function readTempMailPlus(mailbox, id) {
    const d = await request(tmpUrl(`/${encodeURIComponent(id)}?`, mailbox.email).replace("?&", "?"));
    if (!d || d.result === false) throw new Error("Message not found.");
    const html = String(d.html || "");
    return { id: String(id), subject: String(d.subject || "No subject"), from: String(d.from_mail || d.from_name || "Unknown sender"),
      date: safeIso(d.date), text: String(d.text || "") || stripTags(html), html };
  }

  /* ---------- 1secmail (kept for completeness, not in Auto) ---------- */

  async function createOneSecMail() {
    const data = await request("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1");
    const email = Array.isArray(data) ? data[0] : null;
    if (!email || !String(email).includes("@")) throw new Error("no address returned");
    const [login, domain] = String(email).toLowerCase().split("@");
    return { provider: "onesecmail", email: `${login}@${domain}`, token: `${login}@${domain}`, login, domain, createdAt: Date.now() };
  }
  async function listOneSecMail(mailbox) {
    const data = await request(`https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(mailbox.login)}&domain=${encodeURIComponent(mailbox.domain)}`);
    return asList(data).map(m => ({ id: String(m.id), from: m.from || "", subject: m.subject || "No subject", date: safeIso(m.date), intro: "" }));
  }
  async function readOneSecMail(mailbox, id) {
    const d = await request(`https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(mailbox.login)}&domain=${encodeURIComponent(mailbox.domain)}&id=${encodeURIComponent(id)}`);
    return { id: String(id), subject: d?.subject || "No subject", from: d?.from || "", date: safeIso(d?.date), text: d?.textBody || stripTags(d?.htmlBody), html: d?.htmlBody || "" };
  }

  /* ---------- dispatch ---------- */

  function normalizeMailbox(box) {
    const email = String(box && (box.email || box.address) || "").toLowerCase().trim();
    if (!email || !email.includes("@")) throw new Error("Provider did not return a valid email address.");
    return { ...box, email, address: email };
  }

  async function createMailbox(provider) {
    const kind = SERVICES[provider]?.kind;
    if (kind === "hydra") return createHydra(provider);
    if (kind === "tempmaillol") return createTempMailLol();
    if (kind === "guerrilla") return createGuerrilla();
    if (kind === "tempmailplus") return createTempMailPlus();
    if (kind === "onesecmail") return createOneSecMail();
    throw new Error("Unsupported temporary email provider.");
  }

  async function listMessages(mailbox) {
    const kind = SERVICES[mailbox.provider]?.kind;
    let list = [];
    if (kind === "hydra") list = await listHydra(mailbox);
    else if (kind === "tempmaillol") list = await listTempMailLol(mailbox);
    else if (kind === "guerrilla") list = await listGuerrilla(mailbox);
    else if (kind === "tempmailplus") list = await listTempMailPlus(mailbox);
    else if (kind === "onesecmail") list = await listOneSecMail(mailbox);
    return list.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  }

  async function readMessage(mailbox, id) {
    const kind = SERVICES[mailbox.provider]?.kind;
    if (kind === "hydra") return readHydra(mailbox, id);
    if (kind === "tempmaillol") return readTempMailLol(mailbox, id);
    if (kind === "guerrilla") return readGuerrilla(mailbox, id);
    if (kind === "tempmailplus") return readTempMailPlus(mailbox, id);
    if (kind === "onesecmail") return readOneSecMail(mailbox, id);
    throw new Error("No temporary email is active.");
  }

  function publicState(data) {
    const mailbox = data.mailbox
      ? {
          provider: data.mailbox.provider,
          email: data.mailbox.email,
          createdAt: data.mailbox.createdAt,
          expiresAt: data.mailbox.expiresAt
        }
      : null;
    return {
      ok: true,
      provider: data.provider || "auto",
      mailbox,
      messages: data.messages || [],
      selectedId: data.selectedId || "",
      status: data.status || "",
      error: data.error || "",
      lastSync: data.lastSync || 0
    };
  }

  async function schedule(enabled) {
    await chrome.alarms.clear(ALARM);
    if (enabled) await chrome.alarms.create(ALARM, { delayInMinutes: REFRESH_MINUTES, periodInMinutes: REFRESH_MINUTES });
  }

  async function saveState(next) {
    await set({ [STORAGE_KEY]: next });
    return publicState(next);
  }

  async function readState() {
    const data = await get({ [STORAGE_KEY]: stateDefaults });
    return { ...stateDefaults, ...(data[STORAGE_KEY] || {}) };
  }

  // Starts providers one after another (every 1.5 s) but does not wait for slow or failing ones:
  // the first mailbox that is created wins.
  function raceCreate(order, errors) {
    return new Promise((resolve, reject) => {
      let settled = false, finished = 0;
      const done = () => { finished++; if (!settled && finished === order.length) reject(new Error("none")); };
      order.forEach((provider, i) => {
        setTimeout(async () => {
          if (settled) { done(); return; }
          try {
            const mailbox = normalizeMailbox(await createMailbox(provider));
            if (!settled) { settled = true; resolve({ provider, mailbox }); }
          } catch (error) {
            errors.push(`${SERVICES[provider].name}: ${friendlyError(error)}`);
          }
          done();
        }, i * 1500);
      });
    });
  }

  let genSeq = 0;
  async function generate(requested) {
    const mySeq = ++genSeq;
    const data = await readState();
    const prefStore = await get({ tempMailProvider: "" });
    const pick = normalizeProvider(requested || prefStore.tempMailProvider || data.provider || "auto");
    if (pick !== "auto" && !SERVICES[pick]) throw new Error("Unknown provider: " + pick);
    const errors = [];
    try {
      const { provider, mailbox } = pick === "auto"
        ? await raceCreate(AUTO_ORDER, errors)
        : { provider: pick, mailbox: normalizeMailbox(await createMailbox(pick)) };
      // A newer "New address" request started while this one was slow: its result wins, this one is discarded.
      if (mySeq !== genSeq) return publicState(await readState());
      const next = { ...stateDefaults, provider: pick, mailbox, status: `${SERVICES[provider].name} address ready.` };
      await schedule(true);
      const out = await saveState(next);
      refresh().catch(() => {});             // prime the inbox so the first poll is already warm
      return out;
    } catch (error) {
      if (pick !== "auto") errors.push(`${SERVICES[pick].name}: ${friendlyError(error)}`);
      const message = errors.join(" · ") || "No temporary email provider is available right now.";
      if (mySeq === genSeq) await saveState({ ...(await readState()), provider: pick, status: "", error: message });   // never clobber a newer result
      throw new Error(message);
    }
  }

  /** Checks every provider end to end (create + read inbox) without touching the saved mailbox. */
  async function diagnose() {
    const ids = Object.keys(SERVICES).filter(k => !SERVICES[k].hidden);
    return Promise.all(ids.map(async id => {
      const t0 = Date.now();
      try {
        const mailbox = normalizeMailbox(await createMailbox(id));
        await listMessages(mailbox);
        return { id, name: SERVICES[id].name, ok: true, ms: Date.now() - t0 };
      } catch (error) {
        return { id, name: SERVICES[id].name, ok: false, ms: Date.now() - t0, error: friendlyError(error) };
      }
    }));
  }

  // Single-flight: overlapping refreshes (the post-create warm-up, the alarm, a manual tap) share one request.
  let refreshing = null;
  function refresh() {
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function doRefresh() {
    const data = await readState();
    if (!data.mailbox?.token || !SERVICES[data.mailbox.provider]) return publicState(data);
    try {
      const messages = await listMessages(data.mailbox);
      // Re-read: a token refresh may have updated the stored mailbox meanwhile.
      const latest = await readState();
      const next = {
        ...latest,
        messages,
        error: "",
        status: messages.length ? `${messages.length} message${messages.length === 1 ? "" : "s"}.` : "Inbox is empty.",
        lastSync: Date.now()
      };
      return saveState(next);
    } catch (error) {
      const latest = await readState();
      const next = { ...latest, error: friendlyError(error), status: "Inbox refresh failed." };
      await saveState(next);
      return publicState(next);
    }
  }

  async function getMessage(id) {
    const data = await readState();
    if (!data.mailbox?.token || !id || !SERVICES[data.mailbox.provider]) throw new Error("No temporary email is active.");
    const message = await readMessage(data.mailbox, id);
    await saveState({ ...(await readState()), selectedId: message.id });
    return { ok: true, message };
  }

  async function closeReader() {
    return saveState({ ...(await readState()), selectedId: "" });
  }

  async function clear() {
    await chrome.alarms.clear(ALARM);
    const prev = await readState();
    const next = { ...stateDefaults, provider: prev.provider || "auto" };
    await set({ [STORAGE_KEY]: next });
    return publicState(next);
  }

  async function onBoot() {
    const data = await readState();
    if (data.mailbox?.token) {
      await schedule(true);
      refresh().catch(() => {});
    }
  }

  global.TempMail = {
    ALARM, SERVICES, HOSTS, AUTO_ORDER,
    generate, refresh, getMessage, closeReader, clear, onBoot, diagnose,
    getState: async () => publicState(await readState()),
    _internals: { stripTags, lolId, safeIso, hydraDomains }
  };
})(globalThis);
