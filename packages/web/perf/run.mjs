#!/usr/bin/env node
// Interaction latency check. Serves the built app (`vite preview`), answers
// the api from fixtures (mock-api.mjs), drives the key flows at desktop and
// phone width under CPU slowdown, and reads the timings the app's own
// instrumentation records (src/lib/perf). Fails when the median of a flow's
// runs is over its budget (src/lib/perf/budgets.ts).
//
// The slowdown is calibrated: a fixed workload is timed first, and the
// throttle rate is set so the page runs `--cpu` times slower than the
// reference machine (an Apple M-series laptop), whatever the runner.
//
//   pnpm --filter @valet/web build
//   pnpm --filter @valet/web perf            # check
//   pnpm --filter @valet/web perf --runs 9 --json out.json
//   pnpm --filter @valet/web perf --only thread.open,message.send
//
// PERF_CHROMIUM points at a Chromium binary when the one playwright-core
// expects is not installed.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { installMockApi, unhandled } from "./mock-api.mjs";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    port: { type: "string", default: "4179" },
    cpu: { type: "string", default: "4" },
    rate: { type: "string" },
    json: { type: "string" },
    only: { type: "string" },
  },
});
const RUNS = Number(args.runs);
const PORT = Number(args.port);
const CPU_SLOWDOWN = Number(args.cpu);
/** Median time of `calibrationWorkload` on the reference machine, unthrottled. */
const REFERENCE_WORKLOAD_MS = 12.7;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Budgets live in TypeScript; node strips the types on import (Node >= 22.18).
const { budgetFor } = await import(resolve(WEB_DIR, "src/lib/perf/budgets.ts"));

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
];

const COMPOSER = /^Send a message/;

/** Waits for the newest measurement of `kind` for `flow`, after `clear()`. */
async function measured(page, kind, flow, timeout = 15_000) {
  const handle = await page.waitForFunction(([k, f]) => {
    const entries = window.__valetPerf?.entries() ?? [];
    const hit = entries.find((m) => m.kind === k && m.flow === f && m.ms > 0);
    return hit ? hit.ms : undefined;
  }, [kind, flow], { timeout, polling: 50 });
  return handle.jsonValue();
}

async function settle(page) {
  // Two frames plus a short idle, so a previous flow's work does not leak into the next.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150)))));
  await page.evaluate(() => window.__valetPerf.clear());
}

/** Opens the phone drawer when the layout has one. */
async function nav(page, vp) {
  if (vp.name !== "mobile") return page.locator("aside").first();
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.waitFor();
  return drawer;
}

/** Each flow: what to press, and which measurements it must produce. */
const FLOWS = [
  {
    flow: "thread.open",
    kinds: ["route", "data"],
    async run(page, vp) {
      const scope = await nav(page, vp);
      await scope.getByText(/^Thread 3:/).first().click();
    },
    async done(page) {
      await page.getByText("Question 30: why did the deploy fail?").last().waitFor();
    },
  },
  {
    flow: "message.send",
    kinds: ["interaction"],
    async run(page) {
      const box = page.getByPlaceholder(COMPOSER).last();
      await box.fill(`Perf probe ${Date.now()}`);
      await settle(page);
      await box.press("Enter");
    },
    async done(page) {
      await page.getByText(/^Perf probe \d+$/).last().waitFor();
    },
  },
  {
    flow: "space.switch",
    kinds: ["route", "data"],
    async run(page, vp) {
      const scope = await nav(page, vp);
      await scope.getByRole("link", { name: "Platform", exact: true }).click();
    },
  },
  {
    flow: "workflows.open",
    kinds: ["route", "data"],
    async run(page, vp) {
      const scope = await nav(page, vp);
      await scope.getByRole("list", { name: "Platform pages" }).getByRole("link", { name: "Workflows" }).click();
    },
    async done(page) {
      await page.getByText("Nightly report 1", { exact: true }).waitFor();
    },
  },
  {
    flow: "presence.open",
    kinds: ["route", "data"],
    async run(page, vp) {
      const scope = await nav(page, vp);
      await scope.getByRole("list", { name: "Platform pages" }).getByRole("link", { name: "Presence" }).click();
    },
  },
  {
    flow: "integrations.open",
    kinds: ["route", "data"],
    async prepare(page, vp) {
      const scope = await nav(page, vp);
      const more = scope.getByRole("button", { name: "Show more Platform pages" });
      if (await more.count()) await more.click();
      if (vp.name === "mobile") await page.keyboard.press("Escape");
    },
    async run(page, vp) {
      const scope = await nav(page, vp);
      await scope.getByRole("list", { name: "Platform pages" }).getByRole("link", { name: "Integrations" }).click();
    },
  },
  {
    flow: "tasks.open",
    kinds: ["interaction", "data"],
    mobileKinds: ["route", "data"],
    async prepare(page, vp) {
      await page.goto(`${ORIGIN}/`);
      await page.getByPlaceholder(COMPOSER).last().waitFor();
      if (vp.name === "mobile") return;
      const tasks = page.locator('[data-perf-flow="tasks.open"]');
      await tasks.waitFor();
      if ((await tasks.getAttribute("aria-pressed")) === "true") await tasks.click();
    },
    async run(page, vp) {
      if (vp.name === "mobile") await page.getByRole("tab", { name: /^Tasks/ }).click();
      else await page.locator('[data-perf-flow="tasks.open"]').click();
    },
    async done(page) {
      await page.getByText("Nothing in flight.").first().waitFor();
    },
  },
];

