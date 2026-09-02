/**
 * The claim under test: connecting a service-account token is enough for an
 * agent's tools to get their credentials, with no per-service setup.
 *
 * That claim spans three seams and no unit test crosses all of them — the
 * session's credential provider, the host resolver behind it, and the
 * tool-availability probe in `plugin-catalog` that decides whether a tool is
 * even offered to the model. A service with no credential has its tools
 * HIDDEN, so a resolver that works but is never asked would look identical to
 * one that works, right up until a demo.
 *
 * Key-gated on OP_SERVICE_ACCOUNT_TOKEN, like the other live rows.
 */
import { describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { ONEPASSWORD_SERVICE } from "../services/onepassword.js";
import linearPlugin from "@valet/plugin-linear/plugin";

const TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
/** An item title in a reachable vault that names a service Valet knows. */
const SERVICE = process.env.OP_AGENT_PULL_SERVICE;
const describeIfLive = TOKEN && SERVICE ? describe : describe.skip;

describeIfLive("api integration: an agent pulls a credential from 1Password", () => {
  it("resolves a service with no stored row, through the session's own provider", async () => {
    if (!TOKEN || !SERVICE) throw new Error("unreachable: gated above");
    // The boot-time service is the one a session's credential provider
    // closes over; replacing `api.providers.onePassword` afterwards changes
    // nothing a session sees. Boot builds a real service with the same deps.
    const api: TestApi = await bootTestApi({ plugins: [linearPlugin] });
    try {
      // Only the 1Password token is stored. Nothing maps SERVICE to anything.
      await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, ONEPASSWORD_SERVICE, {
        type: "service_account",
        apiKey: TOKEN,
      });
      expect(await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, SERVICE)).toBeNull();

      const session = await api.providers.engineHost.sessionFor("sess-op-agent-pull", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp",
      });
      const cred = await session.credentialProvider().get(SERVICE);

      // Length only: the secret is real and must not reach test output.
      expect(cred?.accessToken?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await api.cleanup();
    }
  });
});
