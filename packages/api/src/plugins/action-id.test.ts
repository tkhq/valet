import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { actionInScope, canonicalizeToolScope } from "@valet/shared";
import { actionIdResolver, buildToolIndex, canonicalActionIdFor } from "./action-id.js";
import { assemblePlugins } from "./assemble.js";
import { bundledPlugins } from "./registry.gen.js";
import { canonicalizeDefinitionScopes, entryService, workflowStepToolScope } from "../workflows/tool-scope.js";
import { sameWorkflowSteps } from "../workflows/definition-version.js";

function makeAction(id: string): PluginAction {
  return { id, name: id, description: id, riskLevel: "low", parameters: Type.Object({}), execute: async () => ({ success: true }) };
}

type PluginMap = Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;

function pluginMap(...plugins: ActionPlugin[]): PluginMap {
  return new Map(plugins.map((actionPlugin) => [actionPlugin.service, { plugin: { name: actionPlugin.service, version: "0.0.1" }, actionPlugin }]));
}

// The three spellings that broke a workflow on 2026-11-12: a plugin whose
// action ids start with a product name, not with its service.
const workspace: ActionPlugin = { service: "google_workspace", actions: [makeAction("sheets.write_spreadsheet"), makeAction("sheets.read_spreadsheet"), makeAction("docs.read_document")] };
const slack: ActionPlugin = { service: "slack", actions: [makeAction("slack.send_message")] };
const slackUser: ActionPlugin = { service: "slack-user", actions: [makeAction("slack_user.search")] };
const bare: ActionPlugin = { service: "notion", actions: [makeAction("search")] };
const dynamic: ActionPlugin = { service: "mcp_box", actions: [], resolveActions: async () => [] };

describe("actionIdResolver", () => {
  const resolver = actionIdResolver(pluginMap(workspace, slack, slackUser, bare, dynamic));

  it("resolves every accepted spelling of one action to its canonical id and service", () => {
    for (const spelling of ["sheets.write_spreadsheet", "google_workspace.sheets.write_spreadsheet", "Google_Workspace.sheets.write_spreadsheet"]) {
      expect(resolver.resolve(spelling)).toEqual({ service: "google_workspace", canonical: "sheets.write_spreadsheet" });
    }
    expect(resolver.resolve("slack.send_message")).toEqual({ service: "slack", canonical: "slack.send_message" });
    expect(resolver.resolve("slack-user.search")).toEqual({ service: "slack-user", canonical: "slack_user.search" });
    expect(resolver.resolve("notion.search")).toEqual({ service: "notion", canonical: "notion.search" });
  });

  it("resolves a runtime service's tools by service, and refuses unknown static ids", () => {
    expect(resolver.resolve("mcp_box.upload")).toEqual({ service: "mcp_box", canonical: "mcp_box.upload" });
    expect(resolver.resolve("google_workspace.sheets.no_such_action")).toBeUndefined();
    expect(resolver.resolve("sheets.no_such_action")).toBeUndefined();
  });

  it("names the owning service instead of the text before the first dot", () => {
    expect(entryService("sheets.write_spreadsheet", resolver)).toBe("google_workspace");
    expect(entryService("google_workspace.*", resolver)).toBe("google_workspace");
    expect(entryService("sheets.write_spreadsheet")).toBe("sheets");
  });

  it("canonicalizes a (service, action) pair however the caller spells the action", () => {
    expect(canonicalActionIdFor(resolver, "google_workspace", "sheets.write_spreadsheet")).toBe("sheets.write_spreadsheet");
    expect(canonicalActionIdFor(resolver, "google_workspace", "google_workspace.sheets.write_spreadsheet")).toBe("sheets.write_spreadsheet");
    expect(canonicalActionIdFor(resolver, "notion", "search")).toBe("notion.search");
  });
});

