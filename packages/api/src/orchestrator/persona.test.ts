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
      const sections = ["## Capabilities", "## Delegation", "## Models", "## Memory"];
      const positions = sections.map((s) => persona.indexOf(s));
      expect(positions.every((p) => p >= 0), `${owner.type} persona has all sections`).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
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

  it("names the push boundary and the child_status check", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("no git or GitHub credentials");
    expect(persona).toContain("child_status");
  });

  it("keeps the owner-kind identity bodies distinct", () => {
    expect(orchestratorPersona({ type: "user", id: "u1" })).toContain("personal assistant");
    expect(orchestratorPersona({ type: "team", id: "t1" })).toContain("shared assistant for a team");
    expect(orchestratorPersona({ type: "org", id: "o1" })).toContain("chief of staff");
  });
});
