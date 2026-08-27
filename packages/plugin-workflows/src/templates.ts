/**
 * Cross-service workflow templates.
 *
 * A template belongs to the plugin that owns the actions it calls. These
 * four have no single owner: three read several services at once, and the
 * memory sweep reads none at all. They live with the workflow surface
 * itself.
 *
 * Three contract rules shape every definition here.
 *
 * 1. A scheduled run gets NO `dataSchema` defaults — the schedule puts its
 *    own payload in `trigger.data`, so a template that reads
 *    `trigger.data.<field>` on a cron run reads null. Every scheduled
 *    template below therefore carries its parameters as literals, and only
 *    the manual batch template declares inputs.
 * 2. `trigger.timestamp` IS available on every run path, so a scheduled run
 *    can still know the date.
 * 3. An MCP action (Linear) returns its text content as the node result, a
 *    string. Read the whole `nodes.<id>.result`, never a field under it.
 *
 * Slack here is read-only. This plugin set has no action that posts to a
 * Slack channel, so a digest is delivered through the orchestrator, which
 * is the durable inbox the person already reads.
 */
import type { WorkflowTemplate } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";

const nightlyMemorySweep: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      // The memory tools are built onto the orchestrator session and exist
      // nowhere else — there is no memory action, so no `tool` node can
      // reach memory. An orchestrator node is not a workaround here, it is
      // the only way to express this.
      id: "sweep",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "Run your nightly memory hygiene pass. The time now is {{ trigger.timestamp }}.",
        "",
        "1. Search memory for entries that cover the same subject.",
        "2. Merge each duplicate set into one entry. Keep the newest facts, and keep every open question.",
        "3. Remove entries that are finished work with no lasting fact in them.",
        "4. Correct any entry that a later entry contradicts. Keep the later fact.",
        "5. Leave anything you are unsure about exactly as it is.",
        "",
        "Then report, in one paragraph: what you merged, what you removed, and what you left alone",
        "because you were unsure.",
      ].join("\n"),
    },
  ],
  edges: [{ from: "start", to: "sweep" }],
};

const dailyTriageDigest: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      id: "review_queue",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Pull requests that asked for your review",
      params: { q: "is:open is:pr review-requested:@me archived:false", limit: 25 },
    },
    {
      id: "linear_issues",
      type: "tool",
      service: "linear",
      action: "list_issues",
      // Linear's MCP `list_issues` reads the assignee filter as "me" for the
      // authenticated user (the tool's own description: "For my issues, use
      // 'me' as the assignee.").
      params: { assignee: "me" },
      summary: "Issues assigned to you",
    },
    {
      id: "slack_channels",
      type: "tool",
      service: "slack",
      action: "list_channels",
      summary: "Channels the workspace connection has joined",
      params: { scope: "joined" },
    },
    {
      id: "slack_history",
      type: "foreach",
      items: "{{ nodes.slack_channels.result.channels }}",
      // Explicit, so a workspace with more channels than this is reported
      // as truncated by the digest instead of quietly cut short.
      maxItems: 12,
      concurrency: 3,
      onItemError: "collect",
      body: {
        id: "read_channel",
        type: "tool",
        service: "slack",
        action: "read_history",
        summary: "Recent messages in one channel",
        params: { channel: "{{ item.id }}", limit: 40 },
      },
    },
    {
      id: "digest",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You write one morning triage digest across three sources. Lead with what blocks another person. " +
        "Then what blocks the reader. Then what only needs to be read. Give each item its link or its " +
        "channel. Merge items that describe the same piece of work. Never invent an item.",
      prompt: [
        "The time now is {{ trigger.timestamp }}. Treat anything older than one day as background.",
        "",
        "## GitHub — reviews waiting on you",
        "{{ nodes.review_queue.result.items }}",
        "",
        "## Linear — issues assigned to you",
        "{{ nodes.linear_issues.result }}",
        "",
        "## Slack — recent channel activity",
        "Channels read: {{ nodes.slack_history.result.completedCount }} of {{ nodes.slack_history.result.inputCount }}.",
        "Channels not read because the limit was reached: {{ nodes.slack_history.result.truncatedCount }}.",
        "{{ nodes.slack_history.result.items }}",
        "",
        "Write the digest in markdown, under 500 words. Name any source that returned an error,",
        "and say plainly when a source had nothing.",
      ].join("\n"),
    },
    {
      id: "deliver",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "This is my morning triage digest. Post it back to me as it is written.",
        "Do not act on any item unless I ask you to.",
        "",
        "{{ nodes.digest.result.text }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "review_queue" },
    { from: "start", to: "linear_issues" },
    { from: "start", to: "slack_channels" },
    { from: "slack_channels", to: "slack_history" },
    { from: "review_queue", to: "digest" },
    { from: "linear_issues", to: "digest" },
    { from: "slack_history", to: "digest" },
    { from: "digest", to: "deliver" },
  ],
};

