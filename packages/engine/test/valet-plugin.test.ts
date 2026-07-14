import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { validateValetPlugin, type ValetPlugin } from "../src/index.js";

function minimalPlugin(): ValetPlugin {
  return { name: "demo", version: "1.0.0" };
}

describe("validateValetPlugin", () => {
  it("accepts a minimal manifest", () => {
    const res = validateValetPlugin(minimalPlugin());
    expect(res.ok).toBe(true);
  });

  it("accepts a full manifest with actions, triggers, skills, roles, credentials", () => {
    const plugin: ValetPlugin = {
      name: "demo",
      version: "1.0.0",
      description: "demo plugin",
      actions: [
        {
          service: "demo",
          actions: [
            {
              id: "demo.ping",
              name: "Ping",
              description: "ping",
              riskLevel: "low",
              parameters: Type.Object({}),
              execute: async () => ({ success: true }),
            },
          ],
        },
      ],
      triggers: [
        {
          id: "demo.event",
          service: "demo",
          description: "an event",
          verify: () => null,
          toSignal: () => ({
            signal: { kind: "signal", signalType: "demo.event", body: "{}" },
            dispatchId: "d-1",
          }),
        },
      ],
      skills: [{ name: "demo-skill", content: "# Demo" }],
      roles: [{ name: "demo-role", content: "You are demo." }],
      credentials: [{ type: "api_key", configKeys: ["accessToken"] }],
    };
    const res = validateValetPlugin(plugin);
    expect(res.ok).toBe(true);
  });

  it("rejects non-objects and missing name/version with paths", () => {
    expect(validateValetPlugin(null).ok).toBe(false);
    expect(validateValetPlugin("nope").ok).toBe(false);
    const res = validateValetPlugin({ version: "1.0.0" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.path === "name")).toBe(true);
  });

  it("rejects invalid plugin names (must be kebab, start with a letter)", () => {
    for (const bad of ["Demo", "1demo", "demo_x", "demo x", ""]) {
      const res = validateValetPlugin({ name: bad, version: "1" });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects an action missing execute, with an indexed path", () => {
    const res = validateValetPlugin({
      name: "demo",
      version: "1",
      actions: [
        {
          service: "demo",
          actions: [
            { id: "demo.x", name: "X", description: "x", riskLevel: "low", parameters: Type.Object({}) },
          ],
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.path).toBe("actions[0].actions[0].execute");
  });

  it("rejects a bad riskLevel and a bad credential type", () => {
    const badRisk = validateValetPlugin({
      name: "demo",
      version: "1",
      actions: [
        {
          service: "demo",
          actions: [
            { id: "demo.x", name: "X", description: "x", riskLevel: "extreme", parameters: Type.Object({}), execute: async () => ({ success: true }) },
          ],
        },
      ],
    });
    expect(badRisk.ok).toBe(false);
    const badCred = validateValetPlugin({ name: "demo", version: "1", credentials: [{ type: "password", configKeys: [] }] });
    expect(badCred.ok).toBe(false);
  });

  it("rejects a trigger whose verify/toSignal are not functions", () => {
    const res = validateValetPlugin({
      name: "demo",
      version: "1",
      triggers: [{ id: "demo.e", service: "demo", description: "e", verify: "nope", toSignal: {} }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paths = res.issues.map((i) => i.path);
      expect(paths).toContain("triggers[0].verify");
      expect(paths).toContain("triggers[0].toSignal");
    }
  });

  it("collects multiple issues rather than stopping at the first", () => {
    const res = validateValetPlugin({ name: "Bad Name", version: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThanOrEqual(2);
  });
});
