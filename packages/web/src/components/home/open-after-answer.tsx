import { useRef, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { DecisionGate } from "@valet/api/wire";

/** A waiting request as the notification inbox lists it. */
export interface AnsweredRequest {
  gate: Pick<DecisionGate, "id" | "threadId">;
  canOpenThread?: boolean;
}

/**
 * Where the person goes after answering a request on Home. The work goes on
 * in the request's thread, so the last waiting answer opens that thread.
 * While other requests still wait (`waiting` counts every waiting request,
 * the answered one too), Home stays and `openLink` offers the thread instead.
 * A request whose thread the person may not open never navigates.
 */
export function useOpenAfterAnswer(waiting: number): {
  answered: (request: AnsweredRequest) => void;
  openLink: (gate: Pick<DecisionGate, "id" | "threadId"> | undefined) => ReactNode;
} {
  const navigate = useNavigate();
  // Gates answered here whose thread the person may open.
  const openable = useRef(new Set<string>());
  return {
    answered: (request) => {
      if (request.canOpenThread === false) return;
      openable.current.add(request.gate.id);
      if (openable.current.size > 200) openable.current.delete(openable.current.values().next().value as string);
      if (waiting <= 1) void navigate({ to: "/threads/$threadId", params: { threadId: request.gate.threadId } });
    },
    openLink: (gate) => gate && openable.current.has(gate.id)
      ? <Link to="/threads/$threadId" params={{ threadId: gate.threadId }} className="shrink-0 text-xs text-muted hover:text-ink hover:underline">Open thread</Link>
      : undefined,
  };
}
