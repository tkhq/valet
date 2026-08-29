/**
 * Env resolvers for the security autonomy nudge sweep
 * (`SecurityRunnerDriver`, spec §Autonomy). Kept beside the sandbox-backend
 * resolvers so config parsing stays out of the driver and stays testable.
 */

/** Sweep interval in ms (`VALET_SECURITY_NUDGE_INTERVAL_MS`, default 20000).
 * A 0 or negative value disables the sweep (start() no-ops). */
export function resolveSecurityNudgeIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_SECURITY_NUDGE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return 20_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 20_000;
}

/** No-progress nudges before the sweep alerts the user instead of looping
 * (`VALET_SECURITY_NUDGE_MAX_STALLS`, default 3). */
export function resolveSecurityNudgeMaxStalls(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_SECURITY_NUDGE_MAX_STALLS;
  if (raw === undefined || raw.trim() === "") return 3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}
