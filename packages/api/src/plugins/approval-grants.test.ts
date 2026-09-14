import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { beforeEach, describe, expect, it } from "vitest";
import { orgs, runtimeGrants } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { assemblePlugins } from "./assemble.js";
import { resolveTrustedActionGrant, writeTrustedApprovalGrants } from "./approval-grants.js";

const action = (id: string): PluginAction => ({
  id,
  name: id,
  description: "Test action.",
  riskLevel: "critical",
  parameters: Type.Object({}),
  execute: async () => ({ success: true }),
});

function plugin(actionPlugin: ActionPlugin): ValetPlugin {
  return { name: `plugin-${actionPlugin.service}`, version: "1", description: "Test plugin.", actions: [actionPlugin] };
}

const githubAction = action("github.create_issue");
const githubPlugin = plugin({ service: "github", actions: [githubAction] });
const slackPlugin = plugin({ service: "slack", actions: [action("slack.send_message")] });

let pg: TestPgDb;
beforeEach(async () => {
  pg = await freshTestPgDb();
  await pg.appDb.insert(orgs).values({ id: "org-1", name: "Test", createdAt: 1 });
});

describe("trusted approval grants", () => {
  it("binds bare and fully-qualified ids to the static service action and risk", () => {
    const plugins = assemblePlugins([[githubPlugin]]).actionPluginByService;
    const expected = { service: "github", actionId: "github.create_issue", riskLevel: "critical" };
    expect(resolveTrustedActionGrant(plugins, "github", "create_issue")).toEqual(expected);
    expect(resolveTrustedActionGrant(plugins, "github", "github.create_issue")).toEqual(expected);
  });

  it("writes the exact fully-qualified production action grant", async () => {
    const plugins = assemblePlugins([[githubPlugin]]).actionPluginByService;
    await writeTrustedApprovalGrants(pg.appDb, plugins, {
      runId: "run-1",
      orgId: "org-1",
      signalId: "approval-1",
      resolvedBy: "user-1",
      now: 100,
      grants: [{ service: "github", actionId: "github.create_issue" }],
    });
    expect(await pg.appDb.select().from(runtimeGrants)).toEqual([
      expect.objectContaining({
        orgId: "org-1",
        workflowExecutionId: "run-1",
        policyKey: "github.create_issue",
        service: "github",
        actionId: "github.create_issue",
        riskLevel: "critical",
        sourceApprovalId: "approval-1",
        grantedBy: "user-1",
        createdAt: 100,
        expiresAt: 259_200_100,
      }),
    ]);
  });

  it.each([
    ["unknown", [{ service: "github", actionId: "github.missing" }]],
    ["cross-service", [{ service: "github", actionId: "slack.send_message" }]],
    ["mixed", [{ service: "github", actionId: "github.create_issue" }, { service: "slack", actionId: "github.create_issue" }]],
  ])("rejects %s ids with a diagnostic before any write", async (_name, grants) => {
    const plugins = assemblePlugins([[githubPlugin, slackPlugin]]).actionPluginByService;
    await expect(writeTrustedApprovalGrants(pg.appDb, plugins, {
      runId: "run-1", orgId: "org-1", signalId: "approval-1", resolvedBy: "user-1", now: 100, grants,
    })).rejects.toThrow("unknown or cross-service action");
    expect(await pg.appDb.select().from(runtimeGrants)).toHaveLength(0);
  });

  it("does not trust a legacy action available only through dynamic discovery", async () => {
    const dynamic = plugin({ service: "legacy", actions: [], resolveActions: async () => [action("legacy.run")] });
    const plugins = assemblePlugins([[dynamic]]).actionPluginByService;
    await expect(writeTrustedApprovalGrants(pg.appDb, plugins, {
      runId: "run-1", orgId: "org-1", signalId: "approval-1", resolvedBy: "user-1", now: 100,
      grants: [{ service: "legacy", actionId: "legacy.run" }],
    })).rejects.toThrow("unknown or cross-service action legacy:legacy.run");
    expect(await pg.appDb.select().from(runtimeGrants)).toHaveLength(0);
  });
});
