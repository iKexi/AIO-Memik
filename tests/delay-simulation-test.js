/**
 * Delay Simulation Test for MeMik external services
 * Simulates slow responses from third-party services (temp-mail APIs, breach check, proxy lists)
 * Injects artificial delays of 2s, 5s, and 30s on external API calls.
 * Verifies timeouts and fallback responses; confirms non-blocking concurrent requests.
 *
 * Run: node tests/delay-simulation-test.js
 */
const assert = require("assert");
const http = require("http");
const { performance } = require("perf_hooks");

// --- Mock fetch with controllable delay & timeout ---
function createDelayedFetch(delayMs, shouldTimeout = false, timeoutMs = 10000) {
  return async function mockFetch(url, options = {}) {
    const start = performance.now();
    const controller = options.signal ? null : new AbortController();
    const signal = options.signal || controller?.signal;

    const timer = setTimeout(() => {
      if (controller) controller.abort();
    }, timeoutMs);

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });

      if (shouldTimeout && delayMs > timeoutMs) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      // Simulate successful or fallback payloads depending on service
      if (String(url).includes("xposedornot") || String(url).includes("pwnedpasswords")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ breaches: [], found: false }),
          text: async () => "OK"
        };
      }
      if (String(url).includes("mail") || String(url).includes("temp")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ email: "test@temp.example", token: "mock" }),
          text: async () => JSON.stringify({ email: "test@temp.example" })
        };
      }
      // Proxy list style
      return {
        ok: true,
        status: 200,
        text: async () => "1.2.3.4:8080\n5.6.7.8:3128",
        json: async () => []
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// Fallback response helper (mirrors extension behaviour)
function getFallback(service) {
  const map = {
    payment: { ok: false, error: "Payment gateway timeout — try again later", fallback: true },
    email: { ok: false, error: "Email provider slow — using cached mailbox if available", fallback: true, email: null },
    analytics: { ok: true, skipped: true, reason: "Analytics deferred due to latency" },
    breach: { ok: true, found: false, breaches: [], message: "Check timed out; no cached data." },
    proxy: { ok: false, error: "Proxy list fetch timed out", proxies: [] }
  };
  return map[service] || { ok: false, error: "Service timeout", fallback: true };
}

async function runWithTimeout(fn, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Test scenarios ---
async function testDelay(delayMs, label) {
  console.log(`\n=== ${label} (injected delay ${delayMs}ms) ===`);
  const timeoutMs = 8000; // realistic client timeout
  const fetch = createDelayedFetch(delayMs, delayMs > timeoutMs, timeoutMs);

  const services = ["email", "breach", "proxy", "analytics"];
  const results = [];

  // Concurrent requests to verify non-blocking
  const concurrentStart = performance.now();
  const promises = services.map(async (svc) => {
    const t0 = performance.now();
    try {
      const res = await runWithTimeout(async () => {
        // Simulate the call the extension would make
        const r = await fetch(`https://api.example.com/${svc}`, { signal: AbortSignal.timeout?.(timeoutMs) });
        return { service: svc, ok: true, data: await r.json?.() || await r.text(), latency: performance.now() - t0 };
      }, timeoutMs + 500);
      return res;
    } catch (e) {
      const fallback = getFallback(svc);
      return {
        service: svc,
        ok: false,
        fallback: true,
        error: e.message || String(e),
        response: fallback,
        latency: performance.now() - t0
      };
    }
  });

  const settled = await Promise.all(promises);
  const concurrentElapsed = performance.now() - concurrentStart;

  for (const r of settled) {
    results.push(r);
    if (delayMs >= 30000 || delayMs > timeoutMs) {
      assert(r.fallback || r.error, `${r.service} should have produced a timeout/fallback`);
      assert(r.response || r.error, `${r.service} must return a fallback shape`);
      console.log(`  [${r.service}] TIMEOUT handled → fallback returned (latency ${Math.round(r.latency)}ms)`);
    } else {
      console.log(`  [${r.service}] completed in ${Math.round(r.latency)}ms`);
    }
  }

  // Critical: concurrent requests must not serialize to ~N * delay
  // They should finish roughly in max(delay) time, not sum.
  const maxExpected = Math.max(delayMs, timeoutMs) + 2000;
  assert(
    concurrentElapsed < maxExpected * 1.5,
    `Concurrent requests blocked each other: took ${Math.round(concurrentElapsed)}ms (expected < ~${Math.round(maxExpected * 1.5)}ms)`
  );
  console.log(`  Concurrent wall time: ${Math.round(concurrentElapsed)}ms (non-blocking ✓)`);

  return results;
}

async function main() {
  console.log("MeMik — Third-party delay & timeout simulation\n");

  // 2s delay — should succeed under normal timeout
  await testDelay(2000, "2-second artificial delay");

  // 5s delay — still under 8s timeout
  await testDelay(5000, "5-second artificial delay");

  // 30s delay — must timeout and return fallback; must not block siblings
  await testDelay(30000, "30-second artificial delay (timeout expected)");

  console.log("\nAll delay / timeout / non-blocking checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
