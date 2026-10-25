(function () {
  "use strict";
  if (window.__memikTempMailField) return;
  window.__memikTempMailField = true;

  let host = null;
  let shadow = null;
  let target = null;
  let hideTimer = null;
  let positionFrame = 0;

  function isEmailField(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
    const type = String(el.type || "text").toLowerCase();
    const meta = [el.name, el.id, el.getAttribute("autocomplete"), el.placeholder, el.getAttribute("aria-label")]
      .filter(Boolean).join(" ");
    return type === "email" || /(^|[\s_-])e-?mail([\s_-]|$)/i.test(meta);
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
  }

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement("span");
    host.setAttribute("data-memik-temp-mail", "true");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483646;pointer-events:none;display:none;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host, * { box-sizing: border-box; }
      button { all: initial; width: 26px; height: 26px; display: grid; place-items: center; pointer-events: auto; cursor: pointer; border: 1px solid rgba(0,0,0,.14); border-radius: 8px; background: #fff; box-shadow: 0 3px 12px rgba(0,0,0,.2); }
      button:hover { transform: translateY(-1px); box-shadow: 0 5px 16px rgba(0,0,0,.25); }
      button:disabled { opacity: .55; cursor: wait; transform: none; }
      img { width: 17px; height: 17px; display: block; }
    </style><button type="button" aria-label="Generate temporary email" title="Generate temporary email"><img alt=""></button>`;
    (document.documentElement || document.body).appendChild(host);
    const button = shadow.querySelector("button");
    const image = shadow.querySelector("img");
    if (image) image.src = chrome.runtime.getURL("icons/icon-16.png");
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", generate);
  }

  function place() {
    positionFrame = 0;
    if (!target || !visible(target)) { hide(); return; }
    ensure();
    const rect = target.getBoundingClientRect();
    const size = 26;
    const left = Math.max(4, Math.min(innerWidth - size - 4, rect.right - size - 6));
    const top = Math.max(4, Math.min(innerHeight - size - 4, rect.top + (rect.height - size) / 2));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.display = "block";
  }

  function schedulePlace() {
    if (!positionFrame) positionFrame = requestAnimationFrame(place);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host) host.style.display = "none";
    target = null;
  }

  function show(input) {
    if (!isEmailField(input)) return;
    clearTimeout(hideTimer);
    target = input;
    ensure();
    shadow.querySelector("button").disabled = false;
    schedulePlace();
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  async function generate() {
    const input = target;
    if (!input) return;
    const button = shadow.querySelector("button");
    button.disabled = true;
    button.title = "Generating…";
    try {
      const reply = await chrome.runtime.sendMessage({ type: "tempMailGenerate", provider: "auto" });
      if (!reply?.ok || !reply.email) throw new Error(reply?.error || "Could not create a temporary email.");
      setInputValue(input, reply.email);
      button.title = reply.email;
    } catch (error) {
      button.title = error.message || "Temporary email unavailable";
    } finally {
      button.disabled = false;
      schedulePlace();
    }
  }

  document.addEventListener("focusin", event => {
    if (isEmailField(event.target)) show(event.target);
  }, true);
  document.addEventListener("input", event => {
    if (isEmailField(event.target)) show(event.target);
  }, true);
  document.addEventListener("focusout", event => {
    if (event.target !== target) return;
    hideTimer = setTimeout(() => {
      if (!shadow?.activeElement) hide();
    }, 250);
  }, true);
  addEventListener("resize", schedulePlace, true);
  addEventListener("scroll", schedulePlace, true);
})();
