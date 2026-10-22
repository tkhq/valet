/**
 * The app's one connection-and-retry policy. It decides which failures mean
 * that no api answered, how long to wait before the next try, and whether
 * the api is reachable. Every REST query, the session socket and the health
 * probe use it. Mutations never retry: they fail at once (`errorText` names
 * the outage), and a message send carries an idempotency key instead.
 *
 * A deploy restarts the single api replica, and the load balancer answers
 * 502/503/504 until the new replica is up. A failure like that reports here,
 * and this module then:
 *
 * 1. Probes `GET /api/health`. A failed probe marks the api `reconnecting`
 *    and takes TanStack Query offline. Queries keep their data and pause
 *    their retries and polls, so panels show no error for the restart.
 * 2. Probes again on the shared backoff until the api answers.
 * 3. Brings TanStack Query back online and refetches every active query.
 *
 * A session socket's `init` after a reconnect also proves that the api
 * answers, and it runs the same recovery.
 */
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { ApiError } from "./api-error";

// ── Which failures are retryable ──────────────────────────────────────

/** Statuses that a gateway in front of the api answers while the api is down. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * True when no api answered: `fetch` got no response (it rejects with a
 * `TypeError`), or a gateway answered for the api. The api answers its own
 * errors with a JSON object, so a gateway status with a JSON object body is
 * the api's real answer (a provider fault, for example), not an outage.
 */
export function isServerUnavailable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof ApiError && GATEWAY_STATUSES.has(error.status) &&
    (typeof error.payload !== "object" || error.payload === null);
}

// ── How long to wait ──────────────────────────────────────────────────

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const JITTER_RATIO = 0.25;

/**
 * The wait before retry number `attempt` (1-based): 500 ms doubling to an
 * 8 s cap, plus up to 25 % jitter, so the tabs that lost the api together do
 * not all return at the same moment. Claude Code's API retries use the same
 * curve with a 32 s cap.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base + random() * JITTER_RATIO * base);
}

// ── Whether to retry a query ──────────────────────────────────────────

/**
 * Retries for a gateway failure while the api passes its health check, so
 * one route that times out at the load balancer still shows its error.
 * During a confirmed outage a query retries until the api returns.
 */
const RETRIES_WHILE_REACHABLE = 3;

type RetryOption<TError> = boolean | number | ((failureCount: number, error: TError) => boolean) | undefined;

/**
 * Applies the outage rule before a query's own `retry` option. A failure
 * that no api answered retries while the api is down, even for a query that
 * sets `retry: false` for real errors. Every other failure follows the
 * query's rule, which TanStack reads as a count, a flag, or a function.
 */
export function retryThroughOutage<TError>(retry: RetryOption<TError>): (failureCount: number, error: TError) => boolean {
  return (failureCount, error) => {
    if (isServerUnavailable(error)) {
      return apiStatus() === "reconnecting" || failureCount < RETRIES_WHILE_REACHABLE;
    }
    if (typeof retry === "function") return retry(failureCount, error);
    if (typeof retry === "number") return failureCount < retry;
    return retry === true;
  };
}

// ── Whether the api is reachable ──────────────────────────────────────

/** `checking` is a health probe in flight that has not failed yet. The banner shows only for `reconnecting`. */
export type ApiConnection = "online" | "checking" | "reconnecting";

export const useApiConnection = create<{ status: ApiConnection }>(() => ({ status: "online" }));

const PROBE_TIMEOUT_MS = 5_000;

let queryClient: QueryClient | undefined;
let probing = false;

function apiStatus(): ApiConnection {
  return useApiConnection.getState().status;
}

/** Connects recovery to the app's query client. Call once at startup. */
export function installConnection(client: QueryClient): void {
  queryClient = client;
}

/** A request or a socket got no answer from the api. Starts the health probe unless it already runs. */
export function reportServerUnavailable(): void {
  if (probing) return;
  probing = true;
  if (apiStatus() === "online") useApiConnection.setState({ status: "checking" });
  void probeUntilHealthy().finally(() => {
    probing = false;
  });
}

/**
 * For a loop that does not run on TanStack Query (the browser frame feed).
 * Call it after `reportServerUnavailable()`. It resolves `true` when a
 * confirmed outage ends, so the loop can start again, and `false` when the
 * probe finds the api reachable, so the failure was the endpoint's own.
 */
export function waitForOutageEnd(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let sawOutage = apiStatus() === "reconnecting";
    if (apiStatus() === "online") return resolve(false);
    const stop = useApiConnection.subscribe(({ status }) => {
      if (status === "reconnecting") sawOutage = true;
      if (status !== "online") return;
      stop();
      resolve(sawOutage);
    });
    signal.addEventListener("abort", () => { stop(); resolve(false); }, { once: true });
  });
}

/** A session socket reconnected and the api sent `init`. */
export function reportServerReachable(): void {
  useApiConnection.setState({ status: "online" });
  refetchAfterOutage();
}

async function probeUntilHealthy(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (await healthy()) break;
    // A socket proved the api answers while this probe ran, and recovered.
    if (apiStatus() === "online") return;
    if (apiStatus() !== "reconnecting") {
      useApiConnection.setState({ status: "reconnecting" });
      onlineManager.setOnline(false);
    }
    await sleep(backoffDelay(attempt));
    if (apiStatus() === "online") return;
  }
  const wasDown = apiStatus() === "reconnecting";
  useApiConnection.setState({ status: "online" });
  // A probe that passed at once means the api answered the failed request
  // itself. No query paused, so there is nothing to recover.
  if (wasDown) refetchAfterOutage();
}

function refetchAfterOutage(): void {
  onlineManager.setOnline(true);
  // Data can change while the api is down, so every query is stale. Active
  // queries refetch now, and inactive ones refetch when a view mounts them.
  // `cancelRefetch: false` lets several reconnecting sockets share one fetch.
  void queryClient?.invalidateQueries(undefined, { cancelRefetch: false });
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
