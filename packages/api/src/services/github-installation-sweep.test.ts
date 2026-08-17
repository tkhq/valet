/**
 * Installation-sweep tests: the scheduling rules (which org is due, in what
 * order, how a failure backs off) and failure isolation (one broken org must
 * not stop the sweep for the others, and must not throw).
 *
 * The scheduling half runs against the pure `selectDueOrg`/`backoffDelayMs`,
 * so no clock or database is needed. The isolation half runs the real tick
 * against a real PGlite database with a stub `fetch`, because the freshness
 * rule reads `github_installations.updatedAt` — a stubbed database would test
 * the stub, not the rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { githubInstallations, orgs } from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "./github-app.js";
import {
  backoffDelayMs,
  createSweepState,
  jitterMs,
  runInstallationSweepTick,
  selectDueOrg,
  startInstallationSweep,
  SWEEP_DUE_MS,
  type InstallationSweepDeps,
  type SweepCandidate,
  type SweepState,
} from "./github-installation-sweep.js";

const NOW = 1_700_000_000_000;
const API_URL = "https://api.github.test";

function candidate(over: Partial<SweepCandidate> & { orgId: string }): SweepCandidate {
  return { lastCheckedAt: null, tier: "no-installations", ...over };
}

describe("selectDueOrg", () => {
  it("returns null when every org was checked inside its own due time", () => {
    const state = createSweepState();
    const due = selectDueOrg(
      [
        candidate({ orgId: "a", lastCheckedAt: NOW - 60_000, tier: "webhook-absent" }),
        candidate({ orgId: "b", lastCheckedAt: NOW - 60 * 60_000, tier: "webhook-live" }),
      ],
      NOW,
      state,
    );
    expect(due).toBeNull();
  });

  it("treats an org with no installation rows as due, since it has no timestamp", () => {
    const due = selectDueOrg([candidate({ orgId: "a" })], NOW, createSweepState());
    expect(due?.orgId).toBe("a");
  });

  it("gives a webhook-live org a longer due time than a webhook-less one", () => {
    const age = SWEEP_DUE_MS["webhook-absent"] + 1;
    const state = createSweepState();
    expect(
      selectDueOrg([candidate({ orgId: "a", lastCheckedAt: NOW - age, tier: "webhook-absent" })], NOW, state)?.orgId,
    ).toBe("a");
    expect(
      selectDueOrg([candidate({ orgId: "a", lastCheckedAt: NOW - age, tier: "webhook-live" })], NOW, state),
    ).toBeNull();
    expect(
      selectDueOrg(
        [candidate({ orgId: "a", lastCheckedAt: NOW - SWEEP_DUE_MS["webhook-live"] - 1, tier: "webhook-live" })],
        NOW,
        state,
      )?.orgId,
    ).toBe("a");
  });

  it("returns one org even when several are due, and picks the least recently checked", () => {
    const due = selectDueOrg(
      [
        candidate({ orgId: "recent", lastCheckedAt: NOW - 20 * 60_000, tier: "webhook-absent" }),
        candidate({ orgId: "stale", lastCheckedAt: NOW - 90 * 60_000, tier: "webhook-absent" }),
      ],
      NOW,
      createSweepState(),
    );
    expect(due?.orgId).toBe("stale");
  });

  it("skips an org whose backoff has not expired, and takes it once it has", () => {
    const state: SweepState = createSweepState();
    state.set("a", { failures: 2, nextDueAt: NOW + 30_000 });
    expect(selectDueOrg([candidate({ orgId: "a" })], NOW, state)).toBeNull();
    expect(selectDueOrg([candidate({ orgId: "a" })], NOW + 31_000, state)?.orgId).toBe("a");
  });
});

describe("backoffDelayMs / jitterMs", () => {
  const noJitter = () => 0.5;

  it("doubles the tier's own interval once per failure", () => {
    expect(backoffDelayMs("no-installations", 1, noJitter)).toBe(SWEEP_DUE_MS["no-installations"] * 2);
    expect(backoffDelayMs("no-installations", 3, noJitter)).toBe(SWEEP_DUE_MS["no-installations"] * 8);
  });

  it("caps the wait at six hours, so a revoked key costs one request per six hours", () => {
    const sixHours = 6 * 60 * 60_000;
    expect(backoffDelayMs("no-installations", 99, noJitter)).toBe(sixHours);
    expect(backoffDelayMs("webhook-live", 99, noJitter)).toBe(sixHours);
  });

  it("spreads a due time by no more than ±25%, so two processes do not phase-lock", () => {
    expect(jitterMs(1000, () => 0)).toBe(750);
    expect(jitterMs(1000, () => 0.999)).toBeLessThanOrEqual(1250);
    expect(jitterMs(1000, () => 0.5)).toBe(1000);
  });
});

describe("runInstallationSweepTick", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let nowMs: number;
  let fetchCalls: string[];
  const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  function config(appId: string): GithubAppConfig {
    return {
      appId,
      appSlug: `app-${appId}`,
      oauthClientId: "Iv1.abc",
      htmlUrl: `https://github.com/apps/app-${appId}`,
      oauthClientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      privateKeyPem,
    };
  }

  /** The `iss` claim of the App JWT the request carries — the app id, which is
   * how a stub tells one org's request from another's. */
  function appIdOf(init: RequestInit | undefined): string {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const payloadPart = authorization.replace(/^Bearer /, "").split(".")[1] ?? "";
    const decoded: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return "";
    const claims: Record<string, unknown> = { ...decoded };
    return typeof claims.iss === "string" ? claims.iss : "";
  }

  /** Answers `GET /app/installations`: one installation per app id, except for
   * the ids in `failFor`, which get GitHub's "credential refused" status. */
  function stubFetch(failFor: string[] = []): typeof fetch {
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      const appId = appIdOf(init);
      if (failFor.includes(appId)) return new Response("bad credentials", { status: 401 });
      return new Response(
        JSON.stringify([
          {
            id: Number(appId),
            account: { login: `acct-${appId}`, type: "Organization" },
            repository_selection: "all",
            suspended_at: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return impl;
  }

  function deps(overrides: Partial<InstallationSweepDeps> = {}): InstallationSweepDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: API_URL,
      fetchImpl: stubFetch(),
      now: () => nowMs,
      random: () => 0.5,
      // An empty environment, never `process.env`: a developer machine with
      // real `GITHUB_APP_*` variables must not change what these tests see.
      env: {},
      ...overrides,
    };
  }

  async function installationCount(orgId: string): Promise<number> {
    const rows = await db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
    return rows.length;
  }

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    nowMs = NOW;
    fetchCalls = [];
    await db.insert(orgs).values({ id: "org1", name: "One", createdAt: NOW - 1000 });
    await db.insert(orgs).values({ id: "org2", name: "Two", createdAt: NOW });
  });

  it("checks nothing when no org has an App", async () => {
    const checked = await runInstallationSweepTick(deps(), createSweepState());
    expect(checked).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it("discovers installations for an org that never had any, with no click", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));

    const checked = await runInstallationSweepTick(deps(), createSweepState());

    expect(checked).toBe("org1");
    expect(fetchCalls).toHaveLength(1);
    expect(await installationCount("org1")).toBe(1);
  });

  it("checks at most one org per tick, and reaches the second org on the next tick", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    await saveAppConfig({ credentials }, "org2", config("222"));
    const state = createSweepState();

    const first = await runInstallationSweepTick(deps(), state);
    expect(fetchCalls).toHaveLength(1);
    const second = await runInstallationSweepTick(deps(), state);
    expect(fetchCalls).toHaveLength(2);

    expect([first, second].sort()).toEqual(["org1", "org2"]);
    expect(await runInstallationSweepTick(deps(), state)).toBeNull();
    expect(fetchCalls).toHaveLength(2);
  });

  it("leaves a freshly checked org alone until its due time passes", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    const state = createSweepState();
    await runInstallationSweepTick(deps(), state);

    nowMs = NOW + SWEEP_DUE_MS["webhook-absent"] - 1;
    expect(await runInstallationSweepTick(deps(), state)).toBeNull();

    nowMs = NOW + SWEEP_DUE_MS["webhook-absent"] + 1;
    expect(await runInstallationSweepTick(deps(), state)).toBe("org1");
  });

  it("waits six hours between checks when the webhook can reach this instance", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    const state = createSweepState();
    const live = { publicUrl: "https://valet.example" };
    await runInstallationSweepTick(deps(live), state);

    nowMs = NOW + SWEEP_DUE_MS["webhook-absent"] + 1;
    expect(await runInstallationSweepTick(deps(live), state)).toBeNull();

    nowMs = NOW + SWEEP_DUE_MS["webhook-live"] + 1;
    expect(await runInstallationSweepTick(deps(live), state)).toBe("org1");
  });

  it("keeps sweeping the other orgs when GitHub refuses one org's credential", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    await saveAppConfig({ credentials }, "org2", config("222"));
    const state = createSweepState();
    const failing = { fetchImpl: stubFetch(["111"]) };

    // Two ticks: one per org, whichever order the candidate scan returns.
    await runInstallationSweepTick(deps(failing), state);
    await runInstallationSweepTick(deps(failing), state);

    expect(await installationCount("org1")).toBe(0);
    expect(await installationCount("org2")).toBe(1);
    expect(state.get("org1")?.failures).toBe(1);
    expect(state.get("org2")?.failures).toBe(0);
  });

  it("backs a failing org off, and clears the backoff once the check succeeds", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    const state = createSweepState();

    await runInstallationSweepTick(deps({ fetchImpl: stubFetch(["111"]) }), state);
    expect(state.get("org1")).toEqual({
      failures: 1,
      nextDueAt: NOW + SWEEP_DUE_MS["no-installations"] * 2,
    });

    // Inside the backoff nothing is attempted, however overdue the org looks.
    nowMs = NOW + SWEEP_DUE_MS["no-installations"] + 1;
    fetchCalls = [];
    expect(await runInstallationSweepTick(deps({ fetchImpl: stubFetch(["111"]) }), state)).toBeNull();
    expect(fetchCalls).toEqual([]);

    nowMs = NOW + SWEEP_DUE_MS["no-installations"] * 2 + 1;
    expect(await runInstallationSweepTick(deps(), state)).toBe("org1");
    expect(state.get("org1")?.failures).toBe(0);
  });

  it("never throws when an org's credential row is malformed, and still sweeps the other org", async () => {
    // `loadAppConfigWithSource` throws on this row: the metadata has no appId.
    await credentials.save({ type: "org", id: "org1" }, "github_app", {
      type: "service_account",
      apiKey: privateKeyPem,
      accessToken: "client-secret",
      refreshToken: "webhook-secret",
      metadata: {},
    });
    await saveAppConfig({ credentials }, "org2", config("222"));
    const state = createSweepState();

    await expect(runInstallationSweepTick(deps(), state)).resolves.toBe("org2");
    expect(await installationCount("org2")).toBe(1);
    expect(state.get("org1")?.failures).toBe(1);
  });

  it("stops ticking after stop(), so shutdown ends the sweep", async () => {
    await saveAppConfig({ credentials }, "org1", config("111"));
    vi.useFakeTimers();
    try {
      const handle = startInstallationSweep(deps({ intervalMs: 1000 }));
      handle.stop();
      vi.advanceTimersByTime(10_000);
      expect(fetchCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps the oldest org for an App supplied through the environment", async () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: "999",
      GITHUB_APP_SLUG: "env-app",
      GITHUB_APP_CLIENT_ID: "Iv1.env",
      GITHUB_APP_CLIENT_SECRET: "env-secret",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    };

    const checked = await runInstallationSweepTick(deps({ env }), createSweepState());

    // org1 is the oldest org, matching the webhook's own fallback choice.
    expect(checked).toBe("org1");
    expect(await installationCount("org1")).toBe(1);
  });
});
