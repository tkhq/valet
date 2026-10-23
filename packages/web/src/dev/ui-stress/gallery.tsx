/**
 * The UI stress gallery at `/dev/ui-stress`, development only. Each section
 * renders a real component with an extreme fixture from `./fixtures`, read
 * from a frozen query client (`./frozen-query-client`), so the page needs no
 * server and shows the same data on every load. Open it at 375, 760, and
 * 1280 px to see the layout breaks. The root layout puts the app shell on the
 * same client, so the top bar and the drawer show the fixtures too. Buttons that change data fail on purpose: the client sends
 * nothing.
 */
import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { EventLog, type LogFilter } from "~/components/events/event-log";
import { ApprovalsInbox, UpdatesList } from "~/components/home/approvals-inbox";
import { NeedsYouDock } from "~/components/home/needs-you-dock";
import { TasksPanel } from "~/components/home/tasks-panel";
import { BriefCard } from "~/components/home/brief-card";
import { HomeEmptyState } from "~/components/home/home-empty-state";
import { OutputCards } from "~/components/home/output-card";
import { TasksSummary } from "~/components/home/tasks-summary";
import { ProcessingStatus } from "~/components/session/processing-status";
import { ExpiryCountdown } from "~/components/session/expiry-countdown";
import { ResolvedGateNotice } from "~/components/session/gate-outcome";
import { QuickReplies } from "~/components/session/quick-replies";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { PinnedPlan } from "~/components/session/thread-plan";
import { MessageList } from "~/components/session/message-list";
import { ThreadTree } from "~/components/session/thread-tree";
import { WorkflowAgentApprovals } from "~/components/workflows/agent-approvals";
import { TeamIntegrations } from "~/components/integrations/team-integrations";
import { cn } from "~/lib/cn";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { EventDetailBody } from "~/routes/presence.events.$eventId";
import { IntegrationsPage } from "~/routes/integrations";
import { UsagePage } from "~/routes/usage";
import { RunDetailBody } from "~/routes/workflows.runs.$runId";
import { uiStressClient } from "./client";
import { LayoutAuditPanel } from "./layout-audit-panel";
import { DECISION_FIRST_PAGE_COUNT, WORKFLOW_APPROVAL_COUNT } from "./fixtures/approvals";
import { stressMe } from "./fixtures/common";
import { EVENT_DELIVERY_COUNT, EVENT_LOG_COUNT, stressEventDetail } from "./fixtures/events";
import { INTEGRATIONS_TEAM_ID, SHARE_COUNT } from "./fixtures/integrations";
import { NOTIFICATION_COUNT } from "./fixtures/notifications";
import { HOME_TASK_COUNT, HOME_THREAD_ID, stressBrief, stressHomeConversation, stressHomeTasks } from "./fixtures/home";
import { THREAD_ID, stressThreadGates, stressThreadMessages, workTurnMessages } from "./fixtures/thread";
import { galleryWidgets } from "./fixtures/widgets";
import { WidgetView } from "~/components/session/widgets/widget-view";
import { SIDEBAR_SESSION_ID, SIDEBAR_THREAD_COUNT } from "./fixtures/threads";
import { USAGE_OWNER_COUNT, USAGE_STEPS_PER_WORKFLOW, USAGE_TEAM_ID, USAGE_WORKFLOW_COUNT } from "./fixtures/usage";
import {
  APPROVAL_GATE_COUNT, FOREACH_GATE_COUNT, STRESS_AGENT_SESSION_ID, STRESS_RUN_ID, TOOL_GATE_COUNT, stressPendingGates, stressRunDetail,
} from "./fixtures/workflow-run";

/** Section ids and headings, in page order. The test reads this list. */
export const UI_STRESS_SECTIONS = [
  { id: "tasks", title: "Home Tasks" },
  { id: "home-components", title: "Home components" },
  { id: "approvals", title: "Approvals inbox" },
  { id: "workflow-gates", title: "Workflow run gates and agent approvals" },
  { id: "thread-work", title: "Thread work lines" },
  { id: "processing", title: "Valet processing" },
  { id: "widgets", title: "Widgets" },
  { id: "thread-decisions", title: "Thread decision cards" },
  { id: "usage", title: "Usage" },
  { id: "integrations", title: "Integrations" },
  { id: "events", title: "Events log" },
  { id: "threads", title: "Thread sidebar" },
  { id: "notifications", title: "Notices list" },
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
    <figure className="min-w-0 space-y-2">
      <figcaption className="text-xs font-medium uppercase tracking-wide text-muted">{label}</figcaption>
      <div className={cn(frameClass, className)}>{children}</div>
    </figure>
  );
}

