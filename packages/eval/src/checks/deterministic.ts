/**
 * Deterministic check handlers (TKAI-330).
 *
 * Each handler is a pure function `(check, trajectory) => CheckResult` — no
 * LLM calls, no side effects. Failure details name what was expected and
 * what the trajectory actually holds, so a red scorecard row is actionable
 * without re-running the case.
 */
import { toolResultText } from "../trajectory.js";
import type { CheckResult, DeterministicCheck, Trajectory, TrajectoryToolCall } from "../types.js";

function pass(check: DeterministicCheck, detail?: string): CheckResult {
  return { check, pass: true, ...(detail !== undefined ? { detail } : {}) };
}

function fail(check: DeterministicCheck, detail: string): CheckResult {
  return { check, pass: false, detail };
}

function renderCall(call: TrajectoryToolCall): string {
  const result = toolResultText(call.result).slice(0, 80).replace(/\s+/g, " ");
  return `${call.toolName} [${call.status}]${result ? ` → "${result}"` : ""}`;
}

function renderCalls(calls: TrajectoryToolCall[]): string {
  return calls.map(renderCall).join(" | ") || "(none)";
}

/**
 * True when `subset` is contained in `actual`: objects require every subset
 * key to match recursively, arrays require exact deep equality, primitives
 * require strict equality.
 */
export function jsonSubsetMatches(subset: unknown, actual: unknown): boolean {
  if (subset === null || typeof subset !== "object") return subset === actual;
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual) || actual.length !== subset.length) return false;
    return subset.every((v, i) => jsonSubsetMatches(v, actual[i]));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(subset).every(([k, v]) => jsonSubsetMatches(v, actualRecord[k]));
}

/** Run one deterministic check against a trajectory. */
export function runDeterministicCheck(check: DeterministicCheck, trajectory: Trajectory): CheckResult {
  const calls = trajectory.toolCalls;
  const named = (tool: string): TrajectoryToolCall[] => calls.filter((c) => c.toolName === tool);

  switch (check.type) {
    case "tool_called": {
      let candidates = named(check.tool);
      let scope = "";
      if (check.after !== undefined) {
        const anchor = calls.find((c) => c.toolName === check.after);
        if (!anchor) {
          return fail(
            check,
            `expected \`${check.tool}\` after \`${check.after}\`, but \`${check.after}\` was never called. Calls: ${renderCalls(calls)}`,
          );
        }
        candidates = candidates.filter((c) => c.index > anchor.index);
        scope = ` after \`${check.after}\``;
      }
      const n = candidates.length;
      if (check.count !== undefined && n !== check.count) {
        return fail(
          check,
          `expected \`${check.tool}\`${scope} to be called exactly ${check.count} time(s), got ${n}. Calls: ${renderCalls(calls)}`,
        );
      }
      const min = check.min ?? (check.count === undefined ? 1 : undefined);
      if (min !== undefined && n < min) {
        return fail(
          check,
          `expected \`${check.tool}\`${scope} to be called at least ${min} time(s), got ${n}. Calls: ${renderCalls(calls)}`,
        );
      }
      if (check.max !== undefined && n > check.max) {
        return fail(
          check,
          `expected \`${check.tool}\`${scope} to be called at most ${check.max} time(s), got ${n}. Calls: ${renderCalls(calls)}`,
        );
      }
      return pass(check);
    }

    case "tool_not_called": {
      const matches = named(check.tool);
      if (matches.length > 0) {
        return fail(
          check,
          `expected \`${check.tool}\` not to be called, but it was called ${matches.length} time(s): ${renderCalls(matches)}`,
        );
      }
      return pass(check);
    }

    case "tool_result_matches": {
      const matches = named(check.tool);
      if (matches.length === 0) {
        return fail(check, `expected a \`${check.tool}\` result to match /${check.pattern}/, but the tool was never called.`);
      }
      const re = new RegExp(check.pattern);
      if (!matches.some((c) => re.test(toolResultText(c.result)))) {
        return fail(
          check,
          `expected at least one \`${check.tool}\` result to match /${check.pattern}/. Results: ${renderCalls(matches)}`,
        );
      }
      return pass(check);
    }

    case "tool_result_not_matches": {
      const re = new RegExp(check.pattern);
      const offenders = named(check.tool).filter((c) => re.test(toolResultText(c.result)));
      if (offenders.length > 0) {
        return fail(
          check,
          `expected no \`${check.tool}\` result to match /${check.pattern}/, but ${offenders.length} did: ${renderCalls(offenders)}`,
        );
      }
      return pass(check);
    }

    case "tool_args_match": {
      const matches = named(check.tool);
      if (matches.length === 0) {
        return fail(check, `expected \`${check.tool}\` to be called with matching args, but it was never called.`);
      }
      if (!matches.some((c) => jsonSubsetMatches(check.args, c.args))) {
        return fail(
          check,
          `no \`${check.tool}\` call matched args subset ${JSON.stringify(check.args)}. Actual args: ${matches
            .map((c) => JSON.stringify(c.args))
            .join(" | ")}`,
        );
      }
      return pass(check);
    }

    case "output_contains":
    case "output_not_contains": {
      const output = trajectory.finalOutput;
      const matched =
        check.value !== undefined
          ? output.includes(check.value)
          : check.pattern !== undefined
            ? new RegExp(check.pattern).test(output)
            : false;
      const wanted = check.value !== undefined ? `\`${check.value}\`` : `/${check.pattern}/`;
      if (check.type === "output_contains" && !matched) {
        return fail(check, `expected the final output to contain ${wanted}. Output: ${truncate(output)}`);
      }
      if (check.type === "output_not_contains" && matched) {
        return fail(check, `expected the final output not to contain ${wanted}. Output: ${truncate(output)}`);
      }
      return pass(check);
    }

    case "all_terminal": {
      const orphaned = calls.filter((c) => c.status !== "completed" && c.status !== "error");
      if (orphaned.length > 0) {
        return fail(check, `expected every tool call to reach completed or error, but ${orphaned.length} did not: ${renderCalls(orphaned)}`);
      }
      return pass(check);
    }

    case "no_errors": {
      const errored = calls.filter((c) => c.status === "error");
      if (errored.length > 0) {
        return fail(check, `expected no tool call to end in error, but ${errored.length} did: ${renderCalls(errored)}`);
      }
      return pass(check);
    }

    case "max_turns": {
      const n = trajectory.turns.length;
      if (n > check.value) return fail(check, `expected at most ${check.value} turn(s), got ${n}.`);
      return pass(check);
    }

    case "max_tokens": {
      const n = trajectory.usage.total;
      if (n > check.value) return fail(check, `expected at most ${check.value} total tokens, got ${n}.`);
      return pass(check);
    }

    case "max_cost": {
      if (trajectory.cost === undefined) {
        // Unpriced models (dev fakes, custom providers) report no cost. Pass
        // with a visible note rather than failing a run that cannot be priced.
        return pass(check, "the model is unpriced; no cost data to compare");
      }
      const c = trajectory.cost.total;
      if (c > check.value) {
        return fail(check, `expected total cost at most $${check.value}, got $${c.toFixed(4)}.`);
      }
      return pass(check);
    }

    case "max_duration": {
      if (trajectory.durationMs > check.value) {
        return fail(check, `expected wall clock at most ${check.value}ms, got ${trajectory.durationMs}ms.`);
      }
      return pass(check);
    }
  }
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
