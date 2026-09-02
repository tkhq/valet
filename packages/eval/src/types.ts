/**
 * Core types for the eval framework (TKAI-213).
 *
 * The framework wraps @valet/engine in-process: it submits eval-case prompts
 * through real engine sessions, extracts a Trajectory from the persisted
 * entries, and scores the Trajectory with checks. See docs in each type.
 */
import type { MessageCost, MessageUsage } from "@valet/engine";

// ── Trajectory ──────────────────────────────────────────────────────────────

/** One tool invocation the agent made, in trajectory order. */
export interface TrajectoryToolCall {
  /** Tool name as the agent saw it (e.g. `mem_write`, `bash`). */
  toolName: string;
  /** Stable per-call id from the engine entry part. */
  callId: string;
  /** Final persisted status. `running` means the call never reached a terminal state. */
  status: "running" | "completed" | "error";
  /** Parsed tool arguments, when the agent supplied any. */
  args?: unknown;
  /** Raw persisted result. Use `toolResultText` to read it as a string. */
  result?: unknown;
  /** Error message when status is `error`. */
  error?: string;
  /** 0-based order across the whole trajectory. */
  index: number;
  /**
   * Fully-qualified plugin action id when this call went through the plugin
   * catalog: `call_tool` calls carry their `tool_id` argument here, and
   * pinned tools (`service__action`) carry the dotted form. Deterministic
   * tool checks match on `toolName` OR `actionId`, so a case can say
   * `tool: github.list_pull_requests` regardless of the invocation route.
   */
  actionId?: string;
  /**
   * True when the pruner elided this call's stored result to save context.
   * The original output is unrecoverable; result-matching checks report
   * the elision explicitly instead of a misleading pattern mismatch.
   */
  elided?: boolean;
}

/** One agent turn (one assistant message cycle) with its reported usage. */
export interface TrajectoryTurn {
  /** 0-based order. */
  index: number;
  /** Token usage the model reported for this turn, when available. */
  usage?: MessageUsage;
  /** USD cost for this turn. Absent when the model is unpriced. */
  cost?: MessageCost;
  /**
   * The submission this turn settled: links each turn back to the case's
   * `turns[]` entry (or to a child.settled signal delivery), so checks and
   * readers can scope per-submission instead of guessing from order.
   */
  queueItemId?: string;
}

/**
 * The ordered record of everything the agent did for one eval case: prompt,
 * model, turns, tool calls, final output, usage, cost, duration, stop reason.
 */
