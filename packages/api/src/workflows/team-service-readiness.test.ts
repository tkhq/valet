/**
 * Team-owned workflow service readiness (team-credentials design, decision 15).
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { githubInstallations, teamMembers, workflowDefinitions } from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import { teamArmRefusals, teamServiceReadiness } from "./team-service-readiness.js";

const ORG = "org-1";
const TEAM = "team-1";

const slackOrgPlugin: ValetPlugin = {
  name: "slack",
  version: "0.0.1",
  credentials: [
    {
      type: "bot_token",
      service: "slack",
      configKeys: ["accessToken"],
      requires: { orgCredential: true },
    },
  ],
};

const gmailPlugin: ValetPlugin = {
  name: "gmail",
  version: "0.0.1",
  credentials: [{ type: "oauth2", service: "gmail", configKeys: [] }],
};

const githubPlugin: ValetPlugin = {
  name: "github",
  version: "0.0.1",
  credentials: [{ type: "oauth2", service: "github", configKeys: [] }],
};

const linearPlugin: ValetPlugin = {
  name: "linear",
  version: "0.0.1",
  credentials: [{ type: "api_key", service: "linear", configKeys: [] }],
};

/**
 * A 1Password client whose vaults answer by item title, per scope. Only the
 * by-name lookup is exercised here; every other method throws so a read
 * that reaches one is a test failure, not a silent null.
 */
function vaultWith(
  items: Partial<Record<OnePasswordScope, Record<string, string>>>,
  calls: Array<{ scope: OnePasswordScope; ctx: OnePasswordCtx; service: string }> = [],
  resolveCredential?: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    resolveCredential: resolveCredential ?? unused,
    findCandidates: unused,
    findCredentialForService: async (scope, ctx, service) => {
      calls.push({ scope, ctx, service });
      if (scope === "team" && !items.team) throw new OnePasswordAuthError("No team token", "no_token");
      return items[scope]?.[service] ?? null;
    },
  };
}

