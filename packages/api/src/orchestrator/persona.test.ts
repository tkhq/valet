import { describe, expect, it } from "vitest";
import type { Principal } from "@valet/engine";
import { orchestratorPersona } from "./persona.js";

/** Collapse the template literals' hard line wraps so phrase assertions
 * survive a reflow. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

const OWNERS: Principal[] = [
  { type: "user", id: "u1" },
  { type: "team", id: "t1" },
  { type: "org", id: "o1" },
];

describe("orchestratorPersona", () => {
  it("carries the shared rule sections, in order, for every owner kind", () => {
    for (const owner of OWNERS) {
      const persona = orchestratorPersona(owner);
      const sections = [
        "## Capabilities",
        "## Decision flow",
        "## Delegation",
        "## Errors",
        "## Models",
        "## Memory",
      ];
      const positions = sections.map((s) => persona.indexOf(s));
      expect(positions.every((p) => p >= 0), `${owner.type} persona has all sections`).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  it("names the team when a display name is given, never the raw id", () => {
    const persona = flat(orchestratorPersona({ type: "team", id: "team_c7268244" }, "Platform"));
    expect(persona).toContain("Platform");
    expect(persona).not.toContain("team_c7268244");
  });

  it("falls back to a neutral phrase without a name, still never the raw id", () => {
    const persona = flat(orchestratorPersona({ type: "team", id: "team_c7268244" }));
    expect(persona).not.toContain("team_c7268244");
  });

  it("tells the model the first and final messages auto-post; the rest stays off the channel", () => {
    const persona = flat(orchestratorPersona({ type: "team", id: "t1" }, "Platform"));
    expect(persona).toContain("two of your messages post to the origin thread automatically");
    expect(persona).toContain("Every message between them stays off the");
    expect(persona).toContain("End your turn with the result.");
    expect(persona).toContain("use reply_to_origin");
  });

  it("tells the model to check list_tools before denying a capability", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("call list_tools");
    expect(persona).toContain("never present a missing connection as a missing capability");
  });

  it("biases code edits toward child sessions, not the orchestrator sandbox", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("Do not make repo edits in your own sandbox");
    expect(persona).toContain("Brief the child completely.");
    expect(persona).toContain("switch_model");
  });

  it("requires switch_model before architecting or coding", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("Before architecting, designing, debugging, reviewing, or a code change");
    expect(persona).toContain("call switch_model to a stronger reasoning-model id");
    expect(persona).toContain("do not hardcode a vendor family");
    expect(persona).toContain("set the task tool's `model`");
    expect(persona).toContain("switch_model (or set the child's model) first");
    expect(persona).toContain("Re-evaluate after you have read the code or a tool result");
    expect(persona).toContain("switch_model mid-task after that evaluation");
    expect(persona).toContain("Do not finish a hard task on a cheap model just because you started there");
    expect(persona).not.toMatch(/Haiku|Sonnet|Opus|Codex/);
  });

  it("names the push boundary and the child_status check", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("no git or GitHub credentials");
    expect(persona).toContain("child_status");
  });

  it("ports the v1 decision flow and persistence brief onto v2 tools", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("## Decision flow");
    expect(persona).toContain("Call mem_search");
    expect(persona).toContain("Wait for child.settled");
    expect(persona).toContain("A turn that does work must contain a tool call");
    expect(persona).toContain("the check it ran and pass/fail");
    expect(persona).toContain("the branch is pushed");
    expect(persona).toContain("do not spawn child sessions");
    expect(persona).toContain("The spawned `branch` is the base");
    expect(persona).toContain("## Errors");
    expect(persona).toContain("mem_search first");
  });

  it("keeps the owner-kind identity bodies distinct", () => {
    expect(orchestratorPersona({ type: "user", id: "u1" })).toContain("personal assistant");
    expect(orchestratorPersona({ type: "team", id: "t1" })).toContain("shared assistant for a team");
    expect(orchestratorPersona({ type: "org", id: "o1" })).toContain("chief of staff");
  });
  // Asked for a 1Password value, the orchestrator ran `op read`, got zero
  // bytes, and told the user their vault and item names were wrong. The rule
  // it needed named a tool it does not have and never named 1Password, so
  // nothing matched the words the person used.
  it("routes a credential request to a child instead of a vendor CLI", () => {
    for (const owner of OWNERS) {
      const persona = orchestratorPersona(owner);
      // Keyed to what a person writes, not to the tool that would serve it.
      expect(persona).toContain("1Password");
      expect(persona).toContain("op://");
      // The failure mode, named so a zero-byte result is not read as a wrong vault.
      expect(persona).toContain("Do not run a secrets command");
      expect(persona).toContain("Do not tell the user to look the secret up themselves");
      expect(persona).toContain("valet-secrets");
      // The section has to be reachable from the router, not only defined.
      expect(persona.indexOf("## Secrets")).toBeGreaterThan(-1);
      expect(persona).toContain("never ask anyone to paste one");
    }
  });
});
