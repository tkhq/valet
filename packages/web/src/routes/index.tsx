import { createFileRoute } from "@tanstack/react-router";
import type { GetOrchestratorInfoResponse } from "@valet/api/wire";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useNotifications } from "~/api/queries";
import { ActivityStrip, mergeActivity } from "~/components/assistant/activity-strip";
import { ThreadsCard } from "~/components/assistant/threads-card";
import { IdentityHeader } from "~/components/assistant/identity-header";
import { IdentityStep } from "~/components/assistant/identity-step";
import { MemoryCard } from "~/components/assistant/memory-card";
import { UsageCard } from "~/components/assistant/usage-card";
import { TeamsCard } from "~/components/assistant/teams-card";
import { Spinner } from "~/components/primitives";

/**
 * `/` — the assistant dashboard (assistant-centered web UI, decision 1).
 * Replaces the old flat session-list home (now at `/sessions`, decision 8).
 *
 * Branches on `GET /api/orchestrator/info`: `name === null` means first
 * visit — an inline, full-page-centered identity step (decision 11); once
 * named, the identity header + card grid + activity strip.
 */
export const Route = createFileRoute("/")({
  component: Dashboard,
});

export function Dashboard() {
  const info = useOrchestratorInfo();

  if (info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (info.error || !info.data) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn't load your assistant.
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => info.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (info.data.name === null) {
    return (
      <div className="flex-1 grid place-items-center p-8">
        <IdentityStep className="w-full max-w-md" variant="onboarding" />
      </div>
    );
  }

  return <DashboardBody info={info.data} />;
}

function DashboardBody({ info }: { info: GetOrchestratorInfoResponse }) {
  const childrenQ = useOrchestratorChildren();
  const notificationsQ = useNotifications();

  const events = mergeActivity(notificationsQ.data?.notifications ?? [], childrenQ.data?.children ?? []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <IdentityHeader info={info} />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <ThreadsCard />
          </div>
          <MemoryCard />
          <UsageCard />
          <TeamsCard />
        </div>

        <ActivityStrip
          events={events}
          loading={notificationsQ.isLoading || childrenQ.isLoading}
          error={!!notificationsQ.error || !!childrenQ.error}
          onRetry={() => {
            notificationsQ.refetch();
            childrenQ.refetch();
          }}
        />
      </div>
    </div>
  );
}
