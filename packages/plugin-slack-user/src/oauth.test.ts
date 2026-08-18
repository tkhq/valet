import { describe, it, expect } from "vitest";
import { SLACK_USER_SCOPES, interpretSlackUserTokenResponse } from "./oauth.js";

const OK = {
  ok: true,
  app_id: "A1",
  authed_user: { id: "U7", access_token: "xoxp-7", token_type: "user", scope: SLACK_USER_SCOPES.join(",") },
  team: { id: "T7", name: "Acme" },
};

describe("interpretSlackUserTokenResponse", () => {
  it("extracts the nested user token, metadata, and identity", () => {
    const r = interpretSlackUserTokenResponse(OK);
    expect(r.accessToken).toBe("xoxp-7");
    expect(r.metadata).toEqual({ slack_user_id: "U7", team_id: "T7", team_name: "Acme" });
    expect(r.identity).toEqual({ provider: "slack", externalId: "U7", teamId: "T7" });
    expect(r.grantedScopes).toEqual([...SLACK_USER_SCOPES]);
    expect(r.expiresInSec).toBeUndefined();
  });

  it("rejects ok:false with the provider error and a corrective action", () => {
    expect(() => interpretSlackUserTokenResponse({ ok: false, error: "access_denied" }))
      .toThrow(/access_denied.*try connecting again/i);
  });

  it("rejects a bot-token-only response (no authed_user token)", () => {
    expect(() => interpretSlackUserTokenResponse({ ok: true, access_token: "xoxb-1", authed_user: { id: "U7" } }))
      .toThrow(/user token/i);
  });

  it("rejects a scope shortfall naming the reinstall fix", () => {
    const short = { ...OK, authed_user: { ...OK.authed_user, scope: "chat:write" } };
    expect(() => interpretSlackUserTokenResponse(short)).toThrow(/Reinstall the Slack app/);
  });
});
