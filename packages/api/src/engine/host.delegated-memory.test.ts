/**
 * Child sessions and workflow steps get the memory snapshot an assistant
 * gets, Principles section included, built from the scope their memory
 * tools read (brain spec, "Principles everywhere"). `Session.options` is
 * the engine's public seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { createTeam } from "../services/teams.js";
import { writeFile, type MemoryScope } from "../services/memory.js";

const USER = "local-user";
const ORG = "local-org";
const own: MemoryScope = { owner: { type: "user", id: USER }, actorUserId: USER };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function snapshotOf(session: Session): string | undefined {
  return session.options.systemContext?.find((fragment) => fragment.name === "memory-snapshot")?.content;
}

function toolNames(session: Session): string[] {
  return (session.options.tools ?? []).map((tool) => tool.name);
}

describe("delegated sessions get the memory snapshot", () => {
  it("gives a personal child the Principles section, pinned memory, and read-only memory tools", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db } = api.providers;
    await writeFile(db, own, { path: "principles/prove-it-works.md", content: "# Prove it works\n" });
    await writeFile(db, own, { path: "preferences/style.md", content: "# Style\n\nShort answers.\n", pinned: true });
    const assistant = await seedWorkspaceAssistant(db, ORG, { type: "user", id: USER });

    const session = await api.providers.engineHost.childSessionFor("child:mem", {
      parentSessionId: assistant.sessionId, parentThreadId: "thread:parent",
      actorUserId: USER, orgId: ORG, owner: { type: "user", id: USER }, workspace: "/tmp",
    });

    const snapshot = snapshotOf(session);
    expect(snapshot).toContain("## Principles");
    expect(snapshot).toContain("learn-from-the-org (built in)");
    expect(snapshot).toContain("- principles/prove-it-works.md — Prove it works");
    expect(snapshot).toContain("Short answers.");
    // It cannot write memory, so the base principle does not tell it to.
    expect(snapshot).not.toContain("mem_write");
    expect(snapshot).toContain("cannot write memory");
    expect(toolNames(session)).toEqual(expect.arrayContaining(["mem_read", "mem_search"]));
    expect(toolNames(session)).not.toContain("mem_write");
    expect(session.options.toolConfig).toMatchObject({ apiBaseUrl: expect.any(String), internalToken: expect.any(String) });
  });

  it("gives a team child the team's shared principles", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db } = api.providers;
    const team = await createTeam(db, { orgId: ORG, name: "Release team", creatorUserId: USER });
    await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: USER }, { path: "principles/ship-small.md", content: "# Ship small\n" });
    await writeFile(db, own, { path: "principles/personal-only.md", content: "# Personal only\n" });
    const assistant = await seedWorkspaceAssistant(db, ORG, { type: "team", id: team.id });

    const session = await api.providers.engineHost.childSessionFor("child:team-mem", {
      parentSessionId: assistant.sessionId, parentThreadId: "thread:parent",
      actorUserId: USER, orgId: ORG, owner: { type: "team", id: team.id }, workspace: "/tmp",
    });

    const snapshot = snapshotOf(session);
    expect(snapshot).toContain(`team:${team.id}/principles/ship-small.md`);
    // The team child acts for the team, so the member's own principles stay out.
    expect(snapshot).not.toContain("personal-only");
  });

  it("lets a team child read the team principle its snapshot lists", async () => {
    // A child has no app session row, so the memory route resolves it
    // through the session that spawned it.
    api = await bootTestApi({ plugins: [] });
    const { db } = api.providers;
    const team = await createTeam(db, { orgId: ORG, name: "Release team", creatorUserId: USER });
    await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: USER }, { path: "principles/ship-small.md", content: "# Ship small\n\nShip in small PRs.\n" });
    // The real team assistant, with its app session row, spawns the child.
    const assistant = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
    const session = await api.providers.engineHost.childSessionFor("child:team-read", {
      parentSessionId: assistant.sessionId, parentThreadId: "thread:parent",
      actorUserId: USER, orgId: ORG, owner: { type: "team", id: team.id }, workspace: "/tmp",
    });
    const read = (session.options.tools ?? []).find((tool) => tool.name === "mem_read");
    if (!read) throw new Error("mem_read missing");
    const ctx: Parameters<typeof read.execute>[1] = {
      sessionId: session.id, threadId: "thread:child", userId: USER, orgId: ORG, owner: { type: "team", id: team.id },
      config: session.options.toolConfig,
    } satisfies Partial<Parameters<typeof read.execute>[1]> as Parameters<typeof read.execute>[1];
    // The snapshot lists the principle under its team prefix, so the model reads that path.
    expect(snapshotOf(session)).toContain(`team:${team.id}/principles/ship-small.md`);
    const result = await read.execute({ path: `team:${team.id}/principles/ship-small.md` }, ctx);
    expect(result.text).toContain("Ship in small PRs.");
  });

  it("gives a workflow step the snapshot and read-only memory tools", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db } = api.providers;
    await writeFile(db, own, { path: "principles/prove-it-works.md", content: "# Prove it works\n" });

    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER, orgId: ORG, owner: { type: "user", id: USER }, workspace: "/tmp",
    });

    expect(snapshotOf(session)).toContain("- principles/prove-it-works.md");
    expect(toolNames(session)).toEqual(expect.arrayContaining(["artifact_publish", "mem_read", "mem_search"]));
    expect(toolNames(session)).not.toContain("mem_write");
  });

  it("gives a team workflow step no memory when its audience cannot be resolved", async () => {
    api = await bootTestApi({ plugins: [] });
    const { db } = api.providers;
    const team = await createTeam(db, { orgId: ORG, name: "Ops", creatorUserId: USER });
    await writeFile(db, { owner: { type: "team", id: team.id }, actorUserId: USER }, { path: "principles/ship-small.md", content: "# Ship small\n" });

    // No run row: the step's memory audience is unknown, so it must not
    // widen to the whole team.
    const session = await api.providers.engineHost.workflowSessionFor("wf:missing-run:node1", {
      actorUserId: USER, orgId: ORG, owner: { type: "team", id: team.id }, workspace: "/tmp",
    });

    expect(snapshotOf(session)).toBeUndefined();
    expect(toolNames(session)).not.toContain("mem_read");
  });
});
