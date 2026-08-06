/**
 * A `github` tool node inside a real workflow run, driven through a full
 * `bootTestApi` boot (real Hono app, real `LocalRunHost`, real
 * `PgCredentialStore`) against the shared fake GitHub API server.
 *
 * What this covers that the `action-invoker.test.ts` unit tests cannot: the
 * WIRING. The tool executor forwards `ToolNode.credential` to
 * `WorkflowEngineDeps.invokeAction`, `buildWorkflowEngineDeps` hands the
 * invoker its `githubTokenDeps`, and the invoker resolves the GitHub App
 * installation. Every hop has to be connected for these to pass.
 *
 * The product rule under test: an automated review posts as the GitHub App
 * installation, never as the person who saved the workflow. Workflow
 * definitions are all `ownerType: "user"`, so an unqualified node would
 * resolve that person's own GitHub credential first.
 *
 * The fixture action plugin registers under the `github` service and simply
 * returns the token it was handed — `plugin-github`'s real actions build an
 * `Octokit` pinned to `api.github.com` with no base-URL override, so they
 * cannot be pointed at the fixture server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { githubInstallations } from "../schema/index.js";
import type { CreateWorkflowResponse, GetWorkflowRunResponse, StartWorkflowRunResponse } from "../wire/types.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";
const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
});

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_CONFIG: GithubAppConfig = {
  appId: "1",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

/** `github`-service action that reports the token it resolved, so a test
 * can assert WHICH identity the action ran as. */
function echoTokenAction(): PluginAction {
  return {
    id: "github.echo_token",
    name: "echo_token",
    description: "report the resolved github token",
    riskLevel: "low",
    parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
    execute: async (_args, ctx) => {
      const cred = await ctx.credentials.get();
      const token = cred?.accessToken;
      if (!token) throw new Error("Missing GitHub access token. Connect the GitHub integration in Settings.");
      return { success: true, data: { token } };
    },
  };
}

function echoTokenPlugin(): ValetPlugin {
  const actionPlugin: ActionPlugin = { service: "github", actions: [echoTokenAction()] };
  return { name: "github-echo", version: "0.0.1", actions: [actionPlugin] };
}

function definitionWith(credential: "app" | "user" | "auto" | undefined) {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      {
        id: "comment",
        type: "tool",
        service: "github",
        action: "echo_token",
        params: { owner: "acme", repo: "widgets" },
        ...(credential !== undefined ? { credential } : {}),
      },
      { id: "done", type: "stop" },
    ],
    edges: [
      { from: "trigger", to: "comment" },
      { from: "comment", to: "done" },
    ],
  };
}

/** Boots the app with the fixture GitHub API wired into BOTH the engine
 * host and the workflow action invoker, exactly as production wires them
 * from one key. */
async function boot(): Promise<TestApi> {
  fixture = startGithubFixture({
    createInstallationToken: (id) => ({
      body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
    }),
  });
  return bootTestApi({
    plugins: [echoTokenPlugin()],
    githubTokenDeps: { key: deriveSecretKey("test-key"), apiUrl: fixture.url, githubUrl: fixture.url },
  });
}

/** A healthy personal GitHub credential for the workflow owner. An
 * `app`-credential node must ignore it. */
async function connectUser(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "user", id: USER_ID }, "github", {
    type: "oauth2",
    accessToken: "user-tok",
    metadata: { login: "octocat" },
  });
}

async function installAppOn(a: TestApi, accountLogin: string, installationId: number): Promise<void> {
  await saveAppConfig({ credentials: a.providers.engineCredentials }, ORG_ID, APP_CONFIG);
  const now = Date.now();
  await a.providers.db.insert(githubInstallations).values({
    id: `ghi_${installationId}`,
    orgId: ORG_ID,
    installationId,
    accountLogin,
    accountType: "Organization",
    repositorySelection: "all",
    suspended: false,
    cachedToken: null,
    cachedTokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Creates the workflow, starts a run, and polls until the run settles. */
async function runDefinition(a: TestApi, definition: unknown, name: string): Promise<GetWorkflowRunResponse> {
  const createRes = await fetch(`${a.baseUrl}/api/workflows`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name, definition }),
  });
  expect(createRes.status).toBe(201);
  const { id: workflowId } = (await createRes.json()) as CreateWorkflowResponse;

  const startRes = await fetch(`${a.baseUrl}/api/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: HEADERS,
    body: "{}",
  });
  expect(startRes.status).toBe(201);
  const { runId } = (await startRes.json()) as StartWorkflowRunResponse;

  const deadline = Date.now() + 15_000;
  let detail: GetWorkflowRunResponse | undefined;
  for (;;) {
    const res = await fetch(`${a.baseUrl}/api/workflows/runs/${runId}`);
    expect(res.status).toBe(200);
    detail = (await res.json()) as GetWorkflowRunResponse;
    if (detail.run.status === "settled") return detail;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle: ${JSON.stringify(detail.run)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface EchoedToken {
  token?: unknown;
}

describe("api integration: github tool node credential selection", () => {
  it('credential "app": the node runs as the installation, not as the connected workflow owner', async () => {
    api = await boot();
    await connectUser(api);
    await installAppOn(api, "acme", 555);

    const detail = await runDefinition(api, definitionWith("app"), "gh-app-credential");

    const checkpoint = detail.checkpoints.find((c) => c.nodeId === "comment");
    expect(checkpoint?.status).toBe("completed");
    expect((checkpoint?.result as EchoedToken | undefined)?.token).toBe("inst-555");
    expect(detail.run.outcome).toBe("completed");
  }, 30_000);

  it("no credential selection keeps the pre-existing precedence: the owner's own token", async () => {
    api = await boot();
    await connectUser(api);
    await installAppOn(api, "acme", 556);

    const detail = await runDefinition(api, definitionWith(undefined), "gh-default-credential");

    const checkpoint = detail.checkpoints.find((c) => c.nodeId === "comment");
    expect(checkpoint?.status).toBe("completed");
    expect((checkpoint?.result as EchoedToken | undefined)?.token).toBe("user-tok");
  }, 30_000);

  it('credential "app": the node FAILS when the App is not installed, and never uses the owner\'s token', async () => {
    api = await boot();
    await connectUser(api);
    // Installed on a different account than the node's `owner` param.
    await installAppOn(api, "other-org", 557);

    const detail = await runDefinition(api, definitionWith("app"), "gh-app-not-installed");

    const checkpoint = detail.checkpoints.find((c) => c.nodeId === "comment");
    expect(checkpoint?.status).toBe("failed");
    expect(checkpoint?.error).toBe("the GitHub App is not installed on acme");
    expect(detail.run.outcome).toBe("failed");
  }, 30_000);
});
