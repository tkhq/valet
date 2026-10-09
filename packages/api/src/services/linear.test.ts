/**
 * The API's Linear client entry point. The connect route and the app-token
 * store both build their client here, so these tests pin what they depend
 * on: the exact requests Linear receives, the error type the route checks
 * with `instanceof`, the `LINEAR_API_URL` default, and a provider diagnostic
 * (never a TypeError) for malformed GraphQL responses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLinearService,
  LINEAR_APP_SCOPES,
  LINEAR_WEBHOOK_RESOURCE_TYPES,
  LinearTokenError,
  resolveLinearApiUrl,
} from "./linear.js";
import { startLinearFixture, type LinearFixture, type LinearFixtureResponse } from "../test-helpers/linear-fixture.js";

const CONFIG = { clientId: "lin-client-id", clientSecret: "lin-client-secret" };
const DAY_MS = 24 * 60 * 60 * 1000;

let fixture: LinearFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function useFixture(overrides: Parameters<typeof startLinearFixture>[0] = {}): LinearFixture {
  fixture = startLinearFixture(overrides);
  return fixture;
}

async function failure(pending: Promise<unknown>): Promise<Error> {
  const err = await pending.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe("Linear client requests", () => {
  it("keeps the shared constants", () => {
    expect(LINEAR_APP_SCOPES).toBe("read,write");
    expect(LINEAR_WEBHOOK_RESOURCE_TYPES).toEqual(["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"]);
  });

  it("mints the app token with one form POST to the token endpoint", async () => {
    const f = useFixture();
    const before = Date.now();
    const token = await createLinearService(CONFIG, { LINEAR_API_URL: f.url }).clientCredentialsToken();
    expect(f.calls).toEqual([{
      method: "POST",
      path: "/oauth/token",
      authHeader: undefined,
      body: { grant_type: "client_credentials", scope: "read,write", client_id: "lin-client-id", client_secret: "lin-client-secret" },
    }]);
    expect(token.accessToken).toBe("lin_app_token");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 2_591_999_000);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 2_591_999_000);
  });

  it("falls back to a 30-day expiry when Linear omits expires_in", async () => {
    const f = useFixture({ oauthToken: () => ({ body: { access_token: "renewed" } }) });
    const before = Date.now();
    const token = await createLinearService(CONFIG, { LINEAR_API_URL: f.url }).clientCredentialsToken();
    expect(token.accessToken).toBe("renewed");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  it("reads the workspace with a bearer GraphQL request", async () => {
    const f = useFixture();
    const workspace = await createLinearService(CONFIG, { LINEAR_API_URL: f.url }).fetchWorkspace("lin_app_token");
    expect(workspace).toEqual({ workspaceId: "lin-org-1", workspaceName: "Turnkey" });
    expect(f.calls).toEqual([{
      method: "POST",
      path: "/graphql",
      authHeader: "Bearer lin_app_token",
      body: { query: "{ organization { id name } viewer { id } }" },
    }]);
  });

  it("deletes a legacy webhook by ID", async () => {
    const f = useFixture();
    await createLinearService(CONFIG, { LINEAR_API_URL: f.url }).deleteWebhook("lin_app_token", "hook-1");
    expect(f.calls).toEqual([{
      method: "POST",
      path: "/graphql",
      authHeader: "Bearer lin_app_token",
      body: { query: "mutation($id: String!) { webhookDelete(id: $id) { success } }", variables: { id: "hook-1" } },
    }]);
  });
});

describe("Linear endpoint defaults", () => {
  it("uses LINEAR_API_URL from the process environment when the caller passes no environment", async () => {
    const f = useFixture();
    vi.stubEnv("LINEAR_API_URL", f.url);
    await createLinearService(CONFIG).clientCredentialsToken();
    expect(f.calls.map((call) => call.path)).toEqual(["/oauth/token"]);
  });

  it("uses Linear's public API host when LINEAR_API_URL is unset or empty", async () => {
    expect(resolveLinearApiUrl({})).toBe("https://api.linear.app");
    expect(resolveLinearApiUrl({ LINEAR_API_URL: "" })).toBe("https://api.linear.app");
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return Response.json({ access_token: "t", expires_in: 60 });
    });
    await createLinearService(CONFIG, {}).clientCredentialsToken();
    expect(urls).toEqual(["https://api.linear.app/oauth/token"]);
  });
});

describe("Linear token refusals", () => {
  it("surfaces error_description in LinearTokenError", async () => {
    const f = useFixture({ oauthToken: () => ({ status: 400, body: { error: "unsupported_grant_type", error_description: "Client does not support the client_credentials grant type" } }) });
    const err = await failure(createLinearService(CONFIG, { LINEAR_API_URL: f.url }).clientCredentialsToken());
    expect(err).toBeInstanceOf(LinearTokenError);
    expect(err).toMatchObject({
      name: "LinearTokenError",
      status: 400,
      detail: "Client does not support the client_credentials grant type",
      message: "Linear client credentials: returned 400: Client does not support the client_credentials grant type",
    });
  });

  it("falls back to the OAuth error code when there is no description", async () => {
    const f = useFixture({ oauthToken: () => ({ status: 401, body: { error: "invalid_client" } }) });
    const err = await failure(createLinearService(CONFIG, { LINEAR_API_URL: f.url }).clientCredentialsToken());
    expect(err).toBeInstanceOf(LinearTokenError);
    expect(err).toMatchObject({ status: 401, detail: "invalid_client" });
  });

  it("reports a 200 response without an access token as a plain provider error", async () => {
    const f = useFixture({ oauthToken: () => ({ body: null }) });
    const err = await failure(createLinearService(CONFIG, { LINEAR_API_URL: f.url }).clientCredentialsToken());
    expect(err).not.toBeInstanceOf(LinearTokenError);
    expect(err.message).toBe("Linear client credentials: no access_token in response");
  });
});

describe("malformed GraphQL responses", () => {
  const workspaceCases: Array<[string, LinearFixtureResponse, string]> = [
    ["a null body", { body: null }, "Linear fetchWorkspace: response has no data"],
    ["a body without data", { body: {} }, "Linear fetchWorkspace: response has no data"],
    ["null data", { body: { data: null } }, "Linear fetchWorkspace: response has no data"],
    ["a null organization", { body: { data: { organization: null } } }, "Linear fetchWorkspace: malformed organization in response"],
    ["an organization with a null id", { body: { data: { organization: { id: null, name: "Turnkey" } } } }, "Linear fetchWorkspace: malformed organization in response"],
    ["GraphQL errors with HTTP 200", { body: { errors: [{ message: "Authentication required" }] } }, 'Linear fetchWorkspace: GraphQL errors: [{"message":"Authentication required"}]'],
    ["GraphQL errors next to null data", { body: { data: null, errors: [{ message: "boom" }] } }, 'Linear fetchWorkspace: GraphQL errors: [{"message":"boom"}]'],
  ];

  it.each(workspaceCases)("workspace lookup reports %s as a provider diagnostic", async (_label, response, message) => {
    const f = useFixture({ organization: () => response });
    const err = await failure(createLinearService(CONFIG, { LINEAR_API_URL: f.url }).fetchWorkspace("lin_app_token"));
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toBe(message);
  });

  const webhookCases: Array<[string, LinearFixtureResponse, string]> = [
    ["a null body", { body: null }, "Linear webhookDelete: response has no data"],
    ["a null mutation result", { body: { data: { webhookDelete: null } } }, 'Linear webhookDelete: mutation did not succeed: {"webhookDelete":null}'],
    ["GraphQL errors with HTTP 200", { body: { errors: [{ message: "Entity not found" }] } }, 'Linear webhookDelete: GraphQL errors: [{"message":"Entity not found"}]'],
  ];

  it.each(webhookCases)("legacy webhook deletion reports %s as a provider diagnostic", async (_label, response, message) => {
    const f = useFixture({ webhookDelete: () => response });
    const err = await failure(createLinearService(CONFIG, { LINEAR_API_URL: f.url }).deleteWebhook("lin_app_token", "hook-1"));
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toBe(message);
  });
});
