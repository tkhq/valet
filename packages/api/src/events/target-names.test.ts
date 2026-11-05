import { describe, expect, it } from "vitest";
import { acceptAppearanceWrite, acceptTargetWrite, readScheduleTargetKind, readStoredTarget } from "./target-names.js";
import { isTeamAssistantRule } from "./team-slack-gate.js";

// Spec 2026-10-16 presence hub, Part H steps 2, 3, and 5.
describe("target names", () => {
  it("renames the old names on write and refuses a field sent twice", () => {
    expect(acceptTargetWrite({ kind: "orchestrator", orchestrator: "team", teamId: "t1", presence: { displayName: "Ops" } }))
      .toEqual({ ok: true, target: { kind: "assistant", assistant: "team", teamId: "t1", appearance: { displayName: "Ops" } } });
    expect(acceptTargetWrite({ kind: "workflow", workflowId: "wf", presence: { displayName: "Ops" } }))
      .toEqual({ ok: true, target: { kind: "workflow", workflowId: "wf", appearance: { displayName: "Ops" } } });
    expect(acceptTargetWrite({ kind: "assistant", presence: {}, appearance: {} })).toEqual({ ok: false, error: "Send appearance, not presence." });
    expect(acceptTargetWrite({ kind: "assistant", orchestrator: "user", assistant: "user" })).toEqual({ ok: false, error: "Send assistant, not orchestrator." });
    expect(acceptTargetWrite("bad")).toEqual({ ok: true, target: "bad" });
  });

  it("reads a stored row with either name, and the new name wins", () => {
    expect(readStoredTarget({ kind: "orchestrator", orchestrator: "org", presence: { displayName: "Old" } }))
      .toEqual({ kind: "assistant", assistant: "org", appearance: { displayName: "Old" } });
    expect(readStoredTarget({ kind: "assistant", presence: { displayName: "Old" }, appearance: { displayName: "New" } }))
      .toEqual({ kind: "assistant", appearance: { displayName: "New" } });
  });

  it("reads the identity of a patch body from either name", () => {
    expect(acceptAppearanceWrite({ presence: null })).toEqual({ ok: true, appearance: null });
    expect(acceptAppearanceWrite({ appearance: { displayName: "A" } })).toEqual({ ok: true, appearance: { displayName: "A" } });
    expect(acceptAppearanceWrite({ appearance: null, presence: null })).toEqual({ ok: false, error: "Send appearance, not presence." });
  });

  it("reads the old schedule target kind as assistant", () => {
    expect(readScheduleTargetKind("orchestrator")).toBe("assistant");
    expect(readScheduleTargetKind("assistant")).toBe("assistant");
    expect(readScheduleTargetKind("workflow")).toBe("workflow");
  });

  it("finds a team assistant rule with either scope field", () => {
    expect(isTeamAssistantRule(undefined, { kind: "orchestrator", orchestrator: "team" })).toBe(true);
    expect(isTeamAssistantRule(undefined, { kind: "assistant", assistant: "team" })).toBe(true);
    expect(isTeamAssistantRule("team", { kind: "orchestrator" })).toBe(true);
    expect(isTeamAssistantRule(undefined, { kind: "assistant", assistant: "user" })).toBe(false);
  });
});
