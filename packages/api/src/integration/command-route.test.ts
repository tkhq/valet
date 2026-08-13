/**
 * Integration tests for the slash-commands plan (Tasks 10 and 11) and the
 * skills-as-commands plan (Task 4).
 *
 * `GET /api/sessions/:id/commands`:
 *   1. A stored prompt skill (skills table, `invocation: "prompt"`) appears in
 *      the merged registry as `skill:<name>` with source "skill".
 *   2. With `orgs.bareSkillCommands = true`, the same skill also registers
 *      under its bare name.
 *
 * `command_result` REST round-trip:
 *   3. Submitting "/status" through the real stack produces a message with
 *      `command.name === "status"`, `command.ok === true`, and non-empty
 *      `content` (the TEXT is reachable on reload, not just during live WS).
 */
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { createSkill } from "../services/skills.js";
import { orgs, skills } from "../schema/index.js";
import type {
  CreateSessionResponse,
  ListCommandsResponse,
  ListMessagesResponse,
  SendPromptResponse,
} from "../wire/types.js";

/** The stub-auth identity `bootTestApi` seeds (see `_setup.ts`). */
const OWNER = { userId: "local-user", orgId: "local-org" };

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

async function getCommands(baseUrl: string, sessionId: string): Promise<ListCommandsResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/commands`, { headers: HEADERS });
  expect(res.status).toBe(200);
  return (await res.json()) as ListCommandsResponse;
}

describe("GET /api/sessions/:id/commands", () => {
  // Task 4: a stored prompt skill reaches a session through `sessionExtras`
  // and registers as `skill:<name>`.
  it("lists a stored prompt skill as skill:<name> with source 'skill'", async () => {
    api = await bootTestApi();
    await createSkill(api.providers.db, OWNER, {
      name: "standup",
      description: "Summarize today's standup",
      content: "Summarize $1",
      frontmatter: { invocation: "prompt", argHint: "<topic>" },
    });

    const sessionId = await createSession(api.baseUrl);
    const { commands } = await getCommands(api.baseUrl, sessionId);

    const prefixed = commands.find((cmd) => cmd.name === "skill:standup");
    expect(prefixed).toBeDefined();
    expect(prefixed?.source).toBe("skill");
    // bareSkillCommands defaults false — the bare name is not registered.
    expect(commands.some((cmd) => cmd.name === "standup")).toBe(false);
  });

  // Task 4: the org toggle registers the bare name in addition to skill:<name>.
  it("also lists the bare name when orgs.bareSkillCommands is true", async () => {
    api = await bootTestApi();
    await api.providers.db
      .update(orgs)
      .set({ bareSkillCommands: true })
      .where(eq(orgs.id, OWNER.orgId));
    await createSkill(api.providers.db, OWNER, {
      name: "standup",
      description: "Summarize today's standup",
      content: "Summarize $1",
      frontmatter: { invocation: "prompt", argHint: "<topic>" },
    });

    const sessionId = await createSession(api.baseUrl);
    const { commands } = await getCommands(api.baseUrl, sessionId);

    expect(commands.some((cmd) => cmd.name === "skill:standup" && cmd.source === "skill")).toBe(true);
    const bare = commands.find((cmd) => cmd.name === "standup");
    expect(bare).toBeDefined();
    expect(bare?.source).toBe("skill");
  });

  // Task 4 fix: an org-library prompt skill reaches a member's session through
  // `sessionExtras`, even though the member never owns the org row.
  it("lists an org-owned prompt skill as skill:<name> for a member's session", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(skills).values({
      id: "skill_orgstandup",
      orgId: OWNER.orgId,
      ownerType: "org",
      ownerId: OWNER.orgId,
      origin: "local",
      sourceId: null,
      name: "orgstandup",
      description: "Org-wide standup",
      content: "Summarize $1",
      frontmatter: { name: "orgstandup", description: "Org-wide standup", invocation: "prompt", argHint: "<topic>" },
      contentSha: "sha",
      upstreamPath: null,
      createdAt: now,
      updatedAt: now,
    });

    const sessionId = await createSession(api.baseUrl);
    const { commands } = await getCommands(api.baseUrl, sessionId);

    const prefixed = commands.find((cmd) => cmd.name === "skill:orgstandup");
    expect(prefixed).toBeDefined();
    expect(prefixed?.source).toBe("skill");
  });
});

describe("command_result REST round-trip (Task 11)", () => {
  it("a builtin command round-trips to REST", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    // Post the slash command as a regular prompt — the route detects the
    // leading slash and dispatches through session.prompt() → executeCommand().
    const postRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "/status" }),
    });
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as SendPromptResponse;
    expect(postBody.threadId).toBeTruthy();

    // Read the transcript via REST — this is the reload path. The
    // command_result entry must survive the entryToMessage conversion.
    const msgsRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      headers: HEADERS,
    });
    expect(msgsRes.status).toBe(200);
    const { messages } = (await msgsRes.json()) as ListMessagesResponse;

    const cmd = messages.find((m) => m.command?.name === "status");
    expect(cmd).toBeDefined();
    expect(cmd?.command?.ok).toBe(true);
    // The TEXT is reachable — not "(empty output)". This is the documented
    // shape-drift regression (CLAUDE.md "Tool-call persistence round trip").
    expect(cmd?.content.length).toBeGreaterThan(0);
    expect(cmd?.role).toBe("system");
  });
});