function toolDefinition(
  service: string,
  credential?: "app" | "user" | "auto",
  params: Record<string, unknown> = {},
): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      {
        id: "step",
        type: "tool",
        service,
        action: "do",
        params,
        ...(credential !== undefined ? { credential } : {}),
      },
    ],
    edges: [{ from: "start", to: "step" }],
  };
}

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const appConfig: GithubAppConfig = {
  appId: "123456",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc123",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "oauth-client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

describe("teamServiceReadiness", () => {
  let db: AppDb;
  let credentials: InMemoryCredentialStore;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    credentials = new InMemoryCredentialStore();
  });

  function deps(plugins: ValetPlugin[] = [gmailPlugin, slackOrgPlugin, githubPlugin]) {
    return { db, credentials, plugins, env: {} as NodeJS.ProcessEnv };
  }

  it("treats a direct team credential as ready", async () => {
    await credentials.save({ type: "team", id: TEAM }, "gmail", {
      type: "oauth2",
      accessToken: "team-gmail",
    });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual(["gmail"]);
    expect(result.blocked).toEqual([]);
  });

  /** A member's own row, and the team's reference to it. */
  async function delegateGmail(opts: { member: boolean; source: boolean }) {
    if (opts.member) {
      await db.insert(teamMembers).values({ teamId: TEAM, userId: "u-1", role: "member" });
    }
    if (opts.source) {
      await credentials.save({ type: "user", id: "u-1" }, "gmail", {
        type: "oauth2",
        accessToken: "mine",
      });
    }
    await credentials.save({ type: "team", id: TEAM }, "gmail", {
      type: "oauth2",
      metadata: { delegatedFrom: "u-1" },
    });
  }

  const BROKEN_REASON =
    "gmail was shared by a member who is no longer on the team, or whose connection is gone. " +
    "Share it again, or store a team credential.";

  it("treats a delegated team reference as ready", async () => {
    await delegateGmail({ member: true, source: true });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual(["gmail"]);
    expect(result.blocked).toEqual([]);
  });

  // The team's list still shows the row after the delegator leaves, but a
  // run following it throws `CredentialReferenceBrokenError`. Readiness
  // must give the answer the run gets.
  it("blocks a delegated reference whose delegator left the team", async () => {
    await delegateGmail({ member: false, source: true });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([{ service: "gmail", reason: BROKEN_REASON }]);
  });

  it("blocks a delegated reference whose source credential is gone", async () => {
    await delegateGmail({ member: true, source: false });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([{ service: "gmail", reason: BROKEN_REASON }]);
  });

  // A team row that points at 1Password is read the way the run reads it
  // (`resolveTeamCredentialRead`): the team's lease gates the reference,
  // and a client has to turn it into a secret. A non-null row alone said
  // "resolves" for a reference the run refuses on every fire.
  describe("a team row that is a 1Password reference", () => {
    const REFERENCE = "op://Shared/Linear/token";

    async function saveReferenceRow() {
      await credentials.save({ type: "team", id: TEAM }, "linear", {
        type: "api_key",
        metadata: { onepassword: { reference: REFERENCE, tokenScope: "org" } },
      });
    }

    it("is ready when the lease grants it and the client resolves it", async () => {
      await saveReferenceRow();
      await credentials.save({ type: "team", id: TEAM }, "onepassword", {
        type: "service_account",
        metadata: { refs: [REFERENCE] },
      });
      const onePassword = vaultWith({}, [], async (row) => ({ ...row, apiKey: "lin_api_resolved" }));

      const result = await teamServiceReadiness(
        { ...deps([linearPlugin]), onePassword },
        { orgId: ORG, teamId: TEAM, definition: toolDefinition("linear") },
      );

      expect(result.ready).toEqual(["linear"]);
      expect(result.blocked).toEqual([]);
    });

    it("ignores obsolete grants when the reference resolves", async () => {
      await saveReferenceRow();
      await credentials.save({ type: "team", id: TEAM }, "onepassword", {
        type: "service_account",
        metadata: { refs: ["op://Shared/Something Else/token"] },
      });
      const onePassword = vaultWith({}, [], async (row) => ({ ...row, apiKey: "resolved" }));

      const result = await teamServiceReadiness(
        { ...deps([linearPlugin]), onePassword },
        { orgId: ORG, teamId: TEAM, definition: toolDefinition("linear") },
      );

      expect(result.ready).toEqual(["linear"]);
      expect(result.blocked).toEqual([]);
    });

    it("is blocked when no 1Password client is configured to resolve it", async () => {
      await saveReferenceRow();

      const result = await teamServiceReadiness(deps([linearPlugin]), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("linear"),
      });

      expect(result.ready).toEqual([]);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0]!.service).toBe("linear");
      expect(result.blocked[0]!.reason).toContain("1Password");
      expect(result.blocked[0]!.reason).toContain("Settings → Organization");
    });
  });

  it("treats an org-provided service as ready with no team row", async () => {
    await credentials.save({ type: "org", id: ORG }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-org",
    });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("slack"),
    });

    expect(result.ready).toEqual(["slack"]);
    expect(result.blocked).toEqual([]);
  });

  it("treats a service whose plugin declares no credential as ready", async () => {
    // Mirrors `plugins/assemble.ts#withCredentialRequirement`: an action
    // whose plugin declares no credential for its service needs nothing
    // connected, so blocking on a missing team row would refuse for no
    // reason.
    const notesPlugin: ValetPlugin = {
      name: "notes",
      version: "0.0.1",
      actions: [{ service: "notes", actions: [] }],
    };
    const result = await teamServiceReadiness(
      { ...deps([gmailPlugin]), plugins: [gmailPlugin, notesPlugin] },
      { orgId: ORG, teamId: TEAM, definition: toolDefinition("notes") },
    );
    expect(result.blocked).toEqual([]);
    expect(result.ready).toEqual(["notes"]);
  });

  // `plugins/action-invoker.ts` resolves the declaration registry-wide,
  // because it can live on a different plugin than the action's owner. A
  // per-plugin read would call the service free and arm a trigger whose
  // every fire then fails on the missing credential.
  it("blocks a service another plugin declares a credential for", async () => {
    const notesActions: ValetPlugin = {
      name: "notes-actions",
      version: "0.0.1",
      actions: [{ service: "notes", actions: [] }],
    };
    const notesCredential: ValetPlugin = {
      name: "notes",
      version: "0.0.1",
      credentials: [{ type: "api_key", service: "notes", configKeys: [] }],
    };
    const result = await teamServiceReadiness(deps([notesActions, notesCredential]), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("notes"),
    });
    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([
      { service: "notes", reason: "Connect notes for this team." },
    ]);
  });

  // The invoker's team branch skips an unhealthy github row and falls to
  // the App; readiness reads it the same way instead of arming a trigger
  // the run then refuses.
  it("treats an identity-only delegated github row as no row", async () => {
    await credentials.save({ type: "team", id: TEAM }, "github", {
      type: "oauth2",
      accessToken: "id-only",
      metadata: { identityOnly: true },
    });
    const result = await teamServiceReadiness(deps([githubPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("github"),
    });
    expect(result.ready).toEqual([]);
    expect(result.blocked.map((b) => b.service)).toEqual(["github"]);
  });

  // A transient 1Password failure must not disarm anything: it propagates
  // so the sync defers the file, while a lease or token refusal blocks.
  it("propagates a transient 1Password SDK failure instead of blocking", async () => {
    await credentials.save({ type: "team", id: TEAM }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Org/Linear/token", tokenScope: "org" } },
    });
    const onePassword: OnePasswordService = {
      ...vaultWith({}),
      resolveCredential: async () => {
        throw new OnePasswordAuthError("vault listing failed: network", "sdk");
      },
    };
    await expect(
      teamServiceReadiness(
        { ...deps([linearPlugin]), onePassword },
        { orgId: ORG, teamId: TEAM, definition: toolDefinition("linear") },
      ),
    ).rejects.toThrow(/network/);
  });

  it("requires an active installation for a GitHub App pin", async () => {
    await saveAppConfig({ credentials }, ORG, appConfig);

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("github", "app"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    await db.insert(githubInstallations).values({
      id: "app-pin", orgId: ORG, installationId: 1, accountLogin: "acme",
      accountType: "Organization", repositorySelection: "selected", suspended: false,
      createdAt: 1000, updatedAt: 1000,
    });
    const ready = await teamServiceReadiness(deps(), {
      orgId: ORG, teamId: TEAM, definition: toolDefinition("github", "app"),
    });
    expect(ready.ready).toEqual(["github"]);
    expect(ready.organizationProvided).toEqual(["github"]);
    await db.update(githubInstallations).set({ suspended: true });
    expect((await teamServiceReadiness(deps(), {
      orgId: ORG, teamId: TEAM, definition: toolDefinition("github", "app"),
    })).blocked).toHaveLength(1);
  });

  it("does not let a team token satisfy an App pin or a mismatched installation owner", async () => {
    await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", accessToken: "team-token" });
    const definition = toolDefinition("github", "app");
    expect((await teamServiceReadiness(deps(), { orgId: ORG, teamId: TEAM, definition })).blocked).toHaveLength(1);
    await saveAppConfig({ credentials }, ORG, appConfig);
    await db.insert(githubInstallations).values({
      id: "wrong-owner", orgId: ORG, installationId: 1, accountLogin: "other",
      accountType: "Organization", repositorySelection: "all", suspended: false,
      createdAt: 1000, updatedAt: 1000,
    });
    for (const node of definition.nodes) if (node.type === "tool") node.params = { owner: "acme", repo: "platform" };
    expect((await teamServiceReadiness(deps(), { orgId: ORG, teamId: TEAM, definition })).blocked).toHaveLength(1);
  });

  it("blocks a GitHub App pin when no App is configured", async () => {
    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("github", "app"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.service).toBe("github");
    expect(result.blocked[0]!.reason).toContain("Settings → Organization");
  });

  // A team `auto` github node resolves the App installation for the node's
  // repository owner, or the org's sole installation
  // (`plugins/action-invoker.ts`, team branch). Counting only `app` pins
  // blocked every unpinned github node a run would have served.
  describe("an unpinned github node", () => {
    async function installApp(accounts: string[]) {
      await saveAppConfig({ credentials }, ORG, appConfig);
      for (const [i, accountLogin] of accounts.entries()) {
        await db.insert(githubInstallations).values({
          id: `ghi_${i}`,
          orgId: ORG,
          installationId: i + 1,
          accountLogin,
          accountType: "Organization",
          repositorySelection: "all",
          suspended: false,
          createdAt: 1_000,
          updatedAt: 1_000,
        });
      }
    }

    it("is ready through the org's sole installation", async () => {
      await installApp(["acme"]);

      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github"),
      });

      expect(result.ready).toEqual(["github"]);
      expect(result.blocked).toEqual([]);
    });

    it("is ready through the installation its owner parameter names", async () => {
      await installApp(["acme", "other"]);

      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github", "auto", { owner: "other", repo: "repo" }),
      });

      expect(result.ready).toEqual(["github"]);
      expect(result.blocked).toEqual([]);
    });

    it("is blocked when several installations exist and no owner parameter picks one", async () => {
      await installApp(["acme", "other"]);

      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github"),
      });

      expect(result.ready).toEqual([]);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0]!.service).toBe("github");
      expect(result.blocked[0]!.reason).toContain("owner");
      expect(result.blocked[0]!.reason).toContain("install the App on exactly one account");
    });

    it("is blocked naming the owner that has no installation", async () => {
      await installApp(["acme", "other"]);

      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github", undefined, { owner: "nobody", repo: "repo" }),
      });

      expect(result.ready).toEqual([]);
      expect(result.blocked).toEqual([
        {
          service: "github",
          reason:
            "github has no App installation for nobody. Install the App on nobody in " +
            "Settings → Organization → GitHub, or store a github credential for the team.",
        },
      ]);
    });

    it.each([false, true])("points to organization setup when no installation resolves (App configured=%s)", async (configured) => {
      if (configured) await installApp([]);
      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github"),
      });

      expect(result.ready).toEqual([]);
      expect(result.blocked).toEqual([{ service: "github", reason: "An admin can set up or refresh the organization GitHub App in Settings → Organization → GitHub." }]);
      expect(result.organizationProvided).toEqual(["github"]);
    });

    it.each([undefined, "user"] as const)("keeps a team vault credential ready for a %s pin", async (pin) => {
      const onePassword = vaultWith({ team: { github: "ghp_fixture" } });
      const result = await teamServiceReadiness({ ...deps(), onePassword }, {
        orgId: ORG, teamId: TEAM, definition: toolDefinition("github", pin),
      });
      expect(result.ready).toEqual(["github"]);
      expect(result.blocked).toEqual([]);
      expect(result.organizationProvided).toBeUndefined();
    });

    it("stays on the team row for a user pin, whatever the App holds", async () => {
      await installApp(["acme"]);

      const result = await teamServiceReadiness(deps(), {
        orgId: ORG,
        teamId: TEAM,
        definition: toolDefinition("github", "user"),
      });

      expect(result.ready).toEqual([]);
      expect(result.blocked).toEqual([{ service: "github", reason: "Connect github for this team." }]);
      expect(result.organizationProvided).toBeUndefined();
    });
  });

  // `resolveTeamCredentialRead` falls through to the vaults on the org
  // scope when no row answers, so a run resolves an org-vault item titled
  // with the service. The predicate has to say the same, or a team is
  // refused a template and left unarmed for a credential its run would use.
  it("treats an org-scoped 1Password item as ready with no team row", async () => {
    const calls: Array<{ scope: OnePasswordScope; ctx: OnePasswordCtx; service: string }> = [];
    const onePassword = vaultWith({ org: { linear: "lin_api_xxx" } }, calls);

    const result = await teamServiceReadiness(
      { ...deps([linearPlugin]), onePassword },
      { orgId: ORG, teamId: TEAM, definition: toolDefinition("linear") },
    );

    expect(result.ready).toEqual(["linear"]);
    expect(result.blocked).toEqual([]);
    // The org scope alone, as the run reads it: a team run never borrows a
    // member's personal vault, and no member is the actor here.
    expect(calls).toEqual(["team", "org"].map((scope) => ({ scope, ctx: { orgId: ORG, teamId: TEAM, userId: "" }, service: "linear" })));
  });

  // The invoker refuses a service whose org prerequisite is missing before
  // it reads any credential, so a vault item must not arm what the run
  // would refuse: a Slack digest armed this way fails on every fire.
  it("blocks an org-prerequisite service the vault names but the org never configured", async () => {
    const onePassword = vaultWith({ org: { slack: "xoxb-from-a-vault-item" } });

    const result = await teamServiceReadiness(
      { ...deps([slackOrgPlugin]), onePassword },
      { orgId: ORG, teamId: TEAM, definition: toolDefinition("slack") },
    );

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([
      {
        service: "slack",
        reason: "slack is not configured for this organization. An admin can set it up in Settings → Organization.",
      },
    ]);
  });

  it("does not treat a personal-scope 1Password item as a team hit", async () => {
    const onePassword = vaultWith({ personal: { linear: "lin_api_xxx" } });

    const result = await teamServiceReadiness(
      { ...deps([linearPlugin]), onePassword },
      { orgId: ORG, teamId: TEAM, definition: toolDefinition("linear") },
    );

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([{ service: "linear", reason: "Connect linear for this team." }]);
  });

  it("stays blocked when no 1Password client is configured", async () => {
    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("linear"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([{ service: "linear", reason: "Connect linear for this team." }]);
  });

  it("reports an unmet service by name", async () => {
    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([
      { service: "gmail", reason: "Connect gmail for this team." },
    ]);
  });

  it("does not treat a personal credential as a team hit", async () => {
    await credentials.save({ type: "user", id: "u-1" }, "gmail", {
      type: "oauth2",
      accessToken: "mine",
    });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked.map((b) => b.service)).toEqual(["gmail"]);
  });
  // ── A called workflow's tool nodes (TKAI-443) ──────────────────────────
  //
  // A `workflow` node runs the callee's nodes as the SAME owner, so a
  // service the callee names is a service the team must be able to act as.
  // Judged on the parent's own nodes alone, the install passes and the run
  // fails at the child, which is what the gate exists to prevent.

  /** Stores `definition` as a workflow owned by `owner`, and returns its id. */
  async function storeWorkflow(
    id: string,
    definition: WorkflowDefinition,
    owner: { ownerType: "user" | "team" | "org"; ownerId: string } = { ownerType: "team", ownerId: TEAM },
  ): Promise<string> {
    await db.insert(workflowDefinitions).values({
      id,
      orgId: ORG,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      name: id,
      definition,
      createdAt: 1,
      updatedAt: 1,
    });
    return id;
  }

  /** A parent whose only work is a call to `calleeId`. */
  function callerDefinition(calleeId: string): WorkflowDefinition {
    return {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "call", type: "workflow", workflowId: calleeId },
      ],
      edges: [{ from: "start", to: "call" }],
    };
  }

  it("blocks a service only the called workflow names", async () => {
    await storeWorkflow("wf_callee", toolDefinition("linear"));

    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: callerDefinition("wf_callee"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([{ service: "linear", reason: "Connect linear for this team." }]);
  });

  it("reads a called workflow the team holds a credential for as ready", async () => {
    await storeWorkflow("wf_callee", toolDefinition("linear"));
    await credentials.save({ type: "team", id: TEAM }, "linear", { type: "api_key", apiKey: "k" });

    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: callerDefinition("wf_callee"),
    });

    expect(result.ready).toEqual(["linear"]);
    expect(result.blocked).toEqual([]);
    expect(result.unverifiable).toEqual([]);
  });

  it("expands a call made from a foreach body", async () => {
    await storeWorkflow("wf_callee", toolDefinition("linear"));

    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          {
            id: "loop",
            type: "foreach",
            items: "{{trigger.data.items}}",
            body: { id: "each", type: "workflow", workflowId: "wf_callee" },
          },
        ],
        edges: [{ from: "start", to: "loop" }],
      },
    });

    expect(result.blocked.map((b) => b.service)).toEqual(["linear"]);
  });

  // `resolveWorkflow` answers null for a definition another owner holds, so
  // the run fails at the call node. The gate must not arm what the run
  // refuses on every fire.
  it("refuses a call to a workflow the team does not own", async () => {
    await storeWorkflow("wf_other", toolDefinition("linear"), { ownerType: "team", ownerId: "team-2" });

    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: callerDefinition("wf_other"),
    });

    expect(result.unverifiable).toEqual([
      {
        workflowId: "wf_other",
        reason:
          'This workflow calls workflow "wf_other", which does not exist or belongs to another owner, so the ' +
          "call fails on every run. Reference a workflow this team owns, or remove the call.",
      },
    ]);
  });

  it("gathers blocked services and unreadable calls into one refusal list", async () => {
    await storeWorkflow("wf_callee", toolDefinition("linear"));

    const result = await teamServiceReadiness(deps([linearPlugin]), {
      orgId: ORG,
      teamId: TEAM,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          { id: "call", type: "workflow", workflowId: "wf_callee" },
          { id: "gone", type: "workflow", workflowId: "wf_gone" },
        ],
        edges: [{ from: "start", to: "call" }],
      },
    });

    expect(teamArmRefusals(result).map((r) => r.service)).toEqual(["linear", undefined]);
    expect(teamArmRefusals(result)).toHaveLength(2);
  });
});
