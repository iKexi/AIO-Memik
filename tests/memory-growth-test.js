/**
 * Memory Growth Test for MeMik
 * Runs a batch-style workload 1000 times in sequence (simulating /api/process-batch style loop).
 * Tracks heap memory after each iteration.
 * Flags any run where memory grows >5% vs previous.
 * Produces a simple ASCII memory growth chart and identifies likely root causes.
 *
 * Run: node --expose-gc tests/memory-growth-test.js
 * ( --expose-gc recommended for clearer readings )
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const v8 = require("v8");

const ITERATIONS = 1000;
const GROWTH_THRESHOLD = 0.05; // 5%
const samples = [];
const flags = [];

// Lightweight simulation of a "process-batch" workload that mirrors
// patterns found in the extension (proxy list parsing, allowlist ops,
// temporary object creation for rules / temp-mail state, etc.)
function processBatchIteration(i) {
  // Allocate temporary structures similar to real code paths
  const proxyLines = [];
  for (let k = 0; k < 50; k++) {
    proxyLines.push(`${(i * 17 + k) % 255}.${k % 255}.1.1:${8000 + (k % 100)}`);
  }
  const parsed = proxyLines.map((l) => {
    const [host, port] = l.split(":");
    return { host, port: Number(port), latency: Math.random() * 200, ok: Math.random() > 0.3 };
  });

  // Simulate filter / ruleset work
  const rules = new Array(20).fill(0).map((_, idx) => ({
    id: `r-${i}-${idx}`,
    urlFilter: `||example${idx}.com^`,
    action: { type: "block" }
  }));

  // Simulate temp-mail / storage shaped objects
  const mailbox = {
    email: `user${i}@temp.example`,
    token: Buffer.from(`tok-${i}`).toString("base64"),
    messages: new Array(5).fill(0).map((_, m) => ({
      id: m,
      subject: `Msg ${m}`,
      body: "x".repeat(200)
    }))
  };

  // Force some retention pressure (intentional leak candidate for diagnosis)
  // In a real bug this might be an unbounded cache; here we keep a rolling window.
  if (!global.__memTestCache) global.__memTestCache = [];
  global.__memTestCache.push({ parsed, rules, mailbox, ts: Date.now() });
  if (global.__memTestCache.length > 80) {
    // retain last 80 — growth should stabilize; if we removed this, growth would be linear
    global.__memTestCache = global.__memTestCache.slice(-80);
  }

  // Return a summary so caller doesn't keep large objects
  return {
    proxiesOk: parsed.filter((p) => p.ok).length,
    rules: rules.length,
    mailbox: mailbox.email
  };
}

function heapUsedMB() {
  if (typeof global.gc === "function") {
    global.gc();
  }
  const m = process.memoryUsage();
  return {
    heapUsed: m.heapUsed / 1024 / 1024,
    heapTotal: m.heapTotal / 1024 / 1024,
    external: m.external / 1024 / 1024,
    rss: m.rss / 1024 / 1024
  };
}

function asciiChart(values, width = 60, height = 12) {
  if (values.length === 0) return "(no data)";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = Math.max(1, Math.floor(values.length / width));
  const cols = [];
  for (let i = 0; i < values.length; i += step) {
    cols.push(values[i]);
  }
  const lines = [];
  for (let row = height; row >= 0; row--) {
    const threshold = min + (range * row) / height;
    let line = "";
    for (const v of cols) {
      line += v >= threshold ? "█" : " ";
    }
    const label = row === height ? max.toFixed(1) : row === 0 ? min.toFixed(1) : "";
    lines.push(line + (label ? ` ${label} MB` : ""));
  }
  lines.push("─".repeat(cols.length) + " iterations →");
  return lines.join("\n");
}

async function main() {
  console.log("MeMik — Sequential batch memory growth test");
  console.log(`Iterations: ${ITERATIONS}, flag threshold: >${GROWTH_THRESHOLD * 100}% growth\n`);

  let prev = heapUsedMB().heapUsed;
  samples.push({ i: 0, heap: prev });

  for (let i = 1; i <= ITERATIONS; i++) {
    processBatchIteration(i);
    const mem = heapUsedMB();
    const heap = mem.heapUsed;
    samples.push({ i, heap, rss: mem.rss });

    if (prev > 0) {
      const growth = (heap - prev) / prev;
      if (growth > GROWTH_THRESHOLD) {
        flags.push({ iteration: i, prev, heap, growthPct: (growth * 100).toFixed(2) });
        console.log(
          `FLAG @ iter ${i}: heap ${prev.toFixed(2)} → ${heap.toFixed(2)} MB (+${(growth * 100).toFixed(2)}%)`
        );
      }
    }
    prev = heap;

    if (i % 200 === 0) {
      console.log(`  … ${i}/${ITERATIONS}  heap=${heap.toFixed(2)} MB`);
    }
  }

  const heaps = samples.map((s) => s.heap);
  const first = heaps[0];
  const last = heaps[heaps.length - 1];
  const peak = Math.max(...heaps);

  console.log("\n===== Memory Growth Chart (heapUsed MB) =====");
  console.log(asciiChart(heaps));
  console.log(`\nStart: ${first.toFixed(2)} MB | Peak: ${peak.toFixed(2)} MB | End: ${last.toFixed(2)} MB`);
  console.log(`Total growth: ${(((last - first) / first) * 100).toFixed(2)}%`);
  console.log(`Flags (>${GROWTH_THRESHOLD * 100}% step growth): ${flags.length}`);

  // Diagnosis
  console.log("\n===== Likely root-cause analysis =====");
  const overallGrowth = (last - first) / first;
  if (flags.length === 0 && overallGrowth < 0.15) {
    console.log("• Memory appears stable. Rolling cache / bounded retention is working.");
    console.log("• No unbounded accumulation detected across 1000 sequential batch runs.");
  } else {
    console.log("• Observed growth patterns:");
    if (flags.length > 5) {
      console.log("  - Frequent step growth → possible per-iteration allocation that is not released");
      console.log("    (e.g. arrays/objects pushed to a global cache without eviction, or closures retaining large buffers).");
    }
    if (overallGrowth > 0.3) {
      console.log("  - Overall >30% growth → suspect an unbounded collection (Map/Set/array) or");
      console.log("    event listeners / chrome.storage listeners accumulating across calls.");
    }
    console.log("  - Common extension-specific causes:");
    console.log("    1. DeclarativeNetRequest rule arrays rebuilt without clearing previous session rules.");
    console.log("    2. Temp-mail message bodies or proxy probe results retained in module-level arrays.");
    console.log("    3. Large string concatenations for filter lists that are not reused via intern/cache.");
    console.log("    4. Missing nulling of large temporary objects before await points (GC delayed).");
  }

  // Write a small JSON report for later inspection
  const report = {
    iterations: ITERATIONS,
    threshold: GROWTH_THRESHOLD,
    startMB: first,
    peakMB: peak,
    endMB: last,
    flags,
    samplesEvery: 50,
    samples: samples.filter((_, idx) => idx % 50 === 0)
  };
  const out = path.join(__dirname, "memory-growth-report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
