/**
 * A fake Slack Web API on port 0, for connect-time validation tests.
 * Same shape as `github-fixture.ts`: a real Hono server the code under test
 * reaches over HTTP, pointed at by `VALET_SLACK_API_BASE`.
 *
 * Only `auth.test` is modelled, because that is the one method
 * `services/slack-connect.ts` calls. The fixture can also set the
 * `x-oauth-scopes` response header, which is where Slack reports the scopes
 * the installed app granted.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface SlackFixtureAuthTest {
  status?: ContentfulStatusCode;
  body: Record<string, unknown>;
  /** Value for the `x-oauth-scopes` header. Omit to send no header at all. */
  scopes?: string;
}

export interface SlackFixture {
  url: string;
  /** Authorization headers seen, newest last. */
  calls: (string | undefined)[];
  close(): Promise<void>;
}

const DEFAULT_AUTH_TEST: SlackFixtureAuthTest = {
  body: {
    ok: true,
    url: "https://fixture.slack.com/",
    team: "Fixture Workspace",
    user: "valet",
    team_id: "T0FIXTURE",
    user_id: "U0BOTFIXTURE",
    bot_id: "B0FIXTURE",
  },
  scopes: "assistant:write,chat:write,im:history,users:read,files:read,files:write",
};

/** Starts the fixture. Callers MUST `await close()` — nothing else stops the listener. */
export function startSlackFixture(authTest: SlackFixtureAuthTest = DEFAULT_AUTH_TEST): SlackFixture {
  const calls: (string | undefined)[] = [];
  const app = new Hono();

  app.post("/auth.test", (c) => {
    calls.push(c.req.header("authorization"));
    if (authTest.scopes !== undefined) c.header("x-oauth-scopes", authTest.scopes);
    return c.json(authTest.body, authTest.status ?? 200);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("slack fixture: no port assigned");

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
