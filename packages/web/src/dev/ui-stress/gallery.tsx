/**
 * The UI stress gallery at `/dev/ui-stress`, development only. Each section
 * renders a real component with an extreme fixture from `./fixtures`, read
 * from a frozen query client (`./frozen-query-client`), so the page needs no
 * server and shows the same data on every load. Open it at 375, 760, and
 * 1280 px to see the layout breaks. The root layout puts the app shell on the
 * same client, so the top nav, the bell, and the thread sidebar show the
 * fixtures too. Buttons that change data fail on purpose: the client sends
 * nothing.
 */
import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { EventLog, type LogFilter } from "~/components/events/event-log";
import { NotificationsBell } from "~/components/layout/notifications-bell";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { ThreadTree } from "~/components/session/thread-tree";
import { WorkflowAgentApprovals } from "~/components/workflows/agent-approvals";
import { TeamIntegrations } from "~/components/integrations/team-integrations";
import { cn } from "~/lib/cn";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { EventDetailBody } from "~/routes/events.$eventId";
import { IntegrationsPage } from "~/routes/integrations";
import { UsagePage } from "~/routes/usage";
import { RunDetailBody } from "~/routes/workflows.runs.$runId";
import { uiStressClient } from "./client";
import { DECISION_FIRST_PAGE_COUNT, WORKFLOW_APPROVAL_COUNT } from "./fixtures/approvals";
import { stressMe } from "./fixtures/common";
import { EVENT_DELIVERY_COUNT, EVENT_LOG_COUNT, stressEventDetail } from "./fixtures/events";
import { INTEGRATIONS_TEAM_ID, SHARE_COUNT } from "./fixtures/integrations";
import { NOTIFICATION_COUNT } from "./fixtures/notifications";
import { THREAD_ID, stressThreadGates, stressThreadMessages } from "./fixtures/thread";
import { SIDEBAR_SESSION_ID, SIDEBAR_THREAD_COUNT } from "./fixtures/threads";
import { USAGE_OWNER_COUNT, USAGE_STEPS_PER_WORKFLOW, USAGE_TEAM_ID, USAGE_WORKFLOW_COUNT } from "./fixtures/usage";
import {
  APPROVAL_GATE_COUNT, FOREACH_GATE_COUNT, STRESS_AGENT_SESSION_ID, STRESS_RUN_ID, TOOL_GATE_COUNT, stressPendingGates, stressRunDetail,
} from "./fixtures/workflow-run";

/** Section ids and headings, in page order. The test reads this list. */
export const UI_STRESS_SECTIONS = [
  { id: "approvals", title: "Approvals / Needs action" },
  { id: "workflow-gates", title: "Workflow run gates and agent approvals" },
  { id: "thread-decisions", title: "Thread decision cards" },
  { id: "usage", title: "Usage" },
  { id: "integrations", title: "Integrations" },
  { id: "events", title: "Events log" },
  { id: "threads", title: "Thread sidebar" },
  { id: "notifications", title: "Notification updates" },
] as const;

type SectionId = (typeof UI_STRESS_SECTIONS)[number]["id"];

const columnClass = "mx-auto w-full max-w-5xl px-4 sm:px-6";
// No `overflow-hidden`: content that escapes its frame is the bug to see.
const frameClass = "flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-paper";

/** `wide` drops the column for a real page that brings its own. */
function Section({ id, note, wide = false, children }: { id: SectionId; note: string; wide?: boolean; children: ReactNode }) {
  const title = UI_STRESS_SECTIONS.find((section) => section.id === id)?.title;
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-4 space-y-4 border-t border-line pt-8">
      <div className={columnClass}>
        <h2 id={`${id}-heading`} className="font-display text-xl text-ink">
          <a href={`#${id}`} className="hover:underline">{title}</a>
        </h2>
        <p className="mt-1 text-sm text-muted">{note}</p>
      </div>
      <div className={wide ? "min-w-0" : columnClass}>{children}</div>
    </section>
  );
}

function Frame({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <figure className="space-y-2">
      <figcaption className="text-xs font-medium uppercase tracking-wide text-muted">{label}</figcaption>
      <div className={cn(frameClass, className)}>{children}</div>
    </figure>
  );
}

/** The log's filter and search live in its page's URL; here they are local. */
function EventLogSection() {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  return <EventLog filter={filter} onFilterChange={setFilter} query={query} onQueryChange={setQuery} />;
}