const meetingPrep: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      id: "my_pull_requests",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Your recent pull requests",
      params: { q: "is:pr author:@me archived:false", sort: "updated", order: "desc", limit: 25 },
    },
    {
      id: "linear_issues",
      type: "tool",
      service: "linear",
      action: "list_issues",
      // Linear's MCP `list_issues` reads the assignee filter as "me" for the
      // authenticated user (the tool's own description: "For my issues, use
      // 'me' as the assignee.").
      params: { assignee: "me" },
      summary: "Issues assigned to you",
    },
    {
      id: "slack_channels",
      type: "tool",
      service: "slack",
      action: "list_channels",
      summary: "Channels the workspace connection has joined",
      params: { scope: "joined" },
    },
    {
      id: "slack_discussions",
      type: "foreach",
      items: "{{ nodes.slack_channels.result.channels }}",
      maxItems: 12,
      concurrency: 3,
      onItemError: "collect",
      body: {
        // `threads_only` keeps the messages that drew replies. A staff
        // meeting cares about discussions, not about one-line notices.
        id: "read_discussions",
        type: "tool",
        service: "slack",
        action: "read_history",
        summary: "Threaded discussions in one channel",
        params: { channel: "{{ item.id }}", limit: 100, threads_only: true },
      },
    },
    {
      id: "brief",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You prepare one person for a staff meeting. Select only what is worth saying out loud: a " +
        "decision someone must make, a blocker another team owns, a risk to a date, and work that " +
        "finished and should be told. Leave out routine progress. Each line must be sayable in ten seconds.",
      prompt: [
        "The time now is {{ trigger.timestamp }}. Cover the last seven days.",
        "",
        "## GitHub — your recent pull requests",
        "{{ nodes.my_pull_requests.result.items }}",
        "",
        "## Linear — issues assigned to you",
        "{{ nodes.linear_issues.result }}",
        "",
        "## Slack — threaded discussions",
        "Channels read: {{ nodes.slack_discussions.result.completedCount }} of {{ nodes.slack_discussions.result.inputCount }}.",
        "Channels not read because the limit was reached: {{ nodes.slack_discussions.result.truncatedCount }}.",
        "{{ nodes.slack_discussions.result.items }}",
        "",
        "Write four short sections: Decisions needed, Blockers, Risks to a date, Worth telling.",
        "Write nothing under a heading that has nothing. Say so in one line instead.",
      ].join("\n"),
    },
    {
      id: "deliver",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "This is my meeting prep for the week. Post it back to me as it is written,",
        "then hold it so I can ask you about any line.",
        "",
        "{{ nodes.brief.result.text }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "my_pull_requests" },
    { from: "start", to: "linear_issues" },
    { from: "start", to: "slack_channels" },
    { from: "slack_channels", to: "slack_discussions" },
    { from: "my_pull_requests", to: "brief" },
    { from: "linear_issues", to: "brief" },
    { from: "slack_discussions", to: "brief" },
    { from: "brief", to: "deliver" },
  ],
};

