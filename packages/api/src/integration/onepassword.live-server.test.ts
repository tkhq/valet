/**
 * The 1Password SDK, exercised through a RUNNING server.
 *
 * `onepassword.live.test.ts` calls the SDK directly and passes even when the
 * feature is broken end to end. Every route test injects a fake client, so it
 * passes too. Between them sat the bug this file exists for: `serve()`
 * replaces `globalThis.Request`/`Response` with its own subclasses by default,
 * and the SDK's WASM HTTP layer, which builds requests from those globals,
 * then rejects every call with "request library compatibility issue". The
 * feature failed at boot and in every request while the whole suite stayed
 * green.
 *
 * So this test boots the real app (a real listener, through the Node adapter)
 * AND uses the real SDK, and drives it over HTTP the way a person does. It is
 * key-gated like its sibling: no `OP_SERVICE_ACCOUNT_TOKEN`, no run.
 *
 * The fix is `overrideGlobalObjects: false` in `server-adapter.node.ts`.
 * Remove it and this test fails.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { createOnePasswordService } from "../services/onepassword.js";
import type { ListOpVaultsResponse } from "../wire/types.js";

const TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
const describeIfToken = TOKEN ? describe : describe.skip;

const HEADERS = { "Content-Type": "application/json" };

describeIfToken("api integration: 1Password over a running server", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("browses real vaults through the HTTP route with the real SDK", async () => {
    if (!TOKEN) throw new Error("unreachable: gated on OP_SERVICE_ACCOUNT_TOKEN");
    api = await bootTestApi();

    // The real adapter, no `createClient` override. `getAllowPersonal` is the
    // only stub: this case never touches the personal scope.
    api.providers.onePassword = createOnePasswordService({
      credentials: api.providers.engineCredentials,
      getAllowPersonal: async () => true,
    });

    // Store the token the way the settings page does.
    const put = await fetch(`${api.baseUrl}/api/credentials/onepassword`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "service_account", scope: "org", apiKey: TOKEN }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(`${api.baseUrl}/api/onepassword/vaults?scope=org`);
    // A 400 here is the symptom the bug produced: the SDK could not build a
    // request, and `clientFor` reported it as an auth failure.
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListOpVaultsResponse;
    expect(body.vaults.length).toBeGreaterThan(0);
    for (const vault of body.vaults) {
      expect(typeof vault.id).toBe("string");
      expect(vault.id.length).toBeGreaterThan(0);
    }
  });
});