export interface Trajectory {
  /** Id of the eval case that produced this trajectory. */
  caseId: string;
  /** The first user turn's content. */
  prompt: string;
  /** Model spec the case ran with (e.g. `anthropic/claude-haiku-4-5`). */
  model: string;
  turns: TrajectoryTurn[];
  toolCalls: TrajectoryToolCall[];
  /** Text of the last assistant message. */
  finalOutput: string;
  /**
   * Aggregate token usage across this trajectory's OWN turns. Child
   * sessions are excluded — use `aggregateUsage` for the recursive total a
   * scorecard should report.
   */
  usage: MessageUsage;
  /** Aggregate USD cost across this trajectory's own turns. Absent when the model is unpriced. */
  cost?: MessageCost;
  /** Wall-clock duration of the case run. */
  durationMs: number;
  /** Stop reason of the final assistant message. */
  stopReason?: string;
  metadata?: Record<string, unknown>;
  /**
   * Child trajectories for orchestrator cases — one per child session the
   * orchestrator spawned. Recursive: children can have children.
   */
  children?: Trajectory[];
  /** For a child trajectory: callId of the `task` tool call that spawned it. */
  spawnedByCallId?: string;
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** Deterministic checks — pure functions over a Trajectory. */
export type DeterministicCheck =
  | {
      type: "tool_called";
      tool: string;
      /** Exact call count. Mutually exclusive with min/max. */
      count?: number;
      /** Minimum call count (default 1 when count is absent). */
      min?: number;
      /** Maximum call count. */
      max?: number;
      /** Require at least one matching call after a call to this tool. */
      after?: string;
    }
  | { type: "tool_not_called"; tool: string }
  | { type: "tool_result_matches"; tool: string; pattern: string }
  | { type: "tool_result_not_matches"; tool: string; pattern: string }
  | {
      type: "tool_args_match";
      tool: string;
      /** JSON subset: every listed key must deep-equal the call's args value. */
      args: Record<string, unknown>;
    }
  | { type: "output_contains"; value?: string; pattern?: string }
  | { type: "output_not_contains"; value?: string; pattern?: string }
  | { type: "all_terminal" }
  | { type: "no_errors" }
  | { type: "max_turns"; value: number }
  | { type: "max_tokens"; value: number }
  | { type: "max_cost"; value: number }
  | { type: "max_duration"; value: number };

/** LLM-as-judge checks — score with a grading model, pass at score >= threshold. */
export type JudgeCheck =
  | { type: "judge_output"; rubric: string; threshold?: number; judge_model?: string }
  | { type: "judge_trajectory"; rubric: string; threshold?: number; judge_model?: string }
  | {
      type: "judge_equivalence";
      /** Extra grading guidance. The base equivalence prompt is built in. */
      rubric?: string;
      threshold?: number;
      judge_model?: string;
    };

export type Check = DeterministicCheck | JudgeCheck;

/** Every legal `Check.type` value, used by the case loader for validation. */
export const CHECK_TYPES = [
  "tool_called",
  "tool_not_called",
  "tool_result_matches",
  "tool_result_not_matches",
  "tool_args_match",
  "output_contains",
  "output_not_contains",
  "all_terminal",
  "no_errors",
  "max_turns",
  "max_tokens",
  "max_cost",
  "max_duration",
  "judge_output",
  "judge_trajectory",
  "judge_equivalence",
] as const;

/** Outcome of one check against one trajectory. */
export interface CheckResult {
  check: Check;
  pass: boolean;
  /** Human-readable explanation, always set on failure. */
  detail?: string;
  /** Judge score (1-5) for judge checks. */
  score?: number;
}

// ── Eval cases ──────────────────────────────────────────────────────────────

/** One scripted user turn of an eval case conversation. */
export interface EvalTurn {
  role: "user";
  /**
   * Prompt text. May contain templates interpolated from the previous agent
   * output (e.g. `{{last_output_match(/id: (\w+)/)}}`) — resolved by the
   * runner between turns.
   */
  content: string;
}

/**
 * Which environment the case needs.
 *  - `unit`: built-in tools only, virtual sandbox (default).
 *  - `mock`: adds a mock plugin catalog with canned responses (TKAI-335).
 *  - `integration`: real plugins with live read-only credentials (TKAI-336).
 *  - `full`: real plugins, mutations allowed, Docker sandbox (TKAI-336).
 */
export type EvalProfile = "unit" | "mock" | "integration" | "full";

/** Canned response for one mocked tool (`profile: mock`). */
export interface MockToolSpec {
  response: string;
}

/** One eval case, loaded from a YAML file in `evals/cases/`. */
export interface EvalCase {
  /** Unique id, kebab-case. Doubles as the baseline directory name. */
  id: string;
  description?: string;
  /** User turns, in order. Single-prompt cases use a one-element array. */
  turns: EvalTurn[];
  /** Model spec pin. Absent → the suite default model. */
  model?: string;
  /** Per-case timeout. Absent → the suite default. */
  timeout_ms?: number;
  /**
   * Samples per scorecard row (pass@k). Each run is an independent fresh
   * session. Default 1. The CLI's `--runs` overrides for the whole suite.
   */
  runs?: number;
  /**
   * Fraction of runs that must pass for the case to PASS (0 to 1].
   * Default 1 (every run must pass) — flaky is a failure by default.
   */
  pass_threshold?: number;
  /**
   * Sampling temperature for the model under test. Some models reject
   * non-default values; leave unset for the provider default.
   */
  temperature?: number;
  /** Restrict the agent to these tool names. Absent → all profile tools. */
  tools?: string[];
  /** `orchestrator` sets up the full orchestrator environment. */
  session_type?: "default" | "orchestrator";
  profile?: EvalProfile;
  /** Canned tool responses, keyed by tool name (`profile: mock` only). */
  mock_tools?: Record<string, MockToolSpec>;
  /** Credential services the case needs. Missing credentials → SKIP. */
  required_credentials?: string[];
  checks: Check[];
}

// ── Scorecard ───────────────────────────────────────────────────────────────

/** Per-run sampling statistics for a multi-run (pass@k) case. */
export interface SamplingStats {
  /** Runs executed. */
  runs: number;
  /** Runs where every check passed. */
  passes: number;
  /** Pass threshold the status was computed against. */
  threshold: number;
  /** Per-run recursive token totals, in run order. */
  tokensPerRun: number[];
  tokensMean: number;
  /** Population standard deviation of tokensPerRun. 0 for a single run. */
  tokensStd: number;
  /** Per-run recursive cost totals; absent when unpriced. */
  costPerRun?: number[];
}

/** Result of one case (one or more runs), as the scorecard reports it. */
export interface ScorecardEntry {
  caseId: string;
  status: "pass" | "fail" | "skip";
  /** Why the case was skipped (e.g. a missing credential). */
  skipReason?: string;
  durationMs: number;
  /** Total USD cost across ALL runs (children included). Absent when unpriced. */
  costUsd?: number;
  /** Mean recursive tokens per run (children included). */
  totalTokens?: number;
  /** Check results of the reported run (first failing run, else the last). */
  checkResults: CheckResult[];
  /** Trajectory of the reported run, for baselines and verbose output. */
  trajectory?: Trajectory;
  /** Error that aborted the reported run before checks could complete. */
  error?: string;
  /** Present when the case ran more than once. */
  sampling?: SamplingStats;
}
