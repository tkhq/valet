import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  isPlaybook,
  loadSkillFromMarkdown,
  playbookPlanItems,
  playbookSeedNote,
  readPlaybookSteps,
  readThreadPlan,
  VirtualSandboxProvider,
  type CreateSessionOptions,
  type SkillSource,
  type ThreadPlanItem,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const BUG_FIX = `---
name: bug-fix
description: Fix a reported bug.
metadata:
  kind: playbook
---

Use this playbook for one reported bug.

## Steps

1. Reproduce the bug
2. Write a failing test
3. Fix the cause
4. Run the suite

## Notes

- Not a step
`;

describe("readPlaybookSteps", () => {
  it("reads numbered and bulleted items under the Steps heading, up to the next heading", () => {
    expect(readPlaybookSteps(loadSkillFromMarkdown(BUG_FIX, "repo").content)).toEqual({
      kind: "steps",
      steps: ["Reproduce the bug", "Write a failing test", "Fix the cause", "Run the suite"],
    });
    expect(readPlaybookSteps("### Steps\n\n- One\n* Two\n2) Three\n")).toEqual({ kind: "steps", steps: ["One", "Two", "Three"] });
  });

  it("skips list items in fenced code", () => {
    expect(readPlaybookSteps("## Steps\n\n1. Run it\n```\n- not a step\n```\n2. Check it\n")).toEqual({ kind: "steps", steps: ["Run it", "Check it"] });
  });

  it.each([
    ["no Steps heading", "1. Orphan step\n", /no list items/],
    ["an empty Steps section", "## Steps\n\nJust prose.\n## Next\n- x\n", /no list items/],
    ["21 steps", `## Steps\n${Array.from({ length: 21 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n")}\n`, /21 steps/],
    ["a step over 200 characters", `## Steps\n1. ${"x".repeat(201)}\n`, /Step 1 is longer than 200/],
  ])("refuses a playbook with %s", (_label, body, reason) => {
    const result = readPlaybookSteps(body);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toMatch(reason);
  });

  it("marks a playbook through the spec metadata map only", () => {
    const skill = loadSkillFromMarkdown(BUG_FIX, "repo");
    expect(isPlaybook(skill)).toBe(true);
    expect(isPlaybook({ metadata: { kind: "reference" } })).toBe(false);
    expect(isPlaybook({})).toBe(false);
  });

  it("starts the first step and leaves the rest pending", () => {
    expect(playbookPlanItems(["A", "B"])).toEqual([{ text: "A", status: "in_progress" }, { text: "B", status: "pending" }]);
  });

  it("tells the model what seeding did", () => {
    expect(playbookSeedNote("bug-fix", { kind: "seeded", steps: ["A", "B"] })).toContain("now holds the 2 steps");
    expect(playbookSeedNote("bug-fix", { kind: "kept", steps: ["A"] })).toContain("already has an open plan");
    expect(playbookSeedNote("bug-fix", { kind: "invalid", reason: "It has no list items." })).toContain("It has no list items.");
  });
});

/** Plan items without their stored ids. */
function steps(items: ThreadPlanItem[] | undefined) {
  return items?.map(({ text, status }) => ({ text, status }));
}

function setup(provider: string, skills: SkillSource[]) {
  const faux = registerFauxProvider({ provider });
  cleanups.push(() => faux.unregister());
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const options: CreateSessionOptions = {
    userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), skills,
  };
  return { faux, providers, options };
}

describe("playbook plan seeding", () => {
  it("seeds the plan when a playbook is invoked, before its turn starts", async () => {
    const { faux, providers, options } = setup("playbook-seed", [loadSkillFromMarkdown(BUG_FIX, "repo")]);
    const prompts: string[] = [];
    faux.setResponses([(context: Context) => { prompts.push(getCurrentSystemPrompt(context.messages)); return fauxAssistantMessage("On it."); }]);
    const session = await new Engine({ providers }).createSession(options);
    const receipt = await session.thread().skill("bug-fix");
    expect((await session.thread().awaitResult(receipt.queueItemId)).outcome).toBe("completed");

    const stored = await providers.store.getThread(session.id, session.thread().id);
    expect(steps(readThreadPlan(stored?.metadata)?.items)).toEqual([
      { text: "Reproduce the bug", status: "in_progress" },
      { text: "Write a failing test", status: "pending" },
      { text: "Fix the cause", status: "pending" },
      { text: "Run the suite", status: "pending" },
    ]);
    // The model saw the seeded plan on the first turn, with no update_plan call.
    expect(prompts[0]).toContain("[>] Reproduce the bug");
  });

  it("keeps an open plan and replaces a finished one", async () => {
    const { providers, options } = setup("playbook-keep", [loadSkillFromMarkdown(BUG_FIX, "repo")]);
    const session = await new Engine({ providers }).createSession(options);
    const thread = session.thread();
    const skill = loadSkillFromMarkdown(BUG_FIX, "repo");

    await thread.setPlan([{ text: "My own step", status: "in_progress" }]);
    expect(await thread.seedPlaybookPlan(skill)).toEqual({ kind: "kept", steps: expect.any(Array) });
    expect(steps(readThreadPlan(thread.toThreadData().metadata)?.items)).toEqual([{ text: "My own step", status: "in_progress" }]);

    await thread.setPlan([{ text: "My own step", status: "done" }]);
    expect((await thread.seedPlaybookPlan(skill)).kind).toBe("seeded");
    expect(steps(readThreadPlan(thread.toThreadData().metadata)?.items)?.[0]).toEqual({ text: "Reproduce the bug", status: "in_progress" });
    expect(readThreadPlan(thread.toThreadData().metadata)?.title).toBe("bug-fix");
  });

  it("does not seed a plan from an invalid playbook", async () => {
    const broken = loadSkillFromMarkdown("---\nname: broken\ndescription: No steps.\nmetadata:\n  kind: playbook\n---\nJust prose.\n", "repo");
    const { providers, options } = setup("playbook-invalid", [broken]);
    const session = await new Engine({ providers }).createSession(options);
    expect((await session.thread().seedPlaybookPlan(broken)).kind).toBe("invalid");
    expect(readThreadPlan(session.thread().toThreadData().metadata)).toBeUndefined();
  });
});