/** The log's chip and place search live in its page's URL; here they are local. */
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
            rows, emoji, and right-to-left text. The top bar and the drawer use the same fixtures.
            Approve, Deny, and other changes fail on purpose. Nothing reaches the server.
          </p>
          <LayoutAuditPanel />
          <nav aria-label="Gallery sections">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {UI_STRESS_SECTIONS.map((section) => (
                <li key={section.id}><a className="text-moss hover:underline" href={`#${section.id}`}>{section.title}</a></li>
              ))}
            </ul>
          </nav>
        </header>

        <div className="space-y-12">
          <Section id="tasks" note={`Tasks as Home shows it beside the conversation: ${HOME_TASK_COUNT} threads across three workspaces, with plans, a question, a failure, unread replies, right-to-left text, and finished tasks with Mark done. The approvals above them come from the Approvals fixtures. Below it, the dock that sits over the Home composer.`}>
            <div className="space-y-6">
              <Frame label="Tasks (TasksPanel) at the desktop column width" className="w-[400px] max-w-full p-4">
                <TasksPanel />
              </Frame>
              <Frame label="Approvals dock over the Home composer (NeedsYouDock)">
                <NeedsYouDock homeThreadId={HOME_THREAD_ID} onOpenTasks={() => {}} />
              </Frame>
            </div>
          </Section>

          <Section id="home-components" note="The pieces Home is built from, each on its own: the brief card (long topic, long line, every state), output cards, the Tasks summary line, quick replies under a yes-or-no question, an approval countdown, the line an answered approval leaves, and the empty Home.">
            <div className="grid gap-6 md:grid-cols-2">
              <Frame label="Brief (BriefCard)" className="p-4"><BriefCard headline={stressBrief.headline} items={stressBrief.items} /></Frame>
              <Frame label="Outputs (OutputCards)" className="p-4"><OutputCards outputs={stressHomeTasks.finished[1]?.outputs} /></Frame>
              <Frame label="Tasks summary (TasksSummary)" className="space-y-2 p-4">
                <TasksSummary needsYou={2} working={4} finished={3} /><TasksSummary needsYou={0} working={0} finished={0} />
              </Frame>
              <Frame label="Quick replies (QuickReplies)" className="py-2">
                <QuickReplies sessionId={stressHomeConversation.sessionId} threadId={HOME_THREAD_ID}
                  messages={[{ id: "quick-reply-fixture", role: "assistant", content: "Design review at 3, then nothing. Want prep notes?",
                    parts: [{ kind: "text", text: "Design review at 3, then nothing. Want prep notes?" }], createdAt: 1, completed: true, threadId: HOME_THREAD_ID, sessionId: stressHomeConversation.sessionId }]} />
              </Frame>
              <Frame label="Approval countdown and answered line" className="space-y-2 p-4">
                <ExpiryCountdown expiresAt={Date.now() + 8 * 60_000} /><ExpiryCountdown expiresAt={Date.now() + 70_000} />
                <ResolvedGateNotice label="Sent" title="Post the release notes to #eng" className="px-0 sm:px-0" />
                <ResolvedGateNotice label="Denied" title="Merge tkhq/valet #945" className="px-0 sm:px-0" />
              </Frame>
              <Frame label="Empty Home (HomeEmptyState)" className="min-h-64"><HomeEmptyState sessionId={stressHomeConversation.sessionId} threadId={HOME_THREAD_ID} /></Frame>
            </div>
          </Section>

          <Section id="approvals" note={`The approvals inbox with ${WORKFLOW_APPROVAL_COUNT + DECISION_FIRST_PAGE_COUNT} items: ${WORKFLOW_APPROVAL_COUNT} workflow approvals and policy gates, ${DECISION_FIRST_PAGE_COUNT} decision gates, and a second page behind Next approvals. Approve all and Deny all list every title in their confirm dialog.`}>
            <Frame label="Approvals (ApprovalsInbox)" className="p-4">
              <ApprovalsInbox />
            </Frame>
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

          <Section id="thread-work" note="One finished turn as the engine writes it: a message per agent step, most of them tool calls only. The transcript folds the steps into one line that says what happened; it opens into a timeline, and a step opens into its full card. The failed push shows in red, and the reply ends with how long the turn worked.">
            <Frame label="Thread view: a finished turn" className="h-[min(40rem,80dvh)]">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <MessageList messages={workTurnMessages} threadId={THREAD_ID} viewerId={stressMe.id} ratings={false} />
              </div>
            </Frame>
          </Section>

          <Section id="processing" note="Composer status cues on phones and desktop: thinking before the first token, tool work, streaming, queued work, waiting, and paused work. Durable queue snapshots show Slack-origin work after reconnect. Idle leaves no visible cue. Check light and dark themes and reduced motion.">
            <div className="grid min-w-0 gap-6 md:grid-cols-2">
              <Frame label="Thinking before the first token" className="pt-3"><ProcessingStatus status="thinking" /></Frame>
              <Frame label="Tool call in progress" className="pt-3"><ProcessingStatus status="tool_calling" /></Frame>
              <Frame label="Streaming a response" className="pt-3"><ProcessingStatus status="streaming" /></Frame>
              <Frame label="Queued submission" className="pt-3"><ProcessingStatus status="queued" /></Frame>
              <Frame label="Waiting for a response" className="pt-3"><ProcessingStatus status="blocked_on_decision_gate" /></Frame>
              <Frame label="Paused queue" className="pt-3"><ProcessingStatus status="idle" queue={{ mode: "followup", status: "paused", pendingIds: ["queued"], collectingIds: [] }} /></Frame>
              <Frame label="Slack-origin work after reconnect" className="pt-3"><ProcessingStatus status="idle" queue={{ mode: "followup", status: "running", activeItemId: "slack-origin", pendingIds: [], collectingIds: [] }} /></Frame>
              <Frame label="Queued external submission after reconnect" className="pt-3"><ProcessingStatus status="idle" queue={{ mode: "followup", status: "queued", pendingIds: ["external"], collectingIds: [] }} /></Frame>
              <Frame label="Idle: no processing cue" className="min-h-12"><ProcessingStatus status="idle" /></Frame>
            </div>
          </Section>

          <Section id="widgets" note="Cards the assistant shows with show_widget, drawn from a json-render spec with Valet components: the generative-UI demo's transactions, meeting memory, and new event (its buttons reply as you), a status list, an activity grid, and one with long text everywhere.">
            <div className="grid gap-4 md:grid-cols-2">
              {galleryWidgets.map(widget => <Frame key={widget.label} label={widget.label}><WidgetView spec={widget.spec} title={widget.label} /></Frame>)}
            </div>
          </Section>

          <Section id="thread-decisions" note="A thread transcript with the pinned plan and the gate card below it, where the thread view puts them: a tool approval with Always allow, and an ask_question gate with eight long options. The plan has 20 items at the length limit; click it to open the checklist. A credential request, a Slack post with a payload preview, and a shared-account gate follow.">
            <div className="space-y-6">
              {stressThreadGates.slice(0, 2).map((gate) => (
                <Frame key={gate.id} label={`Thread view: ${gate.type}`} className="h-[min(48rem,90dvh)]">
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <MessageList messages={stressThreadMessages} threadId={THREAD_ID} viewerId={stressMe.id} ratings={false} />
                  </div>
                  <PinnedPlan threadId={THREAD_ID} />
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

          <Section id="threads" note={`The thread list with ${SIDEBAR_THREAD_COUNT} threads: long and untitled titles, every origin, pull requests, shares, questions, unread rows, pending gates, and 60 sub-conversations, 40 of them under one thread. Threads with a question or a gate show under Needs you. Sub-conversations start collapsed: open them with the arrow on the row. The search dialog lists workflows and files too. The drawer shows the same list. Below the md breakpoint, open it with the menu button at the top left.`}>
            <Frame label="Thread list (ThreadTree) at the default sidebar width" className="h-[min(48rem,85dvh)] w-72 max-w-full">
              <ThreadTree sessionId={SIDEBAR_SESSION_ID} />
            </Frame>
          </Section>

          <Section id="notifications" note={`Notices under Tasks: ${NOTIFICATION_COUNT} notifications with long titles, repeated titles grouped with a count, and read rows hidden. No component renders a notification body, so the 2,000-character bodies never show.`}>
            <Frame label="Notices (UpdatesList)" className="p-4">
              <UpdatesList />
            </Frame>
          </Section>
        </div>
      </div>
    </QueryClientProvider>
  );
}