export default function UiStressGallery() {
  return (
    // The shell may already run on this client; the provider makes the page
    // frozen on its own too, as in the route test.
    <QueryClientProvider client={uiStressClient}>
      {/* A plain `div`: the app shell renders the page's one `main`. */}
      <div className="min-w-0 flex-1 overflow-y-auto pb-24">
        <header className={cn(columnClass, "space-y-3 py-6")}>
          <h1 className="font-display text-2xl text-ink">UI stress gallery</h1>
          <p className="text-sm text-muted">
            Development only. Real components with extreme fixtures: long titles, unbroken tokens, deep JSON, many
            rows, emoji, and right-to-left text. The top nav, the bell, and the thread sidebar use the same fixtures.
            Approve, Deny, and other changes fail on purpose. Nothing reaches the server.
          </p>
          <nav aria-label="Gallery sections">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {UI_STRESS_SECTIONS.map((section) => (
                <li key={section.id}><a className="text-moss hover:underline" href={`#${section.id}`}>{section.title}</a></li>
              ))}
            </ul>
          </nav>
        </header>

        <div className="space-y-12">
          <Section id="approvals" note={`The bell opens on load with ${WORKFLOW_APPROVAL_COUNT + DECISION_FIRST_PAGE_COUNT} items: ${WORKFLOW_APPROVAL_COUNT} workflow approvals and policy gates, ${DECISION_FIRST_PAGE_COUNT} decision gates, and a second page behind Next approvals. A click outside closes it. Click the bell to open it again. Approve all and Deny all list every title in their confirm dialog.`}>
            <div className="flex justify-end">
              <NotificationsBell defaultOpen />
            </div>
          </Section>

          <Section id="workflow-gates" note={`The run page body with ${stressPendingGates.length} pending gates: ${APPROVAL_GATE_COUNT} approval nodes, ${FOREACH_GATE_COUNT} foreach iterations of one tool node, and ${TOOL_GATE_COUNT} policy gates, with long node ids and parameters. Below it, the gates of a workflow agent session.`}>
            <div className="space-y-6">
              <Frame label="Run detail (RunDetailBody)">
                <RunDetailBody runId={STRESS_RUN_ID} data={stressRunDetail} onCancel={() => {}} cancelPending={false} onRetry={() => {}} retryPending={false} />
              </Frame>
              <Frame label="Workflow agent approvals (WorkflowAgentApprovals)">
                <WorkflowAgentApprovals sessionId={STRESS_AGENT_SESSION_ID} />
              </Frame>
            </div>
          </Section>

          <Section id="thread-decisions" note="A thread transcript with the gate card below it, where the thread view puts it: a tool approval with Always allow, and an ask_question gate with eight long options. A credential request and a shared-account gate follow.">
            <div className="space-y-6">
              {stressThreadGates.slice(0, 2).map((gate) => (
                <Frame key={gate.id} label={`Thread view: ${gate.type}`} className="h-[min(48rem,90dvh)]">
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <MessageList messages={stressThreadMessages} threadId={THREAD_ID} viewerId={stressMe.id} ratings={false} />
                  </div>
                  <DecisionGateCard sessionId={gate.sessionId} gate={gate} />
                  <div className="h-4 shrink-0" />
                </Frame>
              ))}
              {stressThreadGates.slice(2).map((gate) => (
                <Frame key={gate.id} label={`Gate card: ${gate.type}${gate.approver ? " (shared account)" : ""}`}>
                  <DecisionGateCard sessionId={gate.sessionId} gate={gate} />
                  <div className="h-4 shrink-0" />
                </Frame>
              ))}
            </div>
          </Section>

          <Section id="usage" note={`The usage page in a team workspace with a long name. Select Breakdown for the ${USAGE_OWNER_COUNT}-owner table, the models, and the skills. Then select the Workflows row for ${USAGE_WORKFLOW_COUNT} workflows with ${USAGE_STEPS_PER_WORKFLOW} steps each.`} wide>
            <PinnedWorkspaceScope teamId={USAGE_TEAM_ID}>
              <UsagePage />
            </PinnedWorkspaceScope>
          </Section>

          <Section id="integrations" note={`The personal list (every broken state, long service names, orphaned credentials) and a team list with ${SHARE_COUNT} shares of one service, a dead team connection, and a broken share. A row click opens the real Integrations page.`} wide>
            <div className="space-y-8">
              <Frame label="Personal workspace">
                <PinnedWorkspaceScope teamId={undefined}>
                  <IntegrationsPage />
                </PinnedWorkspaceScope>
              </Frame>
              <Frame label="Team workspace">
                <TeamIntegrations teamId={INTEGRATIONS_TEAM_ID} />
              </Frame>
            </div>
          </Section>

          <Section id="events" note={`The personal events log: ${EVENT_LOG_COUNT} rows over three pages (Load more), long summaries and details, folded problem rows, and delivery counts. Below it, one event with ${EVENT_DELIVERY_COUNT} deliveries, long errors, many refs, and a deep payload.`}>
            <div className="space-y-8">
              <PinnedWorkspaceScope teamId={undefined}>
                <EventLogSection />
              </PinnedWorkspaceScope>
              <Frame label="Event detail (EventDetailBody)" className="p-4">
                <EventDetailBody data={stressEventDetail} />
              </Frame>
            </div>
          </Section>

          <Section id="threads" note={`The thread list with ${SIDEBAR_THREAD_COUNT} threads: long and untitled titles, every origin, pull requests, shares, questions, unread rows, pending gates, and 60 sub-conversations, 40 of them under one thread. The app sidebar shows the same list. Below the md breakpoint, open it with the threads button at the top left.`}>
            <Frame label="Thread list (ThreadTree) at the default sidebar width" className="h-[min(48rem,85dvh)] w-72 max-w-full">
              <ThreadTree sessionId={SIDEBAR_SESSION_ID} />
            </Frame>
          </Section>

          <Section id="notifications" note={`The Updates list in the bell: ${NOTIFICATION_COUNT} notifications with long titles, repeated titles grouped with a count, and read rows hidden. No component renders a notification body, so the 2,000-character bodies never show. Click this bell to open it. The bell in Approvals and the bell in the top nav show the same list.`}>
            <div className="flex justify-end">
              <NotificationsBell />
            </div>
          </Section>
        </div>
      </div>
    </QueryClientProvider>
  );
}