const batchOverRows: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        rows: {
          type: "array",
          required: true,
          label: "Rows",
          placeholder: '[{"account": "Acme", "arr": 120000, "industry": "logistics"}]',
          description: "The list to work through. One entry per row. Up to 100 rows per run.",
        },
        instruction: {
          type: "string",
          required: true,
          label: "What to do with each row",
          placeholder: "Assign an account tier: enterprise, mid-market, or self-serve.",
          description: "One instruction, applied to every row on its own.",
        },
      },
    },
    {
      id: "batch",
      type: "foreach",
      items: "{{ trigger.data.rows }}",
      // The cap is declared, not inherited, and the rollup below reports
      // `truncatedCount` — so a list longer than the cap is visible.
      maxItems: 100,
      concurrency: 3,
      onItemError: "collect",
      body: {
        id: "judge_row",
        type: "llm",
        model: "claude-haiku-4-5",
        system:
          "You apply one instruction to one row. Judge only the row in front of you. " +
          "Give a short reason that cites a value from the row.",
        prompt: [
          "Instruction: {{ trigger.data.instruction }}",
          "",
          "Row {{ index }}:",
          "{{ item }}",
          "",
          'Return JSON in a ```json block: { "label": ..., "rationale": ... }.',
        ].join("\n"),
        outputSchema: {
          type: "object",
          properties: {
            label: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["label", "rationale"],
        },
      },
    },
    {
      id: "rollup",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You summarize a batch. Report the counts first, then the distribution of labels, then any row " +
        "that failed. Quote the failure text as it was given to you.",
      prompt: [
        "Instruction that was applied: {{ trigger.data.instruction }}",
        "",
        "Rows given: {{ nodes.batch.result.inputCount }}",
        "Rows processed: {{ nodes.batch.result.completedCount }}",
        "Rows failed: {{ nodes.batch.result.failedCount }}",
        "Rows dropped because the 100-row cap was reached: {{ nodes.batch.result.truncatedCount }}",
        "",
        "Per-row results:",
        "{{ nodes.batch.result.items }}",
        "",
        "Write the summary in markdown. If any row was dropped by the cap, say so in the first line.",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "batch" },
    { from: "batch", to: "rollup" },
  ],
};

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "workflows.nightly-memory-sweep",
    name: "Nightly memory sweep",
    description:
      "Every night, your orchestrator merges duplicate memory entries, removes finished work that holds " +
      "no lasting fact, and reports what it changed. It needs no integration.",
    category: "maintenance",
    apps: ["claude"],
    steps: [
      "Search memory for entries that cover the same subject.",
      "Merge duplicates, keeping the newest facts and every open question.",
      "Remove finished work that holds no lasting fact.",
      "Report what was merged, removed, and left alone.",
    ],
    caveats: ["The sweep edits your memory. Read the first few reports before you leave it unattended."],
    definition: nightlyMemorySweep,
    schedule: {
      name: "Nightly memory sweep",
      cron: "0 6 * * *",
      timezone: "UTC",
      description: "Every day at 06:00 UTC",
    },
  },
  {
    id: "workflows.daily-triage-digest",
    name: "Daily triage digest",
    description:
      "Every weekday morning, read GitHub, Linear, and your joined Slack channels, then send one ranked " +
      "digest to your orchestrator.",
    category: "digest",
    apps: ["github", "linear", "slack", "claude"],
    steps: [
      "Search GitHub for pull requests that requested your review.",
      "Read the Linear issues assigned to you.",
      "List the Slack channels the connection has joined, then read recent messages in each.",
      "Write one ranked digest across all three.",
      "Send the digest to your orchestrator.",
    ],
    caveats: [
      "Reads up to 12 Slack channels per run. The digest reports how many were left out.",
      "Slack and Linear must be connected on your own account — a workflow run cannot see an org-wide connection.",
      "Linear tools resolve when the run starts, so a renamed Linear tool fails on the first run, not at install.",
      "Reads GitHub as you, not as the installed GitHub App.",
    ],
    definition: dailyTriageDigest,
    schedule: {
      name: "Daily triage digest",
      cron: "0 13 * * 1-5",
      timezone: "UTC",
      description: "Weekdays at 13:00 UTC",
    },
  },
  {
    id: "workflows.meeting-prep",
    name: "Weekly meeting prep",
    description:
      "Once a week, gather what is worth raising live — decisions needed, blockers, risks to a date, and " +
      "finished work — from GitHub, Linear, and threaded Slack discussions.",
    category: "digest",
    apps: ["github", "linear", "slack", "claude"],
    steps: [
      "Read your recent pull requests.",
      "Read the Linear issues assigned to you.",
      "Read the Slack discussions that drew replies, channel by channel.",
      "Select only what is worth saying out loud.",
      "Send four short sections to your orchestrator.",
    ],
    caveats: [
      "Reads up to 12 Slack channels per run. The brief reports how many were left out.",
      "Slack and Linear must be connected on your own account — a workflow run cannot see an org-wide connection.",
      "Linear tools resolve when the run starts, so a renamed Linear tool fails on the first run, not at install.",
      "Reads GitHub as you, not as the installed GitHub App.",
    ],
    definition: meetingPrep,
    schedule: {
      name: "Weekly meeting prep",
      cron: "0 15 * * 1",
      timezone: "UTC",
      description: "Mondays at 15:00 UTC",
    },
  },
  {
    id: "workflows.batch-over-rows",
    name: "Run one instruction over a batch",
    description:
      "Apply a single instruction to every row of a list — account tiering, vertical tagging, drafting one " +
      "artifact per customer — then summarize the batch. Runs on demand, up to 100 rows.",
    category: "batch",
    apps: ["claude"],
    steps: [
      "Paste the rows and write the instruction.",
      "Apply the instruction to each row on its own, three at a time.",
      "Collect a label and a reason for every row.",
      "Summarize the counts, the label distribution, and any failure.",
    ],
    caveats: [
      "Runs on demand only. It has no schedule, because a scheduled run cannot read the rows you type here.",
      "It processes the first 100 rows. The summary names how many were dropped.",
      "It produces judgments. It writes to no other system.",
    ],
    definition: batchOverRows,
  },
];
