/**
 * Writes every gallery fixture into a query client under the exact key its
 * real hook reads. Factory keys come from `src/api/`. A few hooks spell their
 * key inline; those are copied here with the file that owns them. The route
 * test fails when a rendered component reads a key with no fixture, so a
 * renamed key shows up there.
 */
import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ChildWorkResponse,
  EventLogResponse,
  GetChangelogResponse,
  ListCredentialsResponse,
  ListDecisionsResponse,
  ListEventSubscriptionsResponse,
  ListNotificationDecisionsResponse,
  ListNotificationsResponse,
  ListPluginsResponse,
  ListTeamsResponse,
  ListThreadsResponse,
  ListToolPermissionsResponse,
  ListWorkflowActionRequiredResponse,
  MeResponse,
  OnePasswordSettingsResponse,
  OrgDirectoryResponse,
  OrgResponse,
  ProductAnnouncementsResponse,
  TeamOnePasswordStatusResponse,
  UsageBreakdownResponse,
  UsageDrillResponse,
  UsageOutcomesResponse,
  UsageToolEfficiencyResponse,
  WorkflowRunDetail,
  WorkspaceIntegrationLimitResponse,
} from "@valet/api/wire";
import { qkChangelog } from "~/api/changelog";
import { childWorkKey } from "~/api/child-work";
import { qkEvents } from "~/api/events";
import { qkIntegrations } from "~/api/integrations";
import { onePasswordKeys } from "~/api/onepassword";
import { qkPolicies } from "~/api/policies";
import { qk } from "~/api/queries";
import { qkSettings } from "~/api/settings";
import { qkUsage } from "~/api/usage";
import { qkWorkflows } from "~/api/workflows";
import {
  DECISION_NEXT_CURSOR, stressDecisionsFirstPage, stressDecisionsSecondPage, stressWorkflowActionRequired,
} from "./fixtures/approvals";
import { NOW, stressMe, stressOrg, stressTeams } from "./fixtures/common";
import { eventLogPage, stressEventSubscriptions } from "./fixtures/events";
import {
  INTEGRATIONS_TEAM_ID, stressIntegrationLimit, stressOrgDirectory, stressPlugins, stressTeamCredentials,
  stressToolPermissions, stressUserCredentials,
} from "./fixtures/integrations";
import { stressNotifications } from "./fixtures/notifications";
import {
  USAGE_PERIOD, USAGE_TEAM_ID, USAGE_USE_CASES, stressUsageBreakdown, stressUsageItems, stressUsageOutcomes, stressUsageToolEfficiency,
} from "./fixtures/usage";
import {
  SIDEBAR_SESSION_ID, fixedSidebarThreads, searchSidebarThreads, sidebarThreadPage, stressArchivedThreads,
  stressChildWork, stressSidebarDecisions,
} from "./fixtures/threads";
import { STRESS_AGENT_SESSION_ID, STRESS_RUN_ID, stressAgentDecisions, stressRunDetail } from "./fixtures/workflow-run";

const stressChangelog: GetChangelogResponse = {
  manifest: { schema: "valet-changelog/v2", generatedAt: new Date(NOW).toISOString(), checkpoints: [] },
  artifact: { version: "0.0.0-ui-stress", sha: null, checkpointId: null, status: "empty" },
};

/** The app shell: account, org, teams, changelog, announcements. */
function seedShell(client: QueryClient): void {
  client.setQueryData<MeResponse>(qkSettings.me(), stressMe);
  client.setQueryData<OrgResponse>(qkSettings.org(), stressOrg);
  client.setQueryData<ListTeamsResponse>(qkSettings.teams(), { teams: stressTeams });
  client.setQueryData<GetChangelogResponse>(qkChangelog.manifest(), stressChangelog);
  // Inline key in `components/product-announcement.tsx`. Empty: the notice
  // is fixed over the page, and its dismissal cannot save here.
  client.setQueryData<ProductAnnouncementsResponse>(["product-announcements", stressMe.id], { announcements: [] });
}

/** The bell: updates, workflow approvals, and two decision pages. */
function seedApprovals(client: QueryClient): void {
  client.setQueryData<ListNotificationsResponse>(qk.notifications(), stressNotifications);
  client.setQueryData<ListWorkflowActionRequiredResponse>(qkWorkflows.actionRequired(), stressWorkflowActionRequired);
  // Inline key in `useNotificationDecisions` (`api/queries.ts`).
  client.setQueryData<ListNotificationDecisionsResponse>(["notification-decisions", undefined], stressDecisionsFirstPage);
  client.setQueryData<ListNotificationDecisionsResponse>(["notification-decisions", DECISION_NEXT_CURSOR], stressDecisionsSecondPage);
}

function seedWorkflowRun(client: QueryClient): void {
  client.setQueryData<WorkflowRunDetail>(qkWorkflows.run(STRESS_RUN_ID), stressRunDetail);
  client.setQueryData<ListDecisionsResponse>(qk.decisions(STRESS_AGENT_SESSION_ID), stressAgentDecisions);
}

function seedUsage(client: QueryClient): void {
  client.setQueryData<UsageBreakdownResponse>(qkUsage.breakdown(USAGE_PERIOD, "team", USAGE_TEAM_ID), stressUsageBreakdown);
  client.setQueryData<UsageToolEfficiencyResponse>(qkUsage.toolEfficiency(USAGE_PERIOD, "team", USAGE_TEAM_ID), stressUsageToolEfficiency);
  client.setQueryData<UsageOutcomesResponse>(qkUsage.outcomes(USAGE_PERIOD, "team", USAGE_TEAM_ID), stressUsageOutcomes);
  for (const useCase of USAGE_USE_CASES) {
    client.setQueryData<UsageDrillResponse>(qkUsage.items(USAGE_PERIOD, "team", useCase, USAGE_TEAM_ID), stressUsageItems[useCase]);
  }
}

