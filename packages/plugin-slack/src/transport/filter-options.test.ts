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
});

describe("slack.channels resolver", () => {
  it("maps conversations.list to FilterOption[] labeled #name", async () => {
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
});
