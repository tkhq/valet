/**
 * The API entry point re-exports the Linear plugin's client. The connect
 * route checks `instanceof LinearTokenError` to pick its 400 message, so the
 * plugin and the API must share one error constructor.
 */
import { afterEach, expect, it, vi } from "vitest";
import * as plugin from "@valet/plugin-linear/service";
import * as api from "./linear.js";

afterEach(() => vi.restoreAllMocks());

it("shares the plugin's error type and constants", () => {
  expect(api.LinearTokenError).toBe(plugin.LinearTokenError);
  expect(api.LINEAR_APP_SCOPES).toBe(plugin.LINEAR_APP_SCOPES);
  expect(api.LINEAR_WEBHOOK_RESOURCE_TYPES).toBe(plugin.LINEAR_WEBHOOK_RESOURCE_TYPES);
});

it("surfaces a plugin token refusal as the API's LinearTokenError", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: "invalid_client" }, { status: 401 }));
  const err = await plugin.createLinearService({ clientId: "id", clientSecret: "secret" }, { LINEAR_API_URL: "https://linear.fixture" })
    .clientCredentialsToken().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(api.LinearTokenError);
  expect(err).toMatchObject({ status: 401, detail: "invalid_client" });
});