function seedIntegrations(client: QueryClient): void {
  client.setQueryData<ListPluginsResponse>(qkIntegrations.plugins(), stressPlugins);
  client.setQueryData<ListPluginsResponse>(qkIntegrations.plugins(INTEGRATIONS_TEAM_ID), stressPlugins);
  client.setQueryData<ListCredentialsResponse>(qkIntegrations.credentials("user"), stressUserCredentials);
  client.setQueryData<ListCredentialsResponse>(qkIntegrations.credentials("team", INTEGRATIONS_TEAM_ID), stressTeamCredentials);
  client.setQueryData<ListToolPermissionsResponse>(qkPolicies.myTools(), stressToolPermissions);
  client.setQueryData<OnePasswordSettingsResponse>(onePasswordKeys.settings(), { orgTokenConnected: false, personalTokenConnected: true });
  client.setQueryData<TeamOnePasswordStatusResponse>(onePasswordKeys.team(INTEGRATIONS_TEAM_ID), { tokenConnected: false });
  client.setQueryData<OrgDirectoryResponse>(qkSettings.orgDirectory(), stressOrgDirectory);
  // Inline key in `components/integrations/integration-limit-notice.tsx`.
  client.setQueryData<WorkspaceIntegrationLimitResponse>(["integration-limit", "user", stressMe.id], stressIntegrationLimit);
  client.setQueryData<WorkspaceIntegrationLimitResponse>(["integration-limit", "team", INTEGRATIONS_TEAM_ID], { services: null });
}

/** The events log as the personal workspace reads it, before any filter. */
function seedEvents(client: QueryClient): void {
  const owner = { ownerType: "user" as const, ownerId: stressMe.id };
  for (const problems of [false, true]) {
    client.setQueryData<InfiniteData<EventLogResponse, string | undefined>>(qkEvents.log(owner, problems, undefined, false), {
      pages: [eventLogPage({ problems, q: "", cursor: undefined, diagnostics: false })],
      pageParams: [undefined],
    });
  }
  client.setQueryData<ListEventSubscriptionsResponse>(qkEvents.subscriptions(), stressEventSubscriptions);
}

/** The thread sidebar, all 200 threads loaded in four pages. */
function seedThreads(client: QueryClient): void {
  // Inline key in `hooks/use-workspace-conversation.ts`. Team workspaces
  // resolve to the same session through `resolveUiStressFixture`.
  client.setQueryData<{ sessionId: string }>(["workspace-conversation", "user"], { sessionId: SIDEBAR_SESSION_ID });
  const cursors = [undefined, "threads-page-1", "threads-page-2", "threads-page-3"];
  client.setQueryData<InfiniteData<ListThreadsResponse, string | undefined>>(
    qk.threadPages(SIDEBAR_SESSION_ID, { sort: "last-user-activity", origin: "all" }),
    { pages: cursors.map((cursor) => sidebarThreadPage("all", cursor)), pageParams: cursors },
  );
  client.setQueryData<ListDecisionsResponse>(qk.decisions(SIDEBAR_SESSION_ID), stressSidebarDecisions);
  client.setQueryData<ListThreadsResponse>(qk.threadsArchived(SIDEBAR_SESSION_ID), stressArchivedThreads);
  client.setQueryData<InfiniteData<ChildWorkResponse, string | undefined>>(childWorkKey(SIDEBAR_SESSION_ID), {
    pages: [stressChildWork],
    pageParams: [undefined],
  });
}

export function seedUiStressCache(client: QueryClient): void {
  seedShell(client);
  seedApprovals(client);
  seedWorkflowRun(client);
  seedUsage(client);
  seedIntegrations(client);
  seedEvents(client);
  seedThreads(client);
}

function cursorOf(param: unknown): string | undefined {
  return typeof param === "string" ? param : undefined;
}

/**
 * Fixtures for keys that a person's input decides. Positions follow the key
 * factories: `qk.threadPages`, `qk.threadSearch` and the fixed-thread key in
 * `useSidebarThreads` (`api/queries.ts`), and `qkEvents.log`
 * (`api/events.ts`).
 */
export function resolveUiStressFixture(queryKey: QueryKey, page: { param: unknown } | undefined): unknown {
  const [root, id, kind, sub, first, second] = queryKey;
  if (root === "workspace-conversation") return { sessionId: SIDEBAR_SESSION_ID };
  if (root === "sessions" && id === SIDEBAR_SESSION_ID && kind === "threads") {
    // ["sessions", id, "threads", "pages", { sort, origin }]
    if (sub === "pages" && page) {
      const origin = typeof first === "object" && first !== null && "origin" in first && typeof first.origin === "string" ? first.origin : "all";
      return sidebarThreadPage(origin, cursorOf(page.param));
    }
    // ["sessions", id, "threads", "search", query, projectIds]
    if (sub === "search") return searchSidebarThreads(typeof first === "string" ? first : "");
    // ["sessions", id, "threads", "fixed", ids, threadId]
    if (sub === "fixed") return fixedSidebarThreads(Array.isArray(first) ? first : [], second);
  }
  // ["events", "log", ownerType, ownerId, "all" | "problems", q, diagnostics]
  if (root === "events" && id === "log" && page) {
    const [, , , , filter, q, diagnostics] = queryKey;
    return eventLogPage({ problems: filter === "problems", q: typeof q === "string" ? q : "", cursor: cursorOf(page.param), diagnostics: diagnostics === true });
  }
  return undefined;
}
