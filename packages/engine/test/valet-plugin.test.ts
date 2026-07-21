import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { validateValetPlugin, type ValetPlugin, type NormalizedEvent, type EventCatalogEntry } from "../src/index.js";

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
          toEvent: () => ({
            key: "demo.event.fired",
            dedupeKey: "d-1",
            occurredAt: new Date(0).toISOString(),
            refs: {},
            summary: "Demo event fired",
            payload: {},
          }),
          catalog: [{ key: "demo.event.fired", description: "Demo event", filters: [] }],
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

  it("rejects a trigger whose verify/toEvent are not functions", () => {
    const res = validateValetPlugin({
      name: "demo",
      version: "1",
      triggers: [{ id: "demo.e", service: "demo", description: "e", verify: "nope", toEvent: {}, catalog: [] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paths = res.issues.map((i) => i.path);
      expect(paths).toContain("triggers[0].verify");
      expect(paths).toContain("triggers[0].toEvent");
    }
  });

  it("collects multiple issues rather than stopping at the first", () => {
    const res = validateValetPlugin({ name: "Bad Name", version: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateValetPlugin transports", () => {
  it("accepts a plugin without transports (unchanged behavior)", () => {
    const res = validateValetPlugin(minimalPlugin());
    expect(res.ok).toBe(true);
  });

  it("accepts a valid transports array", () => {
    const res = validateValetPlugin({
      ...minimalPlugin(),
      transports: [{ channelType: "telegram", create: () => ({}) }],
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-array transports", () => {
    const res = validateValetPlugin({ ...minimalPlugin(), transports: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "transports")).toBe(true);
    }
  });

  it("rejects a factory missing channelType or create", () => {
    const res = validateValetPlugin({
      ...minimalPlugin(),
      transports: [{ channelType: "" }, { channelType: "x", create: "not-fn" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "transports[0].channelType")).toBe(true);
      expect(res.issues.some((i) => i.path === "transports[1].create")).toBe(true);
    }
  });
});

describe("TriggerDef toEvent/catalog validation", () => {
  const validTrigger = {
    id: "github.pull_request",
    service: "github",
    description: "PRs",
    verify: () => null,
    toEvent: (): NormalizedEvent => ({
      key: "github.pull_request.opened",
      dedupeKey: "d1",
      occurredAt: new Date(0).toISOString(),
      refs: {},
      summary: "PR opened",
      payload: {},
    }),
    catalog: [
      {
        key: "github.pull_request.opened",
        description: "A pull request was opened",
        filters: [{ field: "repo", path: "repository.full_name", description: "Repository" }],
      },
    ] satisfies EventCatalogEntry[],
  };

  it("accepts a trigger with toEvent and catalog", () => {
    const res = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [validTrigger] });
    expect(res.ok).toBe(true);
  });

  it("rejects a trigger missing toEvent", () => {
    const { toEvent: _omit, ...rest } = validTrigger;
    const res = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [rest] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("toEvent"))).toBe(true);
    }
  });

  it("rejects a catalog entry without a key", () => {
    const bad = { ...validTrigger, catalog: [{ description: "x", filters: [] }] };
    const res = validateValetPlugin({ name: "gh", version: "1.0.0", triggers: [bad] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("catalog"))).toBe(true);
    }
  });
});
