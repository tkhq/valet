import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { formatSessionDetail, formatSessionsTable, runSessions, type SessionsClient } from "./sessions.js";
import type { CreateSessionRequest, GetSessionResponse, SessionSummary } from "../../wire/types.js";

const SUMMARY: SessionSummary = {
  id: "sess_1",
  workspace: "/work/one",
  status: "active",
  runState: "idle",
  title: "First",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
};

const DETAIL: GetSessionResponse = {
  ...SUMMARY,
  messageCount: 3,
  profile: "headless",
  model: "claude",
};

/** A stub `SessionsClient` recording the last createSession body. */
function stubClient(overrides: Partial<SessionsClient> = {}): {
  client: SessionsClient;
  created: CreateSessionRequest[];
} {
  const created: CreateSessionRequest[] = [];
  const client: SessionsClient = {
    listSessions: () => Promise.resolve({ sessions: [SUMMARY] }),
    createSession: (body) => {
      created.push(body);
      return Promise.resolve(DETAIL);
    },
    getSession: () => Promise.resolve(DETAIL),
    ...overrides,
  };
  return { client, created };
}

let outSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("runSessions list", () => {
  it("--json prints a { sessions } object and returns OK", async () => {
    const { client } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["list", "--json"]));
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as { sessions: SessionSummary[] };
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].id).toBe("sess_1");
  });

  it("human mode prints a table with the id", async () => {
    const { client } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["list"]));
    expect(code).toBe(ExitCode.OK);
    expect(stdout()).toContain("sess_1");
    expect(stdout()).toContain("active");
  });

  it("prints a friendly line when there are no sessions", async () => {
    const { client } = stubClient({ listSessions: () => Promise.resolve({ sessions: [] }) });
    const code = await runSessions(client, parseGlobalFlags(["list"]));
    expect(code).toBe(ExitCode.OK);
    expect(stdout()).toContain("no sessions");
  });
});

describe("runSessions new", () => {
  it("rejects a missing --workspace with Usage and does not create", async () => {
    const { client, created } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["new"]));
    expect(code).toBe(ExitCode.Usage);
    expect(created).toHaveLength(0);
    expect(stderr()).toContain("--workspace");
  });

  it("rejects a relative --workspace with Usage", async () => {
    const { client, created } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["new", "--workspace", "rel/path"]));
    expect(code).toBe(ExitCode.Usage);
    expect(created).toHaveLength(0);
    expect(stderr()).toContain("absolute");
  });

  it("creates with an absolute workspace + title and prints the new id", async () => {
    const { client, created } = stubClient();
    const code = await runSessions(
      client,
      parseGlobalFlags(["new", "--workspace", "/abs/ws", "--title", "Hi"]),
    );
    expect(code).toBe(ExitCode.OK);
    expect(created).toEqual([{ workspace: "/abs/ws", title: "Hi" }]);
    expect(stdout().trim()).toBe("sess_1");
  });

  it("rejects an invalid --profile with Usage", async () => {
    const { client, created } = stubClient();
    const code = await runSessions(
      client,
      parseGlobalFlags(["new", "--workspace", "/abs/ws", "--profile", "bogus"]),
    );
    expect(code).toBe(ExitCode.Usage);
    expect(created).toHaveLength(0);
  });

  it("--json prints the created detail", async () => {
    const { client } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["new", "--workspace", "/abs/ws", "--json"]));
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as GetSessionResponse;
    expect(parsed.id).toBe("sess_1");
    expect(parsed.messageCount).toBe(3);
  });
});

describe("runSessions show", () => {
  it("rejects a missing id with Usage", async () => {
    const { client } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["show"]));
    expect(code).toBe(ExitCode.Usage);
  });

  it("prints detail for a given id", async () => {
    let asked: string | undefined;
    const { client } = stubClient({
      getSession: (id) => {
        asked = id;
        return Promise.resolve(DETAIL);
      },
    });
    const code = await runSessions(client, parseGlobalFlags(["show", "sess_1"]));
    expect(code).toBe(ExitCode.OK);
    expect(asked).toBe("sess_1");
    expect(stdout()).toContain("sess_1");
  });
});

describe("runSessions unknown subcommand", () => {
  it("returns Usage", async () => {
    const { client } = stubClient();
    const code = await runSessions(client, parseGlobalFlags(["frobnicate"]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("usage: valet sessions");
  });
});

describe("pure formatters", () => {
  it("formatSessionsTable aligns and includes headers", () => {
    const table = formatSessionsTable([SUMMARY]);
    expect(table).toContain("ID");
    expect(table).toContain("WORKSPACE");
    expect(table).toContain("/work/one");
  });

  it("formatSessionDetail renders key rows", () => {
    const text = formatSessionDetail(DETAIL);
    expect(text).toContain("messages:");
    expect(text).toContain("3");
    expect(text).toContain("headless");
  });
});
