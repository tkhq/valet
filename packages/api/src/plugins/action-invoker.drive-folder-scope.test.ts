/**
 * The Drive folder scope end to end through the host: a scope stored on the
 * credential the way the route stores it, read by the action invoker's
 * credential provider, and enforced inside the google-workspace plugin. The
 * unit suites cover each seam; this pins that they meet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { googleWorkspacePlugin } from "@valet/plugin-google-workspace/actions";
import googleWorkspace from "@valet/plugin-google-workspace/plugin";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "./credential-store.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";

const SERVICE = "google_workspace";
/** A user-owned invocation, the shape a workflow run passes. */
const owner: ActionInvocationContext = {
  userId: "local-user",
  orgId: "local-org",
  owner: { type: "user", id: "local-user" },
};
const credentialOwner = { type: "user" as const, id: "local-user" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Drive as the plugin sees it: one listing page, plus parents for the walk. */
function stubDrive(tree: Record<string, string[] | undefined>, listing: Array<{ id: string; name: string }>) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target.includes("fields=parents")) {
      const id = decodeURIComponent(target.split("/files/")[1].split("?")[0]);
      const parents = tree[id];
      return parents === undefined ? json({ error: { code: 404 } }, 404) : json({ parents });
    }
    if (target.includes("/drive/v3/files?")) {
      return json({ files: listing.map((f) => ({ ...f, mimeType: "application/vnd.google-apps.document" })) });
    }
    throw new Error(`unexpected request: ${target}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function setup() {
  // The availability gate reads the OAuth client env; without it the
  // service is "unconfigured" and no action runs at all.
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  const { pgdb, appDb } = await freshTestPgDb();
  const credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
  await credentials.save(credentialOwner, SERVICE, { type: "oauth2", accessToken: "tok-1", metadata: { connectedVia: "oauth" } });
  // Written the way the route writes it: under settings, with a targeted update.
  await pgdb.query(
    `UPDATE credentials
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{settings}', $1::jsonb, true)
     WHERE owner_type = 'user' AND owner_id = 'local-user' AND service = $2`,
    [JSON.stringify({ driveFolderScope: { folderIds: ["fold-finance"] } }), SERVICE],
  );
  const invoke = buildActionInvoker({
    db: appDb,
    credentials,
    actionPluginByService: new Map([[SERVICE, { plugin: googleWorkspace, actionPlugin: googleWorkspacePlugin }]]),
  });
  return { credentials, invoke };
}

async function listFiles(invoke: Awaited<ReturnType<typeof setup>>["invoke"], invocationId: string): Promise<string[]> {
  const result = await invoke({ service: SERVICE, action: "drive.list_files", params: {}, invocationId }, owner);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const data = (result as { result: { files: Array<{ id: string }> } }).result;
  return data.files.map((f) => f.id);
}

describe("Drive folder scope through the action invoker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("filters a listing to the scope stored on the credential", async () => {
    const { invoke } = await setup();
    stubDrive(
      { "doc-budget": ["fold-finance"], "doc-diary": ["fold-personal"], "fold-personal": ["0ROOT"] },
      [
        { id: "doc-budget", name: "Budget 2026" },
        { id: "doc-diary", name: "Diary" },
      ],
    );

    await expect(listFiles(invoke, "scope:list:1")).resolves.toEqual(["doc-budget"]);
  });

  it("keeps the scope through a reconnect that rewrites the credential", async () => {
    const { credentials, invoke } = await setup();
    // A reconnect saves the whole row with a fresh metadata object.
    await credentials.save(credentialOwner, SERVICE, { type: "oauth2", accessToken: "tok-2", metadata: { connectedVia: "oauth" } });
    stubDrive(
      { "doc-budget": ["fold-finance"], "doc-diary": ["fold-personal"], "fold-personal": ["0ROOT"] },
      [
        { id: "doc-budget", name: "Budget 2026" },
        { id: "doc-diary", name: "Diary" },
      ],
    );

    await expect(listFiles(invoke, "scope:list:2")).resolves.toEqual(["doc-budget"]);
  });
});
