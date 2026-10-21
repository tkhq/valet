/**
 * Arm checks for `wait_for_event` (spec 2026-10-15: event wakeups, Part D1).
 * One test per refusal over stubbed deps, plus the pass cases. The plugins
 * are the real GitHub, Slack, and Linear manifests, so subject parsing and
 * the event catalogs are the shipped ones.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { ArmEventRequest, Credential, CredentialProvider, CredentialStore, ThreadData } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { githubInstallations } from "../schema/index.js";
import { linkIdentity } from "../channels/identity-links.js";
import { upsertFollowedThread } from "./followed-threads.js";
import { armDeps, checkArm, type ArmDeps, type ArmProviders } from "./waiter-arm.js";

const PLUGINS = [githubPlugin, slackPlugin, linearPlugin];
const CTX = { sessionId: "s-1", threadId: "t-1", orgId: "acme" };

function deps(over: Partial<ArmDeps> = {}): ArmDeps {
  return {
    plugins: PLUGINS,
    serviceConnected: async () => true,
    githubInstallationCovers: async () => true,
    githubIngressConfig: async () => ({ events: ["check_run", "check_suite", "workflow_run", "status", "push", "pull_request"], permissions: { checks: "read", actions: "read", statuses: "read", contents: "read", pull_requests: "read" } }),
    slackTeamId: async () => "T001",
    readGithub: async () => ({ readable: true, pullRequest: true }),
    readSlackChannel: async () => ({ ok: true, isPrivate: false, isMember: true, name: "general" }),
    sessionMayReadSlackChannel: async () => true,
    readLinear: async () => true,
    followsSlackThread: async () => false,
    selfIds: async () => ["1001", "9001"],
    ...over,
  };
}

function req(over: Partial<ArmEventRequest> = {}): ArmEventRequest {
  return {
    subject: "https://github.com/acme/lean-proofs/pull/42",
    on: [
      { key: "github.check_run.completed", status: ["failure", "timed_out", "cancelled", "action_required", "startup_failure"] },
      { key: "github.pull_request.checks_completed" },
    ],
    once: false,
    reason: "CI on #42",
    maxHours: 6,
    ...over,
  };
}

const SLACK_PERMALINK = "https://acme.slack.com/archives/C001/p1712345678000100";

describe("checkArm passes", () => {
  it("A1: a pull request URL arms with the canonical subject and self", async () => {
    const readGithub = vi.fn(async () => ({ readable: true, pullRequest: true }));
    const covers = vi.fn(async () => true);
    const result = await checkArm(deps({ readGithub, githubInstallationCovers: covers }), CTX, req());
    // The derived clause adds the repository subject, and direct clauses
    // keep the pull request as the primary subject (final review, item 3).
    expect(result).toEqual({
      ok: true,
      subjects: ["github:acme/lean-proofs#42", "github:acme/lean-proofs"],
      self: ["1001", "9001"],
      primarySubject: "github:acme/lean-proofs#42",
    });
    expect(covers).toHaveBeenCalledWith("acme", "lean-proofs");
    expect(readGithub).toHaveBeenCalledWith({ owner: "acme", repo: "lean-proofs", number: 42 });
  });

  it("A1: a pull request wait with no derived clause keeps one subject", async () => {
    const result = await checkArm(
      deps({ readGithub: async () => ({ readable: true, pullRequest: true }) }),
      CTX,
      req({ on: [{ key: "github.check_run.completed", status: ["failure"] }] }),
    );
    expect(result).toEqual({ ok: true, subjects: ["github:acme/lean-proofs#42"], self: ["1001", "9001"] });
  });

  it("B1: a Slack permalink resolves the org's team id", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: SLACK_PERMALINK, on: [{ key: "slack.message", bots: false }] }));
    expect(result).toEqual({ ok: true, subjects: ["slack:T001/C001/1712345678.000100"], self: ["1001", "9001"] });
  });

  it("E2: a canonical Slack channel subject arms", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: "slack:T001/C900", on: [{ key: "slack.message", bots: false }] }));
    expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/C900"] });
  });

  it("C1: a Linear team triage URL arms", async () => {
    const readLinear = vi.fn(async () => true);
    const result = await checkArm(
      deps({ readLinear }),
      CTX,
      req({
        subject: "https://linear.app/acme/team/ENG/triage",
        on: [
          { key: "linear.issue.create", status: ["triage"] },
          { key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: true, subjects: ["linear:team/ENG"] });
    expect(readLinear).toHaveBeenCalledWith({ teamKey: "ENG" });
  });

  it("accepts a clause key glob that names a catalog family", async () => {
    const result = await checkArm(deps(), CTX, req({ on: [{ key: "github.check_run.*" }] }));
    expect(result.ok).toBe(true);
  });
});

describe("GitHub arm correctness", () => {
  it("keeps issue waits independent of pull_request readiness", async () => {
    const result = await checkArm(deps({
      githubIngressConfig: async () => ({ events: ["issues"], permissions: { issues: "read" } }),
      readGithub: async () => ({ readable: true, pullRequest: false }),
    }), CTX, req({ subject: "https://github.com/acme/lean-proofs/issues/7", on: [{ key: "github.issues.opened" }] }));
    expect(result.ok).toBe(true);
  });

  it("refuses a branch wait without pull_request readiness, even with close ending disabled", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: ["check_run", "check_suite", "workflow_run", "status"], permissions: { checks: "read", actions: "read", statuses: "read" } }) }), CTX,
      req({ subject: "https://github.com/acme/lean-proofs/tree/feat/x", endOnClose: false }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining("event pull_request") });
  });

  it.each([false, true])("allows a closed PR with merged=%s when end_on_close is false, without close readiness", async (merged) => {
    const result = await checkArm(deps({
      githubIngressConfig: async () => ({ events: ["issue_comment"], permissions: { issues: "read" } }),
      readGithub: async () => ({ readable: true, pullRequest: true, state: "closed", merged, mergeSha: "a".repeat(40) }),
    }), CTX, req({ endOnClose: false, on: [{ key: "github.issue_comment.created" }] }));
    expect(result.ok).toBe(true);
  });

  it("requires pull_request readiness even for a direct check-run clause", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: ["check_run"], permissions: { checks: "read" } }) }), CTX,
      req({ on: [{ key: "github.check_run.completed" }] }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining("event pull_request") });
  });

  it.each(["check_run", "check_suite", "workflow_run", "status"])("refuses a derived wait missing event %s", async (family) => {
    const config = { events: ["check_run", "check_suite", "workflow_run", "status"].filter((e) => e !== family), permissions: { checks: "read", actions: "read", statuses: "read" } };
    const result = await checkArm(deps({ githubIngressConfig: async () => config }), CTX, req());
    expect(result).toEqual({ ok: false, text: expect.stringContaining(`event ${family}`) });
    expect(result.ok === false && result.text).toContain('"Permissions & events"');
    expect(result.ok === false && result.text).toContain("org owner approve");
  });

  it("refuses a missing read permission", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: ["check_run", "check_suite", "workflow_run", "status"], permissions: { checks: "read", actions: "read" } }) }), CTX, req());
    expect(result).toEqual({ ok: false, text: expect.stringContaining("permission statuses: read") });
  });

  it.each(["null", "throw", "timeout"])("arms with a warning when config read returns %s", async (mode) => {
    const result = await checkArm(deps({ githubIngressConfig: async () => {
      if (mode === "throw") throw new Error("network");
      if (mode === "timeout") return new Promise(() => undefined);
      return null;
    } }), CTX, req(), { timeoutMs: 10 });
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("could not be checked") });
  });

  it("excludes derived entries from pull request glob readiness", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: ["pull_request"], permissions: { pull_requests: "read" } }) }), CTX, req({ on: [{ key: "github.pull_request.*" }] }));
    expect(result).toMatchObject({ ok: true });
  });

  it("refreshes a stale negative configuration before refusing", async () => {
    const config = vi.fn(async (_owner: string, _repo: string, refresh?: boolean) => refresh
      ? { events: ["check_run", "check_suite", "workflow_run", "status", "pull_request"], permissions: { checks: "read", actions: "read", statuses: "read", pull_requests: "read" } }
      : { events: [], permissions: {} });
    const result = await checkArm(deps({ githubIngressConfig: config }), CTX, req());
    expect(result).toMatchObject({ ok: true });
    expect(config).toHaveBeenLastCalledWith("acme", "lean-proofs", true);
  });

  it("names pending owner approval when requested settings exceed the grants", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: [], permissions: {}, pendingApproval: true }) }), CTX, req());
    expect(result).toEqual({ ok: false, text: expect.stringContaining("Owner approval is pending") });
  });

  it.each(["unknown", "throw", "timeout"])("arms with an access warning for %s repository coverage", async (mode) => {
    const result = await checkArm(deps({ githubInstallationCovers: async () => {
      if (mode === "throw") throw new Error("503");
      if (mode === "timeout") return new Promise(() => undefined);
      return null;
    } }), CTX, req(), { timeoutMs: 10 });
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("repository access could not be checked") });
  });

  it("keeps the readability refusal for an unreadable full SHA", async () => {
    const subject = `github:acme/lean-proofs@${"a".repeat(40)}`;
    const result = await checkArm(deps({ readGithub: async () => ({ readable: false }) }), CTX, req({ subject, on: [{ key: "github.status" }] }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining(`This session cannot read ${subject}`) });
    expect(result.ok === false && result.text).not.toContain("Give the full");
  });

  it("accepts either documented permission for issue comments", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: ["issue_comment"], permissions: { pull_requests: "read" } }) }), CTX, req({ subject: "https://github.com/acme/lean-proofs", on: [{ key: "github.issue_comment.created" }] }));
    expect(result.ok).toBe(true);
  });

  it("expands direct event globs into their event family", async () => {
    const result = await checkArm(deps({ githubIngressConfig: async () => ({ events: [], permissions: { checks: "read" } }) }), CTX, req({ on: [{ key: "github.check_run.*" }] }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining("event check_run") });
  });

  it("asks for the full SHA when the abbreviated commit cannot be read", async () => {
    const result = await checkArm(deps({ readGithub: async () => ({ readable: false }) }), CTX, req({ subject: "github:acme/lean-proofs@aaaaaaa", on: [{ key: "github.status" }] }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining("full 40-character SHA") });
  });

  it.each(["github:acme/lean-proofs@aaaaaaa", "https://github.com/acme/lean-proofs/commit/aaaaaaa"])("canonicalizes the short commit subject %s before storage", async (subject) => {
    const sha = "a".repeat(40);
    const result = await checkArm(deps({ readGithub: async () => ({ readable: true, sha }) }), CTX, req({ subject, on: [{ key: "github.status" }] }));
    expect(result).toMatchObject({ ok: true, subjects: [`github:acme/lean-proofs@${sha}`] });
  });

  it("asks for the full SHA if canonicalization is unavailable", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: "github:acme/lean-proofs@aaaaaaa", on: [{ key: "github.status" }] }));
    expect(result).toEqual({ ok: false, text: expect.stringContaining("full 40-character SHA") });
  });
});

describe("checkArm refusals", () => {
  it("R1: an unsupported subject", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: "https://example.com/x" }));
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] https://example.com/x is not a supported subject. Give a GitHub pull request, issue, commit, or repository URL, a Slack message permalink, or a Linear issue or team URL.",
    });
  });

  it("R1: a GitHub owner alone is not a supported subject", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: "github:acme", on: [{ key: "github.push" }] }));
    expect(result.ok === false && result.text).toMatch(/^\[wait_for_event\] github:acme is not a supported subject\./);
  });

  it("R2 (D1): the installation does not cover the owner", async () => {
    const readGithub = vi.fn(async () => ({ readable: true, pullRequest: true }));
    const result = await checkArm(
      deps({ githubInstallationCovers: async () => false, readGithub }),
      CTX,
      req({ subject: "https://github.com/acme/other/pull/1" }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] The GitHub App installation does not cover acme/other. Install the app on that repository, then wait again.",
    });
    expect(readGithub).not.toHaveBeenCalled();
  });

  it("R3: the session's credential cannot read the repository", async () => {
    const result = await checkArm(deps({ readGithub: async () => ({ readable: false }) }), CTX, req());
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] This session cannot read github:acme/lean-proofs#42. Connect an account that can, or ask an admin to grant the app access.",
    });
  });

  it("R3: a provider read that does not answer in time", async () => {
    const result = await checkArm(
      deps({ readGithub: () => new Promise(() => undefined) }),
      CTX,
      req(),
      { timeoutMs: 20 },
    );
    expect(result.ok === false && result.text).toMatch(/^\[wait_for_event\] This session cannot read github:acme\/lean-proofs#42\./);
  });

  it("R3: a provider read that throws", async () => {
    const result = await checkArm(deps({ readGithub: async () => { throw new Error("401"); } }), CTX, req());
    expect(result.ok === false && result.text).toMatch(/cannot read github:acme\/lean-proofs#42/);
  });

  it("R3: a team session and a private Slack channel", async () => {
    const result = await checkArm(
      deps({
        readSlackChannel: async () => ({ ok: true, isPrivate: true, isMember: true, name: "secret" }),
        sessionMayReadSlackChannel: async (_channel, isPrivate) => !isPrivate,
      }),
      CTX,
      req({ subject: SLACK_PERMALINK, on: [{ key: "slack.message" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] This session cannot read slack:T001/C001/1712345678.000100. Connect an account that can, or ask an admin to grant the app access.",
    });
  });

  it("R3: a canonical Slack subject from another workspace", async () => {
    const result = await checkArm(deps(), CTX, req({ subject: "slack:T999/C001", on: [{ key: "slack.message" }] }));
    expect(result.ok === false && result.text).toMatch(/cannot read slack:T999\/C001\./);
  });

  it("R3: Linear without the session's own credential", async () => {
    const result = await checkArm(
      deps({ readLinear: async () => false }),
      CTX,
      req({ subject: "https://linear.app/acme/issue/ENG-7/fix-login", on: [{ key: "linear.comment.create" }] }),
    );
    expect(result.ok === false && result.text).toMatch(/^\[wait_for_event\] This session cannot read linear:ENG-7\./);
  });

  it("R4 (D2): the bot is not a member of the channel", async () => {
    const result = await checkArm(
      deps({ readSlackChannel: async () => ({ ok: true, isPrivate: false, isMember: false, name: "ops" }) }),
      CTX,
      req({ subject: "https://acme.slack.com/archives/C002/p1712345678000100", on: [{ key: "slack.message" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] Valet is not in #ops, so it does not receive its messages. Invite @Valet to the channel, then wait again.",
    });
  });

  it("R4: a channel the bot cannot see", async () => {
    const result = await checkArm(
      deps({ readSlackChannel: async () => ({ ok: false, reason: "not_found" }) }),
      CTX,
      req({ subject: "https://acme.slack.com/archives/C002", on: [{ key: "slack.message" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] Valet is not in <#C002>, so it does not receive its messages. Invite @Valet to the channel, then wait again.",
    });
  });

  it("R5 (D3): a key in no catalog", async () => {
    const result = await checkArm(deps(), CTX, req({ on: [{ key: "github.check_suite.done" }] }));
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] github.check_suite.done is not an event key for github. Call workflows.list_event_types for the keys.",
    });
  });

  it("R5: a key from another service", async () => {
    const result = await checkArm(deps(), CTX, req({ on: [{ key: "slack.message" }] }));
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] slack.message is not an event key for github. Call workflows.list_event_types for the keys.",
    });
  });

  it("R5: checks_completed needs a pull request subject", async () => {
    const result = await checkArm(
      deps(),
      CTX,
      req({ subject: "https://github.com/acme/lean-proofs", on: [{ key: "github.pull_request.checks_completed" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] github.pull_request.checks_completed needs a pull request subject. Pass the pull request URL.",
    });
  });

  it("R5: checks_completed on an issue number", async () => {
    const result = await checkArm(
      deps({ readGithub: async () => ({ readable: true, pullRequest: false }) }),
      CTX,
      req({ subject: "https://github.com/acme/lean-proofs/issues/7", on: [{ key: "github.pull_request.checks_completed" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] github.pull_request.checks_completed needs a pull request subject. Pass the pull request URL.",
    });
  });

  it("R6: the thread already follows that Slack thread (Review Focus 5)", async () => {
    const follows = vi.fn(async () => true);
    const result = await checkArm(
      deps({ followsSlackThread: follows }),
      CTX,
      req({ subject: SLACK_PERMALINK, on: [{ key: "slack.message" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] This thread already receives replies from that Slack thread. No wait is needed.",
    });
    expect(follows).toHaveBeenCalledWith("t-1", "C001", "1712345678.000100");
  });

  it("R6 does not apply to a channel subject", async () => {
    const follows = vi.fn(async () => true);
    const result = await checkArm(
      deps({ followsSlackThread: follows }),
      CTX,
      req({ subject: "https://acme.slack.com/archives/C001", on: [{ key: "slack.message" }] }),
    );
    expect(result.ok).toBe(true);
    expect(follows).not.toHaveBeenCalled();
  });

  it("R7: the service is not connected for the org", async () => {
    const result = await checkArm(
      deps({ serviceConnected: async (service) => service !== "linear" }),
      CTX,
      req({ subject: "https://linear.app/acme/issue/ENG-7/fix-login", on: [{ key: "linear.comment.create" }] }),
    );
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] Linear is not connected for this organization. Connect it in Settings, Integrations.",
    });
  });

  it("R7: Slack with no connected team id", async () => {
    const result = await checkArm(deps({ slackTeamId: async () => null }), CTX, req({ subject: SLACK_PERMALINK, on: [{ key: "slack.message" }] }));
    expect(result.ok === false && result.text).toBe(
      "[wait_for_event] Slack is not connected for this organization. Connect it in Settings, Integrations.",
    );
  });
});

describe("armDeps", () => {
  let tdb: TestPgDb;
  beforeAll(async () => {
    tdb = await freshTestPgDb();
  });

  const noCredentials: CredentialStore = {
    get: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
    compareAndSwap: async () => false,
  };

  function thread(key: string): ThreadData {
    return { id: "t-1", sessionId: "s-1", key, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 };
  }

  function providers(threadKey = "web:default"): ArmProviders {
    return {
      db: tdb.appDb,
      engineStore: { getThread: async () => thread(threadKey) },
      engineCredentials: noCredentials,
      plugins: PLUGINS,
    };
  }

  const personal = { sessionId: "s-1", orgId: "acme", ownerType: "user" as const, ownerId: "u-001" };

  /** Providers whose org Slack credential is the bot token `bot` in team T001. */
  function orgSlack(bot: string): ArmProviders {
    const engineCredentials: CredentialStore = {
      ...noCredentials,
      get: async (owner, service) =>
        owner.type === "org" && service === "slack"
          ? { type: "bot_token", accessToken: bot, metadata: { botUserId: "U-BOT", teamId: "T001" } }
          : null,
    };
    return { ...providers(), engineCredentials };
  }

  function credentials(byService: Record<string, Credential>): CredentialProvider {
    return {
      get: async (service?: string) => (service ? byService[service] ?? null : null),
      request: async () => {
        throw new Error("not used");
      },
    };
  }

  it("readLinear refuses the org's app credential (no app fallback before the credential policy)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { issue: { id: "i1" } } })));
    const d = armDeps(
      providers(),
      personal,
      credentials({ linear: { accessToken: "app", metadata: { grant: "client_credentials" } } }),
      { fetch: fetchImpl },
    );
    expect(await d.readLinear({ issue: "ENG-7" })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("readLinear reads an issue with the session's own credential", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { issue: { id: "i1" } } })));
    const d = armDeps(providers(), personal, credentials({ linear: { accessToken: "lin-user" } }), {
      fetch: fetchImpl,
      linearApiUrl: "https://linear.test",
    });
    expect(await d.readLinear({ issue: "ENG-7" })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://linear.test/graphql", expect.objectContaining({ method: "POST" }));
  });

  it("readLinear: an issue Linear does not return is unreadable", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { issue: null }, errors: [{ message: "not found" }] })));
    const d = armDeps(providers(), personal, credentials({ linear: { accessToken: "lin-user" } }), { fetch: fetchImpl });
    expect(await d.readLinear({ issue: "ENG-404" })).toBe(false);
  });

  it("checks the exact repository installation even when the session can read public metadata", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const env = { GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "test", GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "test", GITHUB_APP_PRIVATE_KEY: privateKey };
    await tdb.appDb.insert(githubInstallations).values({ id: "arm-install", orgId: "acme", installationId: 77, accountLogin: "acme", accountType: "Organization", createdAt: 1, updatedAt: 1 });
    const http = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/lean-proofs/installation")
      ? Response.json({ id: 77, suspended_at: null }) : new Response("{}", { status: 404 }));
    const d = armDeps(providers(), personal, credentials({ github: { accessToken: "user" } }), { fetch: http, env, githubApiUrl: "https://gh.test" });
    expect(await d.githubInstallationCovers("acme", "lean-proofs")).toBe(true);
    expect(await d.githubInstallationCovers("acme", "public-but-not-installed")).toBe(false);
    expect(http).toHaveBeenCalledWith("https://gh.test/repos/acme/public-but-not-installed/installation", expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer ey/) }) }));
  });

  it("readGithub reports a pull request and an unreadable repository", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/issues/42")
        ? new Response(JSON.stringify({ number: 42, pull_request: { url: "x" } }))
        : new Response("{}", { status: 404 }));
    const d = armDeps(providers(), personal, credentials({ github: { accessToken: "gh" } }), {
      fetch: fetchImpl,
      githubApiUrl: "https://gh.test",
    });
    expect(await d.readGithub({ owner: "acme", repo: "lean-proofs", number: 42 })).toEqual({ readable: true, pullRequest: true });
    expect(await d.readGithub({ owner: "acme", repo: "other" })).toEqual({ readable: false });
    expect(fetchImpl).toHaveBeenCalledWith("https://gh.test/repos/acme/lean-proofs/issues/42", expect.anything());
  });

  it("reads the merge SHA when an issue read reports a closed PR", async () => {
    const sha = "b".repeat(40);
    const http = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/issues/42")
      ? Response.json({ state: "closed", pull_request: {} })
      : Response.json({ state: "closed", merged: true, merge_commit_sha: sha }));
    const d = armDeps(providers(), personal, credentials({ github: { accessToken: "gh" } }), { fetch: http });
    expect(await d.readGithub({ owner: "acme", repo: "app", number: 42 })).toEqual({ readable: true, pullRequest: true, state: "closed", merged: true, mergeSha: sha });
  });

  it("finds an open same-repository PR and ignores fork heads", async () => {
    const http = vi.fn<typeof fetch>(async () => Response.json([
      { number: 7, head: { ref: "feat/nested", repo: { full_name: "fork/app" } } },
      { number: 42, head: { ref: "feat/nested", repo: { full_name: "Acme/App" } } },
    ]));
    const d = armDeps(providers(), personal, credentials({ github: { accessToken: "gh" } }), { fetch: http, githubApiUrl: "https://gh.test" });
    expect(await d.findGithubPullRequest?.({ owner: "acme", repo: "app", branch: "feat/nested" })).toBe("github:acme/app#42");
    const request = new URL(String(http.mock.calls[0]?.[0]));
    expect(request.searchParams.get("state")).toBe("open");
    expect(request.searchParams.get("head")).toBe("acme:feat/nested");
    expect(http.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer gh" });
  });

  it("readGithub preserves the canonical SHA returned for an abbreviated SHA", async () => {
    const sha = "a".repeat(40);
    const fetchImpl = vi.fn(async () => Response.json({ sha }));
    const d = armDeps(providers(), personal, credentials({ github: { accessToken: "gh" } }), { fetch: fetchImpl });
    expect(await d.readGithub({ owner: "acme", repo: "lean-proofs", sha: "aaaaaaa" })).toEqual({ readable: true, sha });
  });

  it("readGithub without a session credential is unreadable", async () => {
    const d = armDeps(providers(), personal, undefined, {});
    expect(await d.readGithub({ owner: "acme", repo: "lean-proofs" })).toEqual({ readable: false });
  });

  it("readSlackChannel: channel_not_found reads as not_found, a member channel as public and joined", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("C404")
        ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
        : new Response(JSON.stringify({ ok: true, channel: { id: "C001", name: "general", is_private: false, is_member: true } })));
    const d = armDeps(orgSlack("xoxb"), personal, credentials({ slack: { accessToken: "xoxb" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
    });
    expect(await d.readSlackChannel("C404")).toEqual({ ok: false, reason: "not_found" });
    expect(await d.readSlackChannel("C001")).toEqual({ ok: true, isPrivate: false, isMember: true, name: "general" });
  });

  /** conversations.info answers by token: `memberFor[token]` is that token's `is_member`. */
  function infoByToken(memberFor: Record<string, boolean>, isPrivate = false) {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const bearer = auth.replace(/^Bearer /, "");
      return new Response(JSON.stringify({ ok: true, channel: { id: "C001", name: "general", is_private: isPrivate, is_member: memberFor[bearer] === true } }));
    });
  }

  it("R4 reads is_member with the org bot token: the session says member, the bot says not", async () => {
    const fetchImpl = infoByToken({ "xoxp-user": true, "xoxb-bot": false });
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxp-user" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
    });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/C001", on: [{ key: "slack.message" }] }));
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] Valet is not in #general, so it does not receive its messages. Invite @Valet to the channel, then wait again.",
    });
  });

  it("R4 reads is_member with the org bot token: the session says not, the bot says member", async () => {
    const fetchImpl = infoByToken({ "xoxp-user": false, "xoxb-bot": true });
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxp-user" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
    });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/C001", on: [{ key: "slack.message" }] }));
    expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/C001"] });
  });

  /** conversations.info answers `channel` for every token, as Slack does for a DM or group DM both tokens are in. */
  function infoAlways(channel: Record<string, unknown>) {
    return vi.fn(async () => new Response(JSON.stringify({ ok: true, channel })));
  }

  /** The owner may see every channel, so R3 passes and R4 decides. */
  const ownerSeesAll = () => async () => true;

  it("R4: a DM with the bot arms, though Slack sends no is_member for a DM", async () => {
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxp-user" } }), {
      fetch: infoAlways({ id: "D0BQQF5MBQB", is_im: true, user: "U-OWNER" }),
      slackApiUrl: "https://slack.test/api",
      channelVisibility: ownerSeesAll,
    });
    expect(await d.readSlackChannel("D0BQQF5MBQB")).toEqual({ ok: true, isPrivate: true, isMember: true });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/D0BQQF5MBQB", on: [{ key: "slack.message" }] }));
    expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/D0BQQF5MBQB"] });
  });

  it("R4: a DM read with the bot token alone arms", async () => {
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxb-bot" } }), {
      fetch: infoAlways({ id: "D0BQQF5MBQB", is_im: true, user: "U-OWNER" }),
      slackApiUrl: "https://slack.test/api",
      channelVisibility: ownerSeesAll,
    });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/D0BQQF5MBQB", on: [{ key: "slack.message" }] }));
    expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/D0BQQF5MBQB"] });
  });

  it("R4: a group DM with the bot arms", async () => {
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxp-user" } }), {
      fetch: infoAlways({ id: "G0MPIM001", name: "mpdm-owner--valet--pat-1", is_mpim: true, is_private: true }),
      slackApiUrl: "https://slack.test/api",
      channelVisibility: ownerSeesAll,
    });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/G0MPIM001", on: [{ key: "slack.message" }] }));
    expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/G0MPIM001"] });
  });

  it("R4: a private channel the bot is not in still refuses and names the channel", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).get("Authorization") === "Bearer xoxb-bot"
        ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
        : new Response(JSON.stringify({ ok: true, channel: { id: "C0SECRET", name: "secret", is_private: true, is_member: true } })));
    const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxp-user" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
      channelVisibility: ownerSeesAll,
    });
    const result = await checkArm(d, CTX, req({ subject: "https://acme.slack.com/archives/C0SECRET", on: [{ key: "slack.message" }] }));
    expect(result).toEqual({
      ok: false,
      text: "[wait_for_event] Valet is not in #secret, so it does not receive its messages. Invite @Valet to the channel, then wait again.",
    });
  });

  it("a personal session on a private channel passes R3 only when channelVisibility says the owner may see it", async () => {
    const subject = { subject: "https://acme.slack.com/archives/C001", on: [{ key: "slack.message" }] };
    for (const visible of [true, false]) {
      const visibilityFor = vi.fn(() => async (key: string) => key === "slack:C001" && visible);
      const d = armDeps(orgSlack("xoxb-bot"), personal, credentials({ slack: { accessToken: "xoxb-bot" } }), {
        fetch: infoByToken({ "xoxb-bot": true }, true),
        slackApiUrl: "https://slack.test/api",
        channelVisibility: visibilityFor,
      });
      const result = await checkArm(d, CTX, req(subject));
      expect(visibilityFor).toHaveBeenCalledWith({ orgId: "acme", userId: "u-001" });
      if (visible) {
        expect(result).toMatchObject({ ok: true, subjects: ["slack:T001/C001"] });
      } else {
        expect(result).toEqual({
          ok: false,
          text: "[wait_for_event] This session cannot read slack:T001/C001. Connect an account that can, or ask an admin to grant the app access.",
        });
      }
    }
  });

  it("checkArm without the turn's credentials refuses with R3 (Slack and Linear)", async () => {
    const slack = await checkArm(
      armDeps(orgSlack("xoxb-bot"), personal, undefined, { fetch: infoByToken({ "xoxb-bot": true }), slackApiUrl: "https://slack.test/api" }),
      CTX,
      req({ subject: "https://acme.slack.com/archives/C001", on: [{ key: "slack.message" }] }),
    );
    expect(slack.ok === false && slack.text).toMatch(/^\[wait_for_event\] This session cannot read slack:T001\/C001\./);

    const engineCredentials: CredentialStore = {
      ...noCredentials,
      get: async (owner, service) =>
        owner.type === "org" && service === "linear" ? { type: "oauth2", accessToken: "app", metadata: { grant: "client_credentials" } } : null,
    };
    const linear = await checkArm(
      armDeps({ ...providers(), engineCredentials }, personal, undefined, { fetch: vi.fn(async () => new Response("{}")) }),
      CTX,
      req({ subject: "https://linear.app/acme/issue/ENG-7/fix-login", on: [{ key: "linear.comment.create" }] }),
    );
    expect(linear).toEqual({
      ok: false,
      text: "[wait_for_event] This session cannot read linear:ENG-7. Connect an account that can, or ask an admin to grant the app access.",
    });
  });

  it("a bot-id lookup that never answers drops only the bot id from self", async () => {
    await linkIdentity(tdb.appDb, { provider: "slack", externalId: "U001", userId: "u-001" });
    const engineCredentials: CredentialStore = {
      ...noCredentials,
      // The org Slack credential holds the bot user id. Its read never settles.
      get: () => new Promise(() => undefined),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, user_id: "U-SHARED" })));
    const d = armDeps({ ...providers(), engineCredentials }, personal, credentials({ slack: { accessToken: "xoxp-shared" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
      timeoutMs: 30,
    });
    const self = await d.selfIds("slack");
    expect(self.sort()).toEqual(["U-SHARED", "U001"]);
  });

  it("sessionMayReadSlackChannel: a team session reads public channels only", async () => {
    const d = armDeps(providers(), { sessionId: "s-1", orgId: "acme", ownerType: "team", ownerId: "team-1" }, undefined, {});
    expect(await d.sessionMayReadSlackChannel("C001", false)).toBe(true);
    expect(await d.sessionMayReadSlackChannel("C001", true)).toBe(false);
  });

  it("followsSlackThread: true only for this owner's follow on this thread's own Slack thread (Review Focus 5)", async () => {
    await upsertFollowedThread(tdb.appDb, {
      orgId: "acme", channelType: "slack", channelId: "C001", threadTs: "1712345678.000100",
      ownerType: "user", ownerId: "u-001", createdBy: "u-001",
    });
    const own = armDeps(providers("slack:C001:1712345678.000100"), personal, undefined, {});
    expect(await own.followsSlackThread("t-1", "C001", "1712345678.000100")).toBe(true);
    // Another thread of the session does not receive that follow's replies.
    const web = armDeps(providers("web:default"), personal, undefined, {});
    expect(await web.followsSlackThread("t-1", "C001", "1712345678.000100")).toBe(false);
    // Another owner's follow does not reach this session.
    const other = armDeps(providers("slack:C001:1712345678.000100"), { ...personal, ownerId: "u-002" }, undefined, {});
    expect(await other.followsSlackThread("t-1", "C001", "1712345678.000100")).toBe(false);
  });

  it("selfIds: the owner's link, the resolved credential's actor, and the Slack bot user", async () => {
    await linkIdentity(tdb.appDb, { provider: "slack", externalId: "U001", userId: "u-001" });
    const engineCredentials: CredentialStore = {
      ...noCredentials,
      get: async (owner, service) =>
        owner.type === "org" && service === "slack" ? { type: "bot_token", accessToken: "xoxb", metadata: { botUserId: "U-BOT", teamId: "T001" } } : null,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, user_id: "U-BOT" })));
    const d = armDeps({ ...providers(), engineCredentials }, personal, credentials({ slack: { accessToken: "xoxb" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
    });
    expect((await d.selfIds("slack")).sort()).toEqual(["U-BOT", "U001"]);
    expect(await d.slackTeamId()).toBe("T001");
    expect(await d.serviceConnected("slack")).toBe(true);
    expect(await d.serviceConnected("linear")).toBe(false);
  });
});
