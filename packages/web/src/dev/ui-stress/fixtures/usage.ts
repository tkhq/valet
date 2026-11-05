/** `/usage` in a team workspace with a long name: 30 owners, many models and
 * skills, and a workflow drill-down with many steps per workflow. */
import type {
  SessionOutcomeUsage,
  UsageBreakdownResponse,
  UsageBucket,
  UsageDrillItem,
  UsageDrillResponse,
  UsageOutcomesResponse,
  UsagePeriodSelection,
  UsageToolEfficiencyResponse,
  UsageUseCase,
} from "@valet/api/wire";
import { DAY, EMOJI, HEX_300, NOW, TITLE_400, memberId, teamId, teamName, unbroken } from "./common";
import { longNodeId, stressTitle } from "./approvals";

/** The page's default period. Its keys must use this exact value. */
export const USAGE_PERIOD: UsagePeriodSelection = { kind: "lookback", window: "7d" };

/** The team the usage section pins. Its name is one of the long ones. */
export const USAGE_TEAM_ID = teamId(1);

function bucket(i: number): UsageBucket {
  return {
    costUsd: i === 0 ? 0 : i % 7 === 0 ? 123_456.789 : (i * 13.37) % 997,
    totalTokens: i * 1_234_567,
    inputTokens: i * 1_000_000,
    outputTokens: i * 234_567,
    cacheReadTokens: i * 9_876_543,
    cacheWriteTokens: i * 12_345,
    turns: i * 97,
    unpricedTurns: i % 5 === 0 ? i : 0,
  };
}

export const USAGE_USE_CASES: UsageUseCase[] = ["orchestrator", "session", "workflow", "proxy"];

export const USAGE_OWNER_COUNT = 30;

function ownerName(i: number): string {
  if (i === 0) return "Team / shared";
  if (i % 4 === 1) return `${teamName(i)} shared automation account`;
  if (i % 4 === 2) return `member-${String(i).padStart(2, "0")}@${unbroken("subsidiary", 50)}.example.com`;
  return memberId(i);
}

export const stressUsageBreakdown: UsageBreakdownResponse = {
  activeAgents: 4_321,
  windowMs: 7 * DAY,
  scope: "team",
  totalCostUsd: 9_876_543.21,
  totalTokens: 98_765_432_109,
  totalInputTokens: 87_654_321_098,
  totalOutputTokens: 11_111_111_011,
  totalCacheReadTokens: 76_543_210_987,
  totalCacheWriteTokens: 1_234_567_890,
  totalTurns: 1_234_567,
  unpricedTurns: 4_242,
  byUseCase: USAGE_USE_CASES.map((useCase, i) => ({ ...bucket(i + 3), useCase })),
  skillBreakdown: Array.from({ length: 14 }, (_, i) => ({
    skillKey: `skill-${i}`,
    name: i % 3 === 0 ? `${unbroken("release-notes-writer", 80)}-${i}` : stressTitle(i),
    origin: (["plugin", "local", "repo"] as const)[i % 3]!,
    pluginName: i % 3 === 0 ? `plugin-${unbroken("enterprise", 40)}` : undefined,
    invocations: i * 1_001,
    uniqueInvokers: i * 3,
    unassignedInvocations: i % 2,
    attributedContextTokens: i * 77_777,
    carryingCalls: i * 11,
    fileReads: i * 5,
    scriptRuns: i * 2,
  })),
  byModel: Array.from({ length: 12 }, (_, i) => ({
    ...bucket(i + 1),
    model: i === 0 ? null : i % 3 === 0 ? `openrouter/${unbroken("provider-preview-model-", 90)}${i}` : `model-${i}`,
  })),
  byUser: Array.from({ length: USAGE_OWNER_COUNT }, (_, i) => ({
    ...bucket(i),
    userId: i === 0 ? "shared" : memberId(i),
    name: ownerName(i),
    avgDailyActiveAgents: i % 6 === 0 ? undefined : i * 1.37,
  })),
  dailyAgentWindow: { days: 7, sinceMs: NOW - 7 * DAY, untilMs: NOW, timezone: "UTC" },
  byDay: Array.from({ length: 30 }, (_, i) => ({
    dayMs: Math.floor((NOW - (29 - i) * DAY) / DAY) * DAY,
    costUsd: i % 9 === 0 ? 0 : i === 20 ? 250_000 : i * 41.5,
    totalTokens: i * 1_000_000,
  })),
};

