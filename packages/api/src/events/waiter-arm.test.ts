/**
 * Arm checks for `wait_for_event` (spec 2026-10-15: event wakeups, Part D1).
 * One test per refusal over stubbed deps, plus the pass cases. The plugins
 * are the real GitHub, Slack, and Linear manifests, so subject parsing and
 * the event catalogs are the shipped ones.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { ArmEventRequest, Credential, CredentialProvider, CredentialStore, ThreadData } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
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
    expect(result).toEqual({ ok: true, subjects: ["github:acme/lean-proofs#42"], self: ["1001", "9001"] });
    expect(covers).toHaveBeenCalledWith("acme");
    expect(readGithub).toHaveBeenCalledWith({ owner: "acme", repo: "lean-proofs", number: 42 });
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

  it("readGithub without a session credential is unreadable", async () => {
    const d = armDeps(providers(), personal, undefined, {});
    expect(await d.readGithub({ owner: "acme", repo: "lean-proofs" })).toEqual({ readable: false });
  });

  it("readSlackChannel: channel_not_found reads as not_found, a member channel as public and joined", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("C404")
        ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
        : new Response(JSON.stringify({ ok: true, channel: { id: "C001", name: "general", is_private: false, is_member: true } })));
    const d = armDeps(providers(), personal, credentials({ slack: { accessToken: "xoxb" } }), {
      fetch: fetchImpl,
      slackApiUrl: "https://slack.test/api",
    });
    expect(await d.readSlackChannel("C404")).toEqual({ ok: false, reason: "not_found" });
    expect(await d.readSlackChannel("C001")).toEqual({ ok: true, isPrivate: false, isMember: true, name: "general" });
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
