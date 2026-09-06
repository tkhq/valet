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
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
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
  credentials: [{ type: "oauth2", service: "gmail" }],
};

const githubPlugin: ValetPlugin = {
  name: "github",
  version: "0.0.1",
  credentials: [{ type: "oauth2", service: "github" }],
};

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

  it("treats a delegated team reference as ready", async () => {
    await credentials.save({ type: "team", id: TEAM }, "gmail", {
      type: "oauth2",
      metadata: { delegatedFrom: "user:u-1" },
    });

    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual(["gmail"]);
    expect(result.blocked).toEqual([]);
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

  it("reports an unmet service by name", async () => {
    const result = await teamServiceReadiness(deps(), {
      orgId: ORG,
      teamId: TEAM,
      definition: toolDefinition("gmail"),
    });

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([
      { service: "gmail", reason: "Connect gmail for this team, then install this template." },
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
