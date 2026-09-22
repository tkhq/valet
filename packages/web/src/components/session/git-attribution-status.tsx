import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "~/api/client";
import { Button } from "~/components/primitives";

export function GitAttributionStatus({ sessionId, idle }: { sessionId: string; idle: boolean }) {
  const key = ["sessions", sessionId, "git-attribution"] as const;
  const query = useQuery({ queryKey: key, queryFn: () => api.getSessionGitAttribution(sessionId), staleTime: 30_000 });
  const queryClient = useQueryClient();
  const apply = useMutation({ mutationFn: () => api.applySessionGitAttribution(sessionId), onSuccess: (data) => queryClient.setQueryData(key, data) });
  if (!query.data) return null;
  const data = query.data;
  const mode = data.mode === "valet_app_signed" ? "Valet App signed" : data.mode === "valet_unsigned" ? "Valet unsigned" : data.mode === "user_turnkey_signed" ? "You · Turnkey signed" : "You · unsigned";
  return <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted" aria-live="polite">
    <span>Git settings generation {data.generation}</span><span>·</span>
    <span>{mode} · co-author {data.coAuthoredBy ? "on" : "off"} · correlation {data.correlationTrailers ? "on" : "off"}</span>
    {data.updateAvailable && <><span className="text-ink">New Git settings are available.</span><Button size="sm" variant="secondary" disabled={!idle || apply.isPending} onClick={() => apply.mutate()}>Apply current Git settings</Button></>}
    {apply.error && <span role="alert" className="text-danger-500">{apply.error.message}</span>}
  </div>;
}
