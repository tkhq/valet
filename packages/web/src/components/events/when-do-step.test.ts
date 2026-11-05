import type { PluginSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { connectedServices } from "./when-do-step";

function plugin(name: string, connected: boolean, connect: "oauth" | "org" = "oauth"): PluginSummary {
  return { name, version: "1", actionCount: 0, services: [{ service: name, type: "oauth2", configKeys: [], connected, connect, actions: [] }] };
}

describe("connectedServices", () => {
  it("counts a service the reader or the organization connected, and is null while unknown", () => {
    expect(connectedServices(undefined)).toBeNull();
    const set = connectedServices([plugin("slack", false), plugin("github", false, "org"), plugin("linear", true), plugin("notion", true)]);
    expect([...(set ?? [])].sort()).toEqual(["github", "linear"]);
  });
});