describe("tool scopes hold canonical ids", () => {
  const resolver = actionIdResolver(pluginMap(workspace, slack, slackUser, bare, dynamic));

  it("allows the action the invoker checks, whichever spelling the step used (the 2026-11-12 regression)", () => {
    const definition = { nodes: [{ id: "save", type: "session", toolScope: { tools: ["bash"], actions: ["google_workspace.sheets.write_spreadsheet"] } }] };
    const scope = workflowStepToolScope({}, definition, "save", resolver);
    expect(actionInScope(scope, canonicalActionIdFor(resolver, "google_workspace", "sheets.write_spreadsheet"))).toBe(true);
    expect(actionInScope(scope, "sheets.read_spreadsheet")).toBe(false);
  });

  it("intersects a run ceiling and a step that spell the same action differently", () => {
    const definition = { nodes: [{ id: "save", type: "session", toolScope: { actions: ["sheets.write_spreadsheet"] } }] };
    const scope = workflowStepToolScope({ toolScope: { actions: ["google_workspace.sheets.write_spreadsheet"] } }, definition, "save", resolver);
    expect(scope?.actions).toEqual(["sheets.write_spreadsheet"]);
  });

  it("expands a service wildcard to the service's own foreign-prefixed ids, and no other plugin's", () => {
    const scope = canonicalizeToolScope({ actions: ["google_workspace.*"] }, resolver);
    expect(actionInScope(scope, "sheets.write_spreadsheet")).toBe(true);
    expect(actionInScope(scope, "docs.read_document")).toBe(true);
    expect(actionInScope(scope, "slack.send_message")).toBe(false);
  });

  it("keeps an entry no service claims, so it can only narrow", () => {
    expect(canonicalizeToolScope({ actions: ["nobody.thing"] }, resolver)?.actions).toEqual(["nobody.thing"]);
  });
});

describe("canonicalizeDefinitionScopes", () => {
  const resolver = actionIdResolver(pluginMap(workspace, slack, slackUser, bare, dynamic));

  it("stores canonical ids for agent steps, including a foreach body", () => {
    const out = canonicalizeDefinitionScopes({ nodes: [
      { id: "a", type: "orchestrator", toolScope: { tools: ["call_tool"], actions: ["google_workspace.sheets.read_spreadsheet", "slack.*"] } },
      { id: "b", type: "foreach", body: { type: "session", toolScope: { actions: ["slack-user.search"] } } },
      { id: "c", type: "tool", service: "slack", action: "send_message" },
    ] }, resolver) as { nodes: Array<Record<string, unknown>> };
    expect(out.nodes[0]?.toolScope).toEqual({ tools: ["call_tool"], actions: ["sheets.read_spreadsheet", "slack.*"] });
    expect((out.nodes[1]?.body as Record<string, unknown>).toolScope).toEqual({ actions: ["slack_user.search"] });
    expect(out.nodes[2]).toEqual({ id: "c", type: "tool", service: "slack", action: "send_message" });
  });

  it("refuses an action id no plugin owns, naming the step", () => {
    expect(() => canonicalizeDefinitionScopes({ nodes: [{ id: "save", type: "session", toolScope: { actions: ["google_workspace.sheets.wrte_spreadsheet"] } }] }, resolver))
      .toThrow(/Unknown action "google_workspace\.sheets\.wrte_spreadsheet" in step "save"/);
  });

  it("compares a stored definition leniently, so a re-save that only respells an id is not a step change", () => {
    const stored = { nodes: [{ id: "save", type: "session", toolScope: { actions: ["google_workspace.sheets.write_spreadsheet", "retired.thing"] } }] };
    expect(() => canonicalizeDefinitionScopes(stored, resolver)).toThrow(/Unknown action "retired\.thing"/);
    const lenient = canonicalizeDefinitionScopes(stored, resolver, { strict: false });
    expect(lenient).toEqual({ nodes: [{ id: "save", type: "session", toolScope: { actions: ["sheets.write_spreadsheet", "retired.thing"] } }] });
    const resaved = canonicalizeDefinitionScopes({ nodes: [{ id: "save", type: "session", toolScope: { actions: ["google_workspace.sheets.write_spreadsheet"] } }] }, resolver);
    expect(sameWorkflowSteps(resaved, canonicalizeDefinitionScopes({ nodes: [{ id: "save", type: "session", toolScope: { actions: ["google_workspace.sheets.write_spreadsheet"] } }] }, resolver, { strict: false }))).toBe(true);
  });
});

describe("every bundled action", () => {
  const map = assemblePlugins([bundledPlugins]).actionPluginByService;
  const resolver = actionIdResolver(map);
  const index = buildToolIndex(map);

  it("resolves from its canonical id and its service-prefixed id to the same owner, and a scope naming either allows it", () => {
    expect(index.size).toBeGreaterThan(0);
    for (const [canonical, { service, actionId }] of index) {
      for (const spelling of [canonical, `${service}.${actionId}`]) {
        expect(resolver.resolve(spelling), spelling).toEqual({ service, canonical });
        const scope = canonicalizeToolScope({ actions: [spelling] }, resolver);
        expect(actionInScope(scope, canonicalActionIdFor(resolver, service, actionId)), spelling).toBe(true);
      }
      expect(entryService(canonical, resolver), canonical).toBe(service);
      expect(actionInScope(canonicalizeToolScope({ actions: [`${service}.*`] }, resolver), canonical), `${service}.*`).toBe(true);
    }
  });
});
