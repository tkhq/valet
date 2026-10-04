import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { linkIdentity } from "../channels/identity-links.js";
import { events } from "../schema/index.js";
import { resetThreadAccessCache } from "../services/thread-access.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

/** Answers Slack's channel checks: `members` lists each private channel's members. */
async function connectSlack(a: TestApi, members: Record<string, string[]>) {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const body = url.pathname.endsWith("conversations.members")
      ? { ok: true, members: members[channel] ?? [] }
      : { ok: true, channel: { name: channel.toLowerCase(), is_private: members[channel] !== undefined } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

it("shows a private Slack channel's events only to the channel's members", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "local-user" });
  const event = (id: string, service: string, eventKey: string, payload: Record<string, unknown>, refs: Record<string, string> = {}) => ({
    id, orgId: "local-org", service, eventKey, dedupeKey: id, refs, summary: eventKey, payload, occurredAt: 1, receivedAt: 1,
  });
  await api.providers.db.insert(events).values([
    event("private-message", "slack", "slack.message", { channel: "CPRIV", text: "private plan" }, { channel: "CPRIV" }),
    event("private-reaction", "slack", "slack.reaction_added", { item: { channel: "CPRIV", ts: "1.1" } }, { channel: "CPRIV" }),
    // A row stored before ingest copied the channel to refs.
    event("private-reaction-old", "slack", "slack.reaction_added", { item: { channel: "CPRIV", ts: "1.1" } }),
    event("public-message", "slack", "slack.message", { channel: "CPUB", text: "hello" }, { channel: "CPUB" }),
    event("github-push", "github", "github.push", { ref: "main" }),
  ]);
  const get = (id: string, user?: string) =>
    fetch(`${api!.baseUrl}/api/events/${id}`, user ? { headers: { "x-valet-test-user-id": user } } : {});

  for (const id of ["private-message", "private-reaction", "private-reaction-old"]) {
    expect((await get(id)).status).toBe(200);
    expect((await get(id, "test-member")).status).toBe(404);
  }
  expect((await fetch(`${api.baseUrl}/api/events/private-message/redeliver`, {
    method: "POST", headers: { "x-valet-test-user-id": "test-member" },
  })).status).toBe(404);
  expect((await get("public-message", "test-member")).status).toBe(200);
  expect((await get("github-push", "test-member")).status).toBe(200);
});
