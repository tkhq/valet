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
import { teamMembers } from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import type { OnePasswordCtx, OnePasswordScope, OnePasswordService } from "../services/onepassword.js";
import { teamServiceReadiness } from "./team-service-readiness.js";

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
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    resolveCredential: unused,
    findCandidates: unused,
    findCredentialForService: async (scope, ctx, service) => {
      calls.push({ scope, ctx, service });
      return items[scope]?.[service] ?? null;
    },
  };
}

function toolDefinition(
  service: string,
  credential?: "app" | "user" | "auto",
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
        params: {},
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

  it("treats a GitHub App pin as ready when an App is configured", async () => {
    await saveAppConfig({ credentials }, ORG, appConfig);

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("github", "app"),
    });

    expect(result.ready).toEqual(["github"]);
    expect(result.blocked).toEqual([]);
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
    expect(calls).toEqual([{ scope: "org", ctx: { orgId: ORG, userId: "" }, service: "linear" }]);
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
});
