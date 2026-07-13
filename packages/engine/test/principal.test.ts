import { describe, it, expect } from "vitest";
import {
  serializePrincipal,
  parsePrincipal,
  orchestratorSessionId,
  parseOrchestratorSessionId,
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

  it("orchestratorSessionId formats orchestrator:type:id", () => {
    expect(orchestratorSessionId({ type: "user", id: "u1" })).toBe("orchestrator:user:u1");
    expect(orchestratorSessionId({ type: "org", id: "o1" })).toBe("orchestrator:org:o1");
  });

  it("parseOrchestratorSessionId round-trips every orchestrator session id", () => {
    const principals: Principal[] = [
      { type: "user", id: "u1" },
      { type: "team", id: "team-42" },
      { type: "org", id: "org_abc" },
    ];
    for (const p of principals) {
      expect(parseOrchestratorSessionId(orchestratorSessionId(p))).toEqual(p);
    }
  });

  it("parseOrchestratorSessionId rejects junk", () => {
    expect(parseOrchestratorSessionId("")).toBeNull();
    expect(parseOrchestratorSessionId("orchestrator")).toBeNull();
    expect(parseOrchestratorSessionId("orchestrator:user")).toBeNull();
    expect(parseOrchestratorSessionId("not-orchestrator:user:u1")).toBeNull();
    expect(parseOrchestratorSessionId("orchestrator:bogus:u1")).toBeNull();
    expect(parseOrchestratorSessionId("orchestrator:user:")).toBeNull();
    expect(parseOrchestratorSessionId("th-abc123")).toBeNull();
  });

  it("parseOrchestratorSessionId is not fooled by an ordinary session id", () => {
    expect(parseOrchestratorSessionId("web:default")).toBeNull();
  });
});