export const stressUsageToolEfficiency: UsageToolEfficiencyResponse = {
  windowMs: 7 * DAY,
  scope: "team",
  byUseCase: USAGE_USE_CASES.map((useCase, i) => ({ useCase, modelDirectedCalls: i * 123_456, modelFreeActions: i * 98_765 })),
};

export const stressUsageOutcomes: UsageOutcomesResponse = {
  scope: "team",
  byOutcome: [
    { kind: "pull_request_created", count: 12_345, estimatedCostUsd: 98_765.43, estimatedCostPerOutcomeUsd: 8.0 },
    { kind: "review_submitted", count: 0, estimatedCostUsd: 0, estimatedCostPerOutcomeUsd: null },
    { kind: "slack_message_sent", count: 999_999, estimatedCostUsd: 1_234.5, estimatedCostPerOutcomeUsd: 0.0012345 },
    { kind: "slack_dm_sent", count: 7, estimatedCostUsd: 123_456.78, estimatedCostPerOutcomeUsd: 17_636.68 },
  ],
  unpricedTurns: 4_242,
};

export const USAGE_WORKFLOW_COUNT = 12;
export const USAGE_STEPS_PER_WORKFLOW = 9;

function drill(useCase: UsageUseCase, item: Omit<UsageDrillItem, "useCase" | "sessionId" | "costUsd" | "totalTokens" | "turns"> & { sessionId?: string | null }, i: number): UsageDrillItem {
  return { useCase, sessionId: null, costUsd: (i * 7.77) % 501, totalTokens: i * 54_321, turns: i * 3, ...item };
}

const workflowItems: UsageDrillItem[] = Array.from({ length: USAGE_WORKFLOW_COUNT }, (_, w) => {
  const workflowId = `usage-workflow-${w}`;
  const root = drill("workflow", { id: workflowId, label: stressTitle(w), isChild: false, parentId: null, workflowId, runs: w * 17 }, w + 1);
  const steps = Array.from({ length: USAGE_STEPS_PER_WORKFLOW }, (_, s) =>
    drill("workflow", {
      id: `${workflowId}/${s % 3 === 0 ? longNodeId(s) : `step_${s}`}`,
      label: s % 3 === 0 ? longNodeId(s) : `step_${s}`,
      isChild: true,
      parentId: workflowId,
      workflowId,
      runs: s + 1,
    }, s + w));
  return [root, ...steps];
}).flat();

const sessionItems: UsageDrillItem[] = Array.from({ length: 10 }, (_, i) => {
  const parentId = `usage-session-${Math.floor(i / 3) * 3}`;
  const isChild = i % 3 !== 0;
  return drill("session", {
    id: `usage-session-${i}`,
    label: isChild ? `Child: ${stressTitle(i)}` : stressTitle(i + 1),
    isChild,
    parentId: isChild ? parentId : null,
    sessionId: `session-${i}`,
  }, i + 2);
});

const orchestratorItems: UsageDrillItem[] = [
  drill("orchestrator", { id: "usage-orchestrator-0", label: `${teamName(1)} assistant`, isChild: false, parentId: null }, 3),
  drill("orchestrator", { id: "usage-orchestrator-1", label: `${EMOJI} ${TITLE_400}`, isChild: false, parentId: null }, 4),
];

const proxyItems: UsageDrillItem[] = Array.from({ length: 6 }, (_, i) =>
  drill("proxy", { id: `usage-proxy-${i}`, label: i === 0 ? `key-${HEX_300}` : `API key ${i}`, isChild: false, parentId: null }, i + 1));

export const stressUsageItems: Record<UsageUseCase, UsageDrillResponse> = {
  tagging: { items: [] },
  workflow: { items: workflowItems },
  session: { items: sessionItems },
  orchestrator: { items: orchestratorItems },
  proxy: { items: proxyItems },
};

export const stressSessionOutcomes: SessionOutcomeUsage = { outcomes: [
  { key: "completed", label: "Completed", definition: "The requested work was delivered.", sessions: 123456 },
  { key: "partial", label: "Partial", definition: "Some requested work remains unfinished.", sessions: 1234 },
  { key: "blocked_on_human", label: "Blocked on human", definition: "Work needs a person to answer or approve.", sessions: 321 },
] };
