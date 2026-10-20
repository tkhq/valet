/**
 * `make post-deploy`: run real user journeys against a deployed Valet and
 * report pass or fail with evidence. Runbook:
 * docs/testing/post-deploy-journeys.md
 *
 * Environment:
 *   VALET_URL                    instance (default: Turnkey dev)
 *   VALET_API_KEY                personal API key (vlt_…) of the test account
 *   VALET_API_KEY_FILE           or a file that holds it
 *   VALET_EXPECT_BUILD           wait until /api/health reports this commit
 *   VALET_EXPECT_BUILD_TIMEOUT_MIN  how long to wait for it (default 45)
 *   VALET_JOURNEY_*              per-journey settings (see the runbook)
 *
 * Flags:
 *   --list         print the journeys, run nothing
 *   --only a,b     run a subset (journey ids)
 *   --json         machine-readable report on stdout
 *   --sweep        delete resources that an interrupted run left, run nothing else
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GetMeResponse, HealthResponse, ListEventSubscriptionsResponse, ListPolicyOverridesResponse, ListWorkflowsResponse } from "../packages/api/src/wire/types.js";
import { ApiClient, HttpError } from "./post-deploy/client.js";
import { Check, JOURNEYS, NAME_PREFIX, Skip, deleteWorkflow, type Journey, type JourneyEnv } from "./post-deploy/journeys.js";
import { PollTimeout, pollUntil, renderReport, selectJourneys, toReport, type Evidence, type JourneyResult } from "./post-deploy/lib.js";

const DEV_URL = "https://valet.dev.agents.turnkey.engineering";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex === -1 ? undefined : (argv[onlyIndex + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function exitWith(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

if (flag("list")) {
  for (const j of JOURNEYS) console.log(`${j.id.padEnd(20)} ${j.title}`);
  process.exit(0);
}

let selected: Journey[];
try {
  selected = selectJourneys(JOURNEYS, only);
} catch (err) {
  exitWith(err instanceof Error ? err.message : String(err));
}

const url = process.env.VALET_URL || DEV_URL;
const keyFile = process.env.VALET_API_KEY_FILE;
const apiKey = (process.env.VALET_API_KEY || (keyFile ? readFileSync(keyFile, "utf8") : "")).trim();
if (!apiKey) exitWith("Set VALET_API_KEY (or VALET_API_KEY_FILE) to a personal API key of the test account. Create one in Settings > API keys.");
if (apiKey.startsWith("vltc_")) {
  exitWith("VALET_API_KEY is a `valet login` token. Agent tokens cannot create workflows, approve, or write event rules. Create a personal API key in Settings > API keys.");
}
const api = new ApiClient(url, apiKey);

async function readBuild(): Promise<string | null> {
  const health = await api.get<HealthResponse>("/api/health");
  return health.build ?? null;
}

async function waitForBuild(expected: string): Promise<string> {
  const minutes = Number(process.env.VALET_EXPECT_BUILD_TIMEOUT_MIN || "45");
  try {
    const build = await pollUntil(
      `${url} to report build ${expected}`,
      () => readBuild().catch(() => null),
      (b) => b !== null && (b.startsWith(expected) || expected.startsWith(b)),
      { timeoutMs: minutes * 60_000, intervalMs: 20_000 },
    );
    return build ?? expected;
  } catch (err) {
    if (err instanceof PollTimeout) exitWith(`${err.message} The instance still reports ${String(err.last)}. Check the rollout.`, 1);
    throw err;
  }
}

/** Remove what an interrupted run left: journey workflows, event rules, and the saved permission. */
async function sweep(me: JourneyEnv["me"]): Promise<void> {
  const { workflows } = await api.get<ListWorkflowsResponse>("/api/workflows");
  const stale = workflows.filter((w) => w.name.startsWith(NAME_PREFIX));
  for (const w of stale) {
    if (w.latestRun && w.latestRun.status !== "settled") await api.post(`/api/workflows/runs/${encodeURIComponent(w.latestRun.runId)}/cancel`).catch(() => undefined);
    await deleteWorkflow(api, w.id);
    console.log(`deleted workflow ${w.id} (${w.name})`);
  }
  const { subscriptions } = await api.get<ListEventSubscriptionsResponse>(`/api/event-subscriptions?ownerType=user&ownerId=${encodeURIComponent(me.id)}`);
  for (const s of subscriptions.filter((s) => s.ownerType === "user" && s.ownerId === me.id && s.name.startsWith(NAME_PREFIX))) {
    await api.delete(`/api/event-subscriptions/${encodeURIComponent(s.id)}`);
    console.log(`deleted event rule ${s.id} (${s.name})`);
  }
  const staleIds = new Set(stale.map((w) => w.id));
  const { overrides } = await api.get<ListPolicyOverridesResponse>("/api/me/policy-overrides");
  for (const o of overrides) {
    if (o.actionId && o.paramMatchers.some((m) => m.path === "workflow_id" && typeof m.value === "string" && staleIds.has(m.value))) {
      await api.delete("/api/me/policy-overrides", { actionId: o.actionId });
      console.log(`deleted the saved permission for ${o.actionId}`);
    }
  }
  console.log("Journey threads stay in the assistant's archive; there is no delete route for threads.");
}

