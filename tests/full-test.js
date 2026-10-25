// Full package checks: run with `node tests/full-test.js` from the extension root
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const exists = f => fs.existsSync(path.join(root, f));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok  " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL  " + name + " — " + e.message);
  }
}

const m = JSON.parse(read("manifest.json"));

t("manifest v3", () => assert.strictEqual(m.manifest_version, 3));
t("popup path", () => assert.strictEqual(m.action.default_popup, "popup/popup.html"));
t("service worker path", () => assert.strictEqual(m.background.service_worker, "background/background.js"));
t("MAIN-world script declared", () =>
  assert(m.content_scripts.some(c => c.world === "MAIN" && c.js.some(j => j.includes("anti-main.js"))))
);
t("temp-mail content script declared", () =>
  assert(m.content_scripts.some(c => c.js.some(j => j.includes("temp-mail-page.js"))))
);
t("web_accessible_resources for icons", () =>
  assert(m.web_accessible_resources && m.web_accessible_resources.some(r => r.resources.some(x => x.includes("icon-16"))))
);

for (const f of fs.readdirSync(path.join(root, "background")).filter(f => f.endsWith(".js"))) {
  t("syntax background/" + f, () => new Function(read("background/" + f)));
}
for (const f of fs.readdirSync(path.join(root, "content")).filter(f => f.endsWith(".js"))) {
  t("syntax content/" + f, () => new Function(read("content/" + f)));
}
t("syntax popup/popup.js", () => new Function(read("popup/popup.js")));

for (const f of ["content/adblock-page.js", "content/content.js", "background/background.js", "popup/popup.js", "content/anti-main.js"]) {
  t("no dynamic script injection in " + f, () => assert(!/createElement\(["']script["']\)/.test(read(f)), f));
}

t("popup ids resolve", () => {
  const h = read("popup/popup.html");
  const js = read("popup/popup.js");
  const ids = new Set([...h.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]));
  const guarded = new Set(["darkSwitch", "swatches", "adblockBtn", "captchaCancelBtn", "schedValue"]);
  const miss = [...new Set([...js.matchAll(/(?:getElementById|\$)\(["']([\w-]+)["']\)/g)].map(x => x[1]))]
    .filter(i => !ids.has(i) && !guarded.has(i));
  assert(!miss.length, "missing ids: " + miss.join(", "));
});

t("dup ids in popup.html", () => {
  const ids = [...read("popup/popup.html").matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
  const d = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert(!d.length, d.join(", "));
});

t("block counter wired", () => {
  const b = read("background/background.js");
  assert(/onRuleMatchedDebug/.test(b) && /blockStats/.test(b));
  assert(m.permissions.includes("declarativeNetRequestFeedback"));
  assert(/id="statAds"/.test(read("popup/popup.html")));
});

t("live proxy check wired", () => {
  const b = read("background/background.js");
  assert(/proxyCheck/.test(b) && /measurePing/.test(b));
});

t("filter update avoids GitHub release API dependency", () => {
  const b = read("background/background.js");
  assert(!/UBOL_RELEASES_API/.test(b));
  assert(/cdn\.jsdelivr\.net/.test(b));
  assert(/adblockUpdateRunning/.test(b));
});

t("temporary email autofill is wired", () => {
  const h = read("popup/popup.html");
  const mtext = read("manifest.json");
  const b = read("background/background.js");
  assert(/id="tempMailCard"/.test(h));
  assert(/temp-mail-page\.js/.test(mtext));
  assert(/tempMailGenerate/.test(b));
  assert(exists("background/temp-mail.js"));
  assert(exists("content/temp-mail-page.js"));
  assert(/tempmaillol|guerrilla/.test(h));
  assert(!/mailgw/.test(h));
});

t("theme: white light / AMOLED dark", () => {
  const c = read("popup/popup.css");
  assert(/FINAL THEME LAYER/.test(c) && /--bg: #000000 !important/.test(c) && /--bg: #ffffff !important/.test(c));
});

t("no stray text after </html>", () => assert(/<\/html>\s*$/.test(read("popup/popup.html"))));

let total = 0;
for (const r of m.declarative_net_request.rule_resources) {
  t("ruleset " + r.id, () => {
    const j = JSON.parse(read(r.path));
    assert(Array.isArray(j));
    total += j.length;
    const ids = new Set();
    j.forEach(x => {
      assert(Number.isInteger(x.id) && x.id > 0, "id");
      assert(!ids.has(x.id), "dup id " + x.id);
      ids.add(x.id);
      assert(x.action && x.action.type, "action");
      assert(x.condition, "cond");
    });
  });
}
t("static rule total under Chrome global limit (330000)", () => assert(total <= 330000, String(total)));
t("icons are PNG", () =>
  ["16", "32", "48", "128"].forEach(s =>
    assert(fs.readFileSync(path.join(root, `icons/icon-${s}.png`)).slice(1, 4).toString() === "PNG")
  )
);

console.log(`\n${pass} passed, ${fail} failed, ${total} static rules`);
process.exit(fail ? 1 : 0);
