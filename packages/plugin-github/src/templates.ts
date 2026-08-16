/**
 * GitHub workflow templates.
 *
 * Both templates read GitHub as the person who owns the workflow, never as
 * the installed application: every search uses the `@me` qualifier, which
 * only resolves against a user token, so each tool node pins
 * `credential: "user"` instead of taking the host's default precedence.
 *
 * Template-path rules these definitions obey (dag/v1):
 *   - a tool node's result IS the action's `data` payload, read at
 *     `nodes.<id>.result.<field>`;
 *   - an llm node WITHOUT `outputSchema` exposes prose at
 *     `nodes.<id>.result.text`, and WITH one exposes fields at
 *     `nodes.<id>.result.output.<field>`;
 *   - `trigger` is the whole trigger payload, so the run's own clock is
 *     `trigger.timestamp` — which is how a scheduled run knows today's date
 *     without an input.
 */
import type { WorkflowTemplate } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";

const dailyDevDigest: WorkflowDefinition = {
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
      params: { q: "is:open is:pr review-requested:@me archived:false", limit: 30 },
    },
    {
      id: "my_pull_requests",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Your own open pull requests",
      params: { q: "is:open is:pr author:@me archived:false", limit: 30 },
    },
    {
      id: "assigned_issues",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Issues assigned to you",
      params: { q: "is:open is:issue assignee:@me archived:false", limit: 30 },
    },
    {
      id: "digest",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You write a short morning digest for one engineer. Rank by what blocks other people first, " +
        "then by what blocks the reader. Name each item once. Give every item its URL. " +
        "If a section has nothing in it, write one line that says so and move on. Never invent an item.",
      prompt: [
        "The time now is {{ trigger.timestamp }}. Use it to judge how old each item is.",
        "",
        "## Reviews waiting on you",
        "{{ nodes.review_queue.result.items }}",
        "",
        "## Your open pull requests",
        "{{ nodes.my_pull_requests.result.items }}",
        "",
        "## Issues assigned to you",
        "{{ nodes.assigned_issues.result.items }}",
        "",
        "Write the digest in markdown, under 400 words, with one section per heading above.",
      ].join("\n"),
    },
    {
      id: "deliver",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "This is your daily development digest. Post it back to me as it is written.",
        "Do not act on any item, and do not open any pull request, unless I ask you to.",
        "",
        "{{ nodes.digest.result.text }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "review_queue" },
    { from: "start", to: "my_pull_requests" },
    { from: "start", to: "assigned_issues" },
    { from: "review_queue", to: "digest" },
    { from: "my_pull_requests", to: "digest" },
    { from: "assigned_issues", to: "digest" },
    { from: "digest", to: "deliver" },
  ],
};

const stalePullRequestNudge: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      id: "open_pull_requests",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Your open pull requests, with their last update time",
      params: { q: "is:open is:pr author:@me draft:false archived:false", sort: "updated", order: "asc", limit: 50 },
    },
    {
      id: "find_stale",
      type: "llm",
      model: "claude-haiku-4-5",
      system:
        "You find work that has gone quiet. A pull request is stale when its last update is more than " +
        "five days before the time you are given. Report only stale items. Report nothing else.",
      prompt: [
        "The time now is {{ trigger.timestamp }}.",
        "",
        "Open pull requests, with their updated_at times:",
        "{{ nodes.open_pull_requests.result.items }}",
        "",
        'Return JSON in a ```json block: { "staleItems": [ { "title": ..., "url": ..., "daysQuiet": ..., "reason": ... } ] }.',
        "Return an empty staleItems array when every pull request is recent.",
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          staleItems: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                daysQuiet: { type: "number" },
                reason: { type: "string" },
              },
              required: ["title", "url", "daysQuiet", "reason"],
            },
          },
        },
        required: ["staleItems"],
      },
    },
    {
      // The false branch has no successor on purpose. A week with nothing
      // stale completes the run with the nudge skipped, so the person gets
      // silence instead of an empty reminder.
      id: "anything_stale",
      type: "if",
      conditions: [
        {
          left: "nodes.find_stale.result.output.staleItems",
          dataType: "array",
          operation: "lengthGreaterThan",
          right: 0,
        },
      ],
    },
    {
      id: "nudge",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "These pull requests of mine have gone quiet. Tell me about them and ask me what I want to do.",
        "Do not comment on them, and do not close them.",
        "",
        "{{ nodes.find_stale.result.output.staleItems }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "open_pull_requests" },
    { from: "open_pull_requests", to: "find_stale" },
    { from: "find_stale", to: "anything_stale" },
    { from: "anything_stale", to: "nudge", fromOutput: "true" },
  ],
};

export const githubTemplates: WorkflowTemplate[] = [
  {
    id: "github.daily-dev-digest",
    name: "Daily development digest",
    description:
      "Every weekday morning, collect the reviews waiting on you, your own open pull requests, and the " +
      "issues assigned to you, then send one ranked digest to your orchestrator.",
    category: "digest",
    icon: "☀️",
    apps: ["github", "claude"],
    steps: [
      "Search GitHub for pull requests that requested your review.",
      "Search GitHub for your own open pull requests.",
      "Search GitHub for issues assigned to you.",
      "Write one ranked digest from all three lists.",
      "Send the digest to your orchestrator.",
    ],
    caveats: [
      "Reads GitHub as you, not as the installed GitHub App. Connect your personal GitHub account first.",
      "Covers only work that names you. It does not scan whole repositories.",
    ],
    definition: dailyDevDigest,
    schedule: {
      name: "Daily development digest",
      cron: "0 13 * * 1-5",
      timezone: "UTC",
      description: "Weekdays at 13:00 UTC",
    },
  },
  {
    id: "github.stale-pull-request-nudge",
    name: "Weekly nudge on quiet pull requests",
    description:
      "Once a week, find your open pull requests with no activity for five days and ask you what to do " +
      "with them. The run stays silent in a week when nothing has gone quiet.",
    category: "nudge",
    icon: "🔔",
    apps: ["github", "claude"],
    steps: [
      "Search GitHub for your open pull requests, oldest update first.",
      "Judge which ones have been quiet for more than five days.",
      "Stop the run when nothing is stale.",
      "Ask your orchestrator to raise the stale ones with you.",
    ],
    caveats: [
      "Reads GitHub as you, not as the installed GitHub App. Connect your personal GitHub account first.",
      "The nudge only reports. It never comments on a pull request and never closes one.",
    ],
    definition: stalePullRequestNudge,
    schedule: {
      name: "Weekly nudge on quiet pull requests",
      cron: "0 16 * * 1",
      timezone: "UTC",
      description: "Mondays at 16:00 UTC",
    },
  },
];
