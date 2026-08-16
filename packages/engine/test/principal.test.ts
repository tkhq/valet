import { describe, it, expect } from "vitest";
import {
  serializePrincipal,
  parsePrincipal,
  assistantSessionId,
  parseAssistantSessionId,
  type Principal,
} from "../src/index.js";

describe("principal helpers", () => {
  it("serializePrincipal formats type:id", () => {
    expect(serializePrincipal({ type: "user", id: "u1" })).toBe("user:u1");
    expect(serializePrincipal({ type: "team", id: "t1" })).toBe("team:t1");
    expect(serializePrincipal({ type: "org", id: "o1" })).toBe("org:o1");
  });

  it("parsePrincipal round-trips every serialized principal", () => {
    const principals: Principal[] = [
      { type: "user", id: "u1" },
      { type: "team", id: "team-42" },
      { type: "org", id: "org_abc" },
    ];
    for (const p of principals) {
      expect(parsePrincipal(serializePrincipal(p))).toEqual(p);
    }
  });

  it("parsePrincipal rejects junk", () => {
    expect(parsePrincipal("")).toBeNull();
    expect(parsePrincipal("nocolon")).toBeNull();
    expect(parsePrincipal(":noType")).toBeNull();
    expect(parsePrincipal("user:")).toBeNull();
    expect(parsePrincipal("bogus:u1")).toBeNull();
  });

  // The address is the ASSISTANT's own id, not its owner's. A principal
  // owns any number of assistants, so an owner cannot identify a session.
  it("assistantSessionId formats assistant:{assistantId}", () => {
    expect(assistantSessionId("asst_1")).toBe("assistant:asst_1");
  });

  it("parseAssistantSessionId round-trips every assistant session id", () => {
    for (const assistantId of ["asst_1", "asst_a-b_c", "asst_00000000-0000-4000-8000-000000000000"]) {
      expect(parseAssistantSessionId(assistantSessionId(assistantId))).toBe(assistantId);
    }
  });

  it("assistants owned by one principal get different addresses", () => {
    expect(assistantSessionId("asst_1")).not.toBe(assistantSessionId("asst_2"));
  });

  it("parseAssistantSessionId rejects junk", () => {
    expect(parseAssistantSessionId("")).toBeNull();
    expect(parseAssistantSessionId("assistant")).toBeNull();
    expect(parseAssistantSessionId("assistant:")).toBeNull();
    expect(parseAssistantSessionId("not-assistant:asst_1")).toBeNull();
    expect(parseAssistantSessionId("th-abc123")).toBeNull();
  });

  it("parseAssistantSessionId is not fooled by an ordinary session id", () => {
    expect(parseAssistantSessionId("web:default")).toBeNull();
    expect(parseAssistantSessionId("wf:run_1:node_1")).toBeNull();
  });
});
