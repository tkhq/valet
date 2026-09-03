import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FilterOptionContext, StoredCredential } from "@valet/engine";
import { startFakeSlackApi, type FakeSlackApi } from "../../test/fake-slack-api.js";
import { slackFilterOptionResolversForApi } from "./filter-options.js";

let fake: FakeSlackApi;

beforeAll(async () => {
  fake = await startFakeSlackApi();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.setMembers([]);
  fake.setChannels([]);
});

function resolvers() {
  return slackFilterOptionResolversForApi(fake.baseUrl);
}

function ctx(over: Partial<FilterOptionContext> = {}): FilterOptionContext {
  const credential: StoredCredential = { type: "bot_token", accessToken: "xoxb-test" };
  return { orgId: "org1", deps: {}, credential, ...over };
}

describe("slack.users resolver", () => {
  it("maps users.list to FilterOption[] with a real-name label and handle hint", async () => {
    fake.setMembers([
      { id: "U1", name: "conner", real_name: "Conner Swann" },
      { id: "U2", name: "samehandle" },
    ]);
    const options = await resolvers()["slack.users"](ctx());
    expect(options).toEqual([
      { id: "U1", label: "Conner Swann", hint: "@conner" },
      { id: "U2", label: "samehandle" },
    ]);
  });

  it("filters bots and passes the query through", async () => {
    fake.setMembers([
      { id: "U1", name: "conner", real_name: "Conner Swann" },
      { id: "U2", name: "paul", real_name: "Paul" },
      { id: "B1", name: "botty", is_bot: true },
    ]);
    const options = await resolvers()["slack.users"](ctx({ q: "conner" }));
    expect(options).toEqual([{ id: "U1", label: "Conner Swann", hint: "@conner" }]);
  });

  it("returns [] for a null credential without calling Slack", async () => {
    const options = await resolvers()["slack.users"](ctx({ credential: null }));
    expect(options).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns [] for a credential with no access token", async () => {
    const options = await resolvers()["slack.users"](ctx({ credential: { type: "bot_token" } }));
    expect(options).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("empty query returns all members (no 20-item cap) sorted alphabetically", async () => {
    const members = Array.from({ length: 30 }, (_, i) => ({
      id: `U${i}`,
      name: `user-${String(i).padStart(2, "0")}`,
      real_name: `User ${String(i).padStart(2, "0")}`,
    }));
    // Shuffle so the raw order is not alphabetical.
    fake.setMembers([...members].reverse());
    const options = await resolvers()["slack.users"](ctx());
    expect(options).toHaveLength(30);
    // Verify alphabetical sort by name (hint carries the handle).
    const names = options.map((o) => o.hint ?? `@${o.label}`);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("filtered query caps at 20 results", async () => {
    // All 30 members match the query "user".
    const members = Array.from({ length: 30 }, (_, i) => ({
      id: `U${i}`,
      name: `user-${String(i).padStart(2, "0")}`,
      real_name: `User ${String(i).padStart(2, "0")}`,
    }));
    fake.setMembers(members);
    const options = await resolvers()["slack.users"](ctx({ q: "user" }));
    expect(options).toHaveLength(20);
  });
});

describe("slack.channels resolver", () => {
  it("maps users.conversations to FilterOption[] labeled #name", async () => {
    fake.setChannels([
      { id: "C1", name: "general" },
      { id: "C2", name: "random" },
    ]);
    const options = await resolvers()["slack.channels"](ctx());
    expect(options).toEqual([
      { id: "C1", label: "#general" },
      { id: "C2", label: "#random" },
    ]);
  });

  it("reads the bot's joined channels, never the workspace directory", async () => {
    fake.setChannels([{ id: "C1", name: "general" }]);
    await resolvers()["slack.channels"](ctx({ q: "gen" }));
    const methods = fake.calls.map((call) => call.method);
    expect(methods).toContain("users.conversations");
    expect(methods).not.toContain("conversations.list");
  });

  it("drops archived channels and honors the query", async () => {
    fake.setChannels([
      { id: "C1", name: "general" },
      { id: "C2", name: "dead", is_archived: true },
      { id: "C3", name: "general-eng" },
    ]);
    const options = await resolvers()["slack.channels"](ctx({ q: "general" }));
    expect(options).toEqual([
      { id: "C1", label: "#general" },
      { id: "C3", label: "#general-eng" },
    ]);
  });

  it("returns [] for a null credential without calling Slack", async () => {
    const options = await resolvers()["slack.channels"](ctx({ credential: null }));
    expect(options).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("empty query returns all channels sorted alphabetically", async () => {
    const channels = Array.from({ length: 30 }, (_, i) => ({
      id: `C${i}`,
      name: `channel-${String(i).padStart(2, "0")}`,
    }));
    // Shuffle so the raw order is not alphabetical.
    fake.setChannels([...channels].reverse());
    const options = await resolvers()["slack.channels"](ctx());
    expect(options).toHaveLength(30);
    // Verify alphabetical sort by channel name.
    const labels = options.map((o) => o.label);
    const sorted = [...labels].sort();
    expect(labels).toEqual(sorted);
  });

  // The old resolver stopped the scan at 20 matches and sorted only those, so
  // the rows it kept were whichever 20 Slack happened to page first. Seed the
  // channels in reverse so page order is the opposite of sorted order: the old
  // cap kept #channel-119..#channel-100, this one keeps the true first 100.
  it("caps the row count after sorting, not during the scan", async () => {
    const channels = Array.from({ length: 120 }, (_, i) => ({
      id: `C${i}`,
      name: `channel-${String(i).padStart(3, "0")}`,
    }));
    fake.setChannels([...channels].reverse());
    const options = await resolvers()["slack.channels"](ctx({ q: "channel" }));
    expect(options).toHaveLength(100);
    expect(options[0]).toEqual({ id: "C0", label: "#channel-000" });
    expect(options[99]).toEqual({ id: "C99", label: "#channel-099" });
  });

  it("propagates a Slack failure so the endpoint can report it", async () => {
    fake.setChannels([{ id: "C1", name: "general" }]);
    fake.failNext("users.conversations", "ratelimited");
    await expect(resolvers()["slack.channels"](ctx({ q: "gen" }))).rejects.toThrow(/users\.conversations/);
  });
});
