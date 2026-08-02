import { describe, expect, it } from "vitest";
import type { Message, SessionDetail } from "@valet/api/wire";
import { buildTranscript } from "./transcript";

const session: SessionDetail = {
  id: "sess_1",
  title: "Debug demo",
  workspace: "my-repo",
  status: "active",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  messageCount: 2,
  model: "anthropic/claude-haiku-4-5",
  profile: "full",
};

const messages: Message[] = [
  {
    id: "m_1",
    sessionId: "sess_1",
    threadId: "th_1",
    role: "user",
    content: "run the tests",
    parts: [{ kind: "text", text: "run the tests" }],
    createdAt: 1_700_000_000_000,
  },
  {
    id: "m_2",
    sessionId: "sess_1",
    threadId: "th_1",
    role: "assistant",
    content: "",
    parts: [
      { kind: "text", text: "Running." },
      {
        kind: "tool_call",
        callId: "call_1",
        toolName: "bash",
        status: "completed",
        args: { command: "pnpm test" },
        result: { text: "5 passed" },
      },
    ],
    createdAt: 1_700_000_001_000,
  },
  {
    id: "m_x",
    sessionId: "sess_1",
    threadId: "th_2",
    role: "user",
    content: "different thread",
    parts: [{ kind: "text", text: "different thread" }],
    createdAt: 1_700_000_500_000,
  },
];

describe("buildTranscript", () => {
  it("includes session/user/env metadata in the header", () => {
    const out = buildTranscript({
      session,
      threadId: "th_1",
      messages,
      agentStatus: "idle",
      conn: "open",
      sandbox: { state: "ready", epoch: 3 },
      user: { id: "usr_1", email: "conner@example.com" },
      org: { id: "org_1", name: "Acme" },
      now: "2026-08-01T00:00:00Z",
      env: { origin: "http://localhost:8080", userAgent: "TestUA/1.0" },
    });
    expect(out).toContain("session.id:      sess_1");
    expect(out).toContain("thread.id:       th_1");
    expect(out).toContain("user.id:         usr_1");
    expect(out).toContain("org.name:        Acme");
    expect(out).toContain("env.origin:      http://localhost:8080");
    expect(out).toContain("sandbox.state:   ready (epoch 3)");
  });

  it("filters to the active thread when threadId is set", () => {
    const out = buildTranscript({
      session,
      threadId: "th_1",
      messages,
      agentStatus: "idle",
      conn: "open",
    });
    expect(out).toContain("run the tests");
    expect(out).not.toContain("different thread");
  });

  it("includes raw tool-call args and result verbatim", () => {
    const out = buildTranscript({
      session,
      threadId: "th_1",
      messages,
      agentStatus: "idle",
      conn: "open",
    });
    expect(out).toContain("tool_call · bash · completed");
    expect(out).toContain('"command": "pnpm test"');
    expect(out).toContain('"text": "5 passed"');
  });

  it("includes a JSON appendix with the filtered messages", () => {
    const out = buildTranscript({
      session,
      threadId: "th_1",
      messages,
      agentStatus: "idle",
      conn: "open",
    });
    expect(out).toContain("## Raw JSON appendix");
    // The appendix parses back to the two messages in the active thread.
    const jsonMatch = out.match(/```json\n([\s\S]*?)\n```/g);
    expect(jsonMatch).toBeTruthy();
    const lastBlock = jsonMatch![jsonMatch!.length - 1].replace(/```json\n|\n```/g, "");
    const parsed = JSON.parse(lastBlock) as Message[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("m_1");
    expect(parsed[1].id).toBe("m_2");
  });

  it("handles unserializable values gracefully instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad: Message = {
      id: "m_bad",
      sessionId: "sess_1",
      threadId: "th_1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          callId: "call_bad",
          toolName: "reflect",
          status: "completed",
          args: cyclic,
          result: cyclic,
        },
      ],
      createdAt: 1_700_000_002_000,
    };
    const out = buildTranscript({
      session,
      threadId: "th_1",
      messages: [bad],
      agentStatus: "idle",
      conn: "open",
    });
    expect(out).toContain("<unserializable:");
  });
});