/** Script and DOM work, a rough stand-in for a render. */
function calibrationWorkload() {
  const t0 = performance.now();
  let total = 0;
  for (let i = 0; i < 200_000; i++) total += JSON.stringify({ i, t: `row ${i}` }).length;
  const root = document.body;
  root.textContent = "";
  for (let i = 0; i < 2000; i++) {
    const div = document.createElement("div");
    div.textContent = `x${i}`;
    root.appendChild(div);
  }
  void root.offsetHeight;
  return performance.now() - t0 + (total % 1);
}

/** The CDP throttle rate that makes this machine `CPU_SLOWDOWN` times slower than the reference. */
async function calibrate(browser) {
  if (args.rate) return { rate: Number(args.rate), workloadMs: NaN };
  const page = await browser.newPage();
  const times = [];
  for (let i = 0; i < 7; i++) times.push(await page.evaluate(calibrationWorkload));
  await page.close();
  const warm = times.slice(2).sort((a, b) => a - b);
  const workloadMs = warm[Math.floor(warm.length / 2)];
  const rate = Math.min(20, Math.max(1, (CPU_SLOWDOWN * REFERENCE_WORKLOAD_MS) / workloadMs));
  return { rate, workloadMs };
}

async function startPreview() {
  const child = spawn("pnpm", ["exec", "vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`vite preview did not start on ${ORIGIN}. Run "pnpm --filter @valet/web build" first.\n${log}`);
}

async function runOnce(browser, vp, samples, rate) {
  const context = await browser.newContext({ ...vp, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("valet:perf", "record");
    localStorage.setItem("valet:home-tasks-panel", "open");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await installMockApi(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__valetPerf !== undefined, undefined, { timeout: 30_000 });
  await page.getByPlaceholder(COMPOSER).last().waitFor({ timeout: 30_000 });
  // The page's first press starts its audio context (__root.tsx). Spend it
  // here, so it lands on no single flow.
  await page.mouse.click(1, vp.viewport.height - 1);

  for (const step of FLOWS) {
    if (args.only && !args.only.split(",").includes(step.flow)) continue;
    const kinds = (vp.name === "mobile" && step.mobileKinds) || step.kinds;
    try {
      if (step.prepare) await step.prepare(page, vp);
      await settle(page);
      await step.run(page, vp);
      for (const kind of kinds) {
        const ms = await measured(page, kind, step.flow);
        const key = `${vp.name}|${step.flow}|${kind}`;
        (samples[key] ??= []).push(ms);
      }
      if (step.done) await step.done(page);
    } catch (err) {
      const key = `${vp.name}|${step.flow}|error`;
      (samples[key] ??= []).push(String(err.message ?? err).split("\n")[0]);
      await page.screenshot({ path: resolve(WEB_DIR, `perf/failure-${vp.name}-${step.flow}.png`) }).catch(() => {});
    }
  }
  if (errors.length) (samples[`${vp.name}|page|error`] ??= []).push(...errors.slice(0, 3));
  await context.close();
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

const preview = await startPreview();
let failed = false;
const results = [];
try {
  const browser = await chromium.launch(process.env.PERF_CHROMIUM ? { executablePath: process.env.PERF_CHROMIUM } : {});
  const { rate, workloadMs } = await calibrate(browser);
  const samples = {};
  for (const vp of VIEWPORTS) {
    for (let i = 0; i < RUNS; i++) await runOnce(browser, vp, samples, rate);
  }
  await browser.close();

  const calibration = Number.isNaN(workloadMs) ? "" : `, workload ${workloadMs.toFixed(1)} ms vs ${REFERENCE_WORKLOAD_MS} ms reference`;
  console.log(`\nInteraction latency, ${RUNS} runs, CPU ${CPU_SLOWDOWN}x reference (throttle ${rate.toFixed(2)}x${calibration}), ms\n`);
  console.log("viewport  flow               kind          p50    p95  budget  result");
  for (const [key, values] of Object.entries(samples)) {
    const [viewport, flow, kind] = key.split("|");
    if (kind === "error") {
      failed = true;
      console.log(`${viewport.padEnd(9)} ${flow.padEnd(18)} ERROR ${[...new Set(values)].join(" | ")}`);
      continue;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    const budget = budgetFor(kind, flow);
    // The median gates; one slow run on a shared runner does not fail the check.
    const ok = p50 <= budget && values.length === RUNS;
    if (!ok) failed = true;
    results.push({ viewport, flow, kind, p50, p95, budget, ok, samples: values });
    console.log(`${viewport.padEnd(9)} ${flow.padEnd(18)} ${kind.padEnd(11)} ${String(Math.round(p50)).padStart(6)} ${String(Math.round(p95)).padStart(6)} ${String(budget).padStart(7)}  ${ok ? "ok" : "OVER"}`);
  }
  if (unhandled.size) console.log(`\nRequests with no fixture (answered 404):\n  ${[...unhandled].sort().join("\n  ")}`);
  if (args.json) writeFileSync(args.json, JSON.stringify({ runs: RUNS, cpuSlowdown: CPU_SLOWDOWN, throttleRate: rate, results }, null, 2));
} finally {
  preview.kill();
}
if (failed) {
  console.error("\nA flow is over budget or failed. Budgets: packages/web/src/lib/perf/budgets.ts");
  process.exit(1);
}
