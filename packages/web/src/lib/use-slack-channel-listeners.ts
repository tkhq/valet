import { useEffect, useMemo, useState } from "react";
import { hasSlackListenerRegex, slackChannelListeners, type ChannelListener } from "./slack-listeners";
import type { SlackListenersRequest, SlackListenersResponse } from "./slack-listeners-protocol";

export const SLACK_LISTENER_DEADLINE_MS = 1_000;

type Coverage =
  | { status: "checking" }
  | { status: "error" }
  | { status: "ready"; listeners: Map<string, ChannelListener> };

/** Regex execution must stay off the UI thread, including stored patterns. */
export function useSlackChannelListeners(
  subscriptions: SlackListenersRequest["subscriptions"],
  teamId: string,
  teamName: (id: string) => string | undefined,
  catalog: SlackListenersRequest["catalog"],
): Coverage & { retry: () => void } {
  const teamNames = Object.fromEntries(subscriptions.map((rule) => [rule.ownerId, teamName(rule.ownerId)]));
  // Query results and callback identities can change without a data change.
  // The value key also invalidates old results during render, before effects.
  const key = JSON.stringify({ subscriptions, teamId, teamNames, catalog });
  const needsWorker = hasSlackListenerRegex(subscriptions);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; coverage: Coverage }>();
  const synchronous = useMemo(() => needsWorker ? undefined
    : slackChannelListeners(subscriptions, teamId, (id) => teamNames[id], catalog), [key, needsWorker]);

  useEffect(() => {
    if (!needsWorker) return;
    let active = true;
    let worker: Worker | undefined;
    const finish = (coverage: Coverage) => {
      if (!active) return;
      active = false;
      clearTimeout(deadline);
      worker?.terminate();
      setResult({ key, attempt, coverage });
    };
    const deadline = setTimeout(() => finish({ status: "error" }), SLACK_LISTENER_DEADLINE_MS);
    try {
      worker = new Worker(new URL("./slack-listeners.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<SlackListenersResponse>) => {
        if (data?.kind === "ready" && Array.isArray(data.listeners)) {
          finish({ status: "ready", listeners: new Map(data.listeners) });
        } else finish({ status: "error" });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish({ status: "error" });
      };
      worker.onmessageerror = () => finish({ status: "error" });
      worker.postMessage({ subscriptions, teamId, teamNames, catalog } satisfies SlackListenersRequest);
    } catch {
      finish({ status: "error" });
    }
    return () => {
      active = false;
      clearTimeout(deadline);
      worker?.terminate();
    };
    // `key` represents all request values, including resolved team names.
  }, [key, needsWorker, attempt]);

  const coverage: Coverage = synchronous ? { status: "ready", listeners: synchronous }
    : result?.key === key && result.attempt === attempt ? result.coverage : { status: "checking" };
  return { ...coverage, retry: () => setAttempt((current) => current + 1) };
}
