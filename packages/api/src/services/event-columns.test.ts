import { afterEach, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { events } from "../schema/index.js";
import { eventChannelColumns, eventHeadColumns } from "./event-columns.js";
import { slackEventChannel } from "./thread-access.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("names the same Slack channel from the trimmed payload as from the whole row", async () => {
  api = await bootTestApi();
  const big = "x".repeat(20_000);
  const payloads: Array<[string, Record<string, unknown>, Record<string, string>]> = [
    ["refs", { text: big }, { channel: "CREFS" }],
    ["string", { channel: "CSTRING", text: big }, {}],
    ["object", { channel: { id: "COBJECT", name: "general", purpose: big }, text: big }, {}],
    ["channel-id", { channel_id: "CID", text: big }, {}],
    ["item", { item: { channel: "CITEM", ts: "1.1", text: big }, text: big }, {}],
    ["none", { text: big }, {}],
  ];
  await api.providers.db.insert(events).values([
    ...payloads.map(([id, payload, refs]) => ({
      id, orgId: "local-org", service: "slack", eventKey: "slack.message", dedupeKey: id, refs, summary: id, payload, occurredAt: 1, receivedAt: 1,
    })),
    { id: "github", orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: "github", refs: {}, summary: "push",
      payload: { channel: "CNOTSLACK", text: big }, occurredAt: 1, receivedAt: 1 },
  ]);
  const ids = [...payloads.map(([id]) => id), "github"];
  const whole = new Map((await api.providers.db.select().from(events).where(inArray(events.id, ids))).map((row) => [row.id, row]));
  const trimmed = await api.providers.db.select(eventChannelColumns).from(events).where(inArray(events.id, ids));
  expect(trimmed).toHaveLength(ids.length);
  for (const row of trimmed) {
    expect(slackEventChannel(row)).toBe(slackEventChannel(whole.get(row.id)!));
    // The trimmed payload carries no other key.
    expect(JSON.stringify(row.payload ?? null).length).toBeLessThan(200);
  }
  expect(Object.fromEntries(trimmed.map((row) => [row.id, slackEventChannel(row) ?? null]))).toEqual({
    refs: "CREFS", string: "CSTRING", object: "COBJECT", "channel-id": "CID", item: "CITEM", none: null, github: null,
  });
  // The head columns leave the payload out.
  const [head] = await api.providers.db.select(eventHeadColumns).from(events).where(inArray(events.id, ["string"]));
  expect(head && "payload" in head).toBe(false);
});
