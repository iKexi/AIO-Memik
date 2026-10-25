// Dependency-free checks: run with `node tests/smoke-test.js` from the extension root
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const exists = f => fs.existsSync(path.join(root, f));

const required = [
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "content/content.js",
  "content/temp-mail-page.js",
  "content/adblock-page.js",
  "content/anti-main.js",
  "background/background.js",
  "background/temp-mail.js",
  "background/automation-policy.js",
  "background/proxy-scope.js",
  "icons/logo.svg",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

for (const f of required) assert(exists(f), `Missing ${f}`);

const manifest = JSON.parse(read("manifest.json"));
assert.strictEqual(manifest.manifest_version, 3);
for (const p of ["scripting", "storage", "alarms"]) assert(manifest.permissions.includes(p), `permission ${p}`);
assert(manifest.icons["128"] && manifest.action.default_icon["16"], "icons declared");
assert.strictEqual(manifest.action.default_popup, "popup/popup.html");
assert.strictEqual(manifest.background.service_worker, "background/background.js");

assert(!/id="command"/.test(read("popup/popup.html")), "typed-command UI must be gone");
assert(/id="exportBtn"/.test(read("popup/popup.html")) && /id="importBtn"/.test(read("popup/popup.html")), "import/export controls present");
assert(/id="themeBtn"/.test(read("popup/popup.html")), "dark mode toggle present");
assert(/exportOneRoutine|data-act=\"export\"/.test(read("popup/popup.js")), "per-routine export present");
assert(/renderTimerOnly|elapsedMs/.test(read("popup/popup.js")), "timer helpers present");
assert(/id="historyBackBtn"/.test(read("popup/popup.html")) && /id="historyForwardBtn"/.test(read("popup/popup.html")), "history insertion controls present");
assert(/id="passwordCard"|id="pwSaveBtn"|savedPasswords/.test(read("popup/popup.html") + read("popup/popup.js")), "password vault UI present");
assert(/kind: "history"/.test(read("popup/popup.js")) && /history\.back\(\)|history\.forward\(\)/.test(read("content/content.js")), "history recording/replay present");
assert(/version: 1|version !== 1/.test(read("popup/popup.js") + read("background/background.js")), "versioned import/export schema present");
assert(/schedules|runStatus/.test(read("popup/popup.js")), "popup knows transient state separately");
assert(/"password"/.test(read("content/content.js")) && /isPasswordField|isPassword/.test(read("content/content.js") + read("background/automation-policy.js")), "password field recording supported");

const importCode = read("background/background.js").split('case "importRoutines"')[1]?.split('case "runRoutine"')[0] || "";
assert(importCode && !/executeRoutine/.test(importCode), "import does not execute routines");

for (const f of [
  "popup/popup.js",
  "content/content.js",
  "background/background.js",
  "background/automation-policy.js",
  "background/proxy-scope.js",
  "background/temp-mail.js",
  "content/temp-mail-page.js"
]) {
  try {
    new Function(read(f));
  } catch (e) {
    assert.fail(`Syntax error in ${f}: ${e.message}`);
  }
}

const tm = read("background/temp-mail.js");
assert(/mailtm/.test(tm) && /tempmaillol/.test(tm) && /guerrilla/.test(tm), "multiple temp-mail providers present");
assert(!/api\.mail\.gw/.test(tm), "dead mail.gw provider removed");
assert(/id="tempMailCard"/.test(read("popup/popup.html")), "temp mail UI present");
assert(/tempmaillol|guerrilla/.test(read("popup/popup.html")), "provider options updated");
assert(/tempMailGenerate/.test(read("background/background.js")), "temp mail message handlers present");

// Load automation policy and run safety checks
const sandbox = { URL, URLSearchParams, chrome: { storage: { local: {} } } };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(read("background/automation-policy.js"), sandbox);
const policy = sandbox.AutomationPolicy || sandbox.globalThis.AutomationPolicy;
assert(policy, "AutomationPolicy exported");

function yes(cond, msg) { assert(cond, msg); }
function no(cond, msg) { assert(!cond, msg); }

yes(policy.recordableUrl("https://example.com/page"), "normal https allowed");
no(policy.recordableUrl("https://u:p@example.com/"), "credentials in URL refused");
no(policy.recordableUrl("chrome://extensions"), "non-http refused");
yes(policy.safeUrl("https://example.com/authors"), "'authors' is not 'auth'");
no(policy.safeUrl("https://example.com/checkout"), "checkout link refused");
for (const text of ["Card number", "cc-number", "Delete account", "Pay now", "Log out"]) {
  yes(policy.sensitiveControl.test(text), text);
}
no(policy.sensitiveControl.test("Submit"), "Submit label allowed for login forms");
no(policy.sensitiveControl.test("Log in"), "Log in label allowed");
for (const text of ["one-time-code", "api_key", "client-secret", "bearer token"]) {
  yes(policy.isSensitiveField({ autocomplete: text }), text);
}
yes(policy.isPasswordField({ type: "password" }), "type=password is a password field");
yes(policy.isPasswordField({ autocomplete: "current-password" }), "current-password autocomplete");
no(policy.isSensitiveField({ type: "password", text: "Password" }), "plain password field is not sensitive");
for (const text of ["Search", "Add item", "Sender", "Discard changes", "Cards", "Next", "Log in"]) {
  no(policy.sensitiveControl.test(text), text);
}
const button = { kind: "click", target: { selector: "#add", text: "Add item", tag: "button", type: "submit" } };
yes(policy.validAction(button), "plain <button> (type=submit by default) is valid");
yes(policy.validAction({ kind: "history", direction: "back" }), "back history step is valid");
yes(policy.validAction({ kind: "history", direction: "forward" }), "forward history step is valid");
no(policy.validAction({ kind: "history", direction: "sideways" }), "invalid history direction refused");
no(policy.validAction({ kind: "history" }), "history step requires a direction");
yes(policy.validAction({ kind: "input", value: "s3cret", target: { selector: "#p", text: "Password", tag: "input", type: "password" } }), "password input is valid");
yes(policy.validAction({ kind: "input", value: "", passwordId: "abc123", target: { selector: "#p", text: "Password", tag: "input", type: "password", isPassword: true } }), "vault-linked password input is valid");
no(policy.validAction({ kind: "input", value: "secret", target: { selector: "#search", text: "Search", tag: "input", type: "text", autocomplete: "one-time-code" } }), "OTP autocomplete invalid");
no(policy.validAction({ kind: "scroll", x: -1, y: 0 }), "negative scroll invalid");

console.log("Smoke test passed.");