function describeError(err: unknown): string {
  if (err instanceof PollTimeout) {
    const last = JSON.stringify(err.last) ?? "nothing";
    return `${err.message} Last state: ${last.slice(0, 400)}`;
  }
  if (err instanceof HttpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

interface Cleanup {
  label: string;
  fn: () => Promise<void>;
  started: boolean;
}

/** The cleanups of journeys still running, so a stop signal can run them. */
const unfinished = new Set<Cleanup[]>();

/** Run cleanups last-registered first, each once. Returns the ones that failed. */
async function runCleanups(cleanups: Cleanup[]): Promise<string[]> {
  const leftovers: string[] = [];
  for (const c of [...cleanups].reverse()) {
    if (c.started) continue;
    c.started = true;
    try {
      await c.fn();
    } catch (err) {
      leftovers.push(`${c.label}: ${describeError(err)}`);
    }
  }
  return leftovers;
}

// CI cancels a superseded run with SIGINT, then SIGTERM. Remove what the
// running journeys created first, so no event rule outlives its run.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`${signal}: removing what the running journeys created, then exiting.`);
    void Promise.all([...unfinished].map(runCleanups)).then((lists) => {
      for (const l of lists.flat()) console.error(`LEFTOVER: ${l}`);
      process.exit(130);
    });
  });
}

async function runJourney(journey: Journey, env: JourneyEnv): Promise<JourneyResult> {
  const evidence: Evidence[] = [];
  const cleanups: Cleanup[] = [];
  unfinished.add(cleanups);
  const started = Date.now();
  let status: JourneyResult["status"] = "passed";
  let reason: string | undefined;
  try {
    await journey.run(env, {
      note: (key, value) => evidence.push({ key, value }),
      cleanup: (label, fn) => cleanups.push({ label, fn, started: false }),
    });
  } catch (err) {
    status = err instanceof Skip ? "skipped" : "failed";
    reason = err instanceof Skip || err instanceof Check ? err.message : describeError(err);
  }
  const durationMs = Date.now() - started;
  const leftovers = await runCleanups(cleanups);
  unfinished.delete(cleanups);
  return { id: journey.id, title: journey.title, status, durationMs, evidence, reason, leftovers };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const expected = process.env.VALET_EXPECT_BUILD;
  const build = expected ? await waitForBuild(expected) : await readBuild();

  const me = await api.get<GetMeResponse>("/api/me");
  if (me.role === "team") exitWith("VALET_API_KEY is a team key. Use a personal API key of the test account.");
  const env: JourneyEnv = { api, me: { id: me.id, orgId: me.orgId }, runId: `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`, env: process.env };

  if (flag("sweep")) {
    await sweep(env.me);
    return;
  }

  const journeys = await Promise.all(selected.map((j) => runJourney(j, env)));
  const report = toReport({ url, build, startedAt, journeys });
  console.log(flag("json") ? JSON.stringify(report, null, 2) : renderReport(report));
  process.exitCode = report.exitCode;
}

main().catch((err: unknown) => exitWith(`post-deploy journeys stopped: ${describeError(err)}`));
