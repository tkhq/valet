/**
 * GitHub workflow templates.
 *
 * Every GitHub call acts as the person who owns the workflow, never as the
 * installed application: the first two templates search with the `@me`
 * qualifier, which only resolves against a user token, and the third writes
 * comments that must carry a person's name rather than an application's. So
 * each GitHub tool node pins `credential: "user"` instead of taking the
 * host's default precedence. GitHub is also the only service that reads
 * that field — every other one refuses it rather than ignore it — so the
 * Slack node in the third template leaves it off and sends as the app.
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
 *
 * A scheduled run applies no `dataSchema` defaults, so a declared input has
 * to be gone by the time the schedule fires. Install closes that gap: it
 * refuses a scheduled template that has no value for a required field, then
 * rewrites `{{ trigger.data.<field> }}` to the literal value and drops the
 * field (`api/src/workflows/templates.ts`). That is what lets the routing
 * template take its repository and its threshold as configuration instead
 * of freezing them into the definition.
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

/**
 * Routes pull requests nobody has picked up.
 *
 * The shape of the problem decides the shape of the graph.
 *
 * There is no action that requests a reviewer — the plugin never calls
 * `POST /pulls/{n}/requested_reviewers` — so the delivery is a comment that
 * names the reviewer, plus a direct message to the same person. Slack has no
 * channel-posting action either, so the message is a DM.
 *
 * The routing table is a CSV file in a repository, not a list in this file.
 * An org changes who owns what far more often than it changes a workflow,
 * and a table that lives in a repository is reviewed like any other change.
 *
 * The run reads the table FIRST and stops when it is empty, because an empty
 * table maps every path to nobody: without that gate a broken configuration
 * would produce a run that posts nothing, reports nothing, and looks healthy.
 *
 * Only one step fans out per pull request, and it runs after the age filter
 * rather than over the whole search, because the search result carries no
 * changed-file list and reading one costs four GitHub calls.
 *
 * A pull request whose paths match no row is reported as unrouted and left
 * alone. A default reviewer would be the easy fallback and the wrong one: a
 * wrongly routed pull request wastes the time of two people and teaches the
 * team to ignore the workflow.
 */
const unclaimedPullRequestRouting: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        repositoryOwner: {
          type: "string",
          required: true,
          label: "Repository owner",
          placeholder: "your-org",
          description: "The account or organization that holds the repository to sweep.",
        },
        repositoryName: {
          type: "string",
          required: true,
          label: "Repository name",
          placeholder: "platform",
          description: "One repository per install. Install the template again for a second repository.",
        },
        routingOwner: {
          type: "string",
          required: true,
          label: "Routing file owner",
          placeholder: "your-org",
          description: "The account or organization that holds the routing file. It can be the same one.",
        },
        routingRepository: {
          type: "string",
          required: true,
          label: "Routing file repository",
          placeholder: "handbook",
          description: "The repository that holds the routing file. Your GitHub account must be able to read it.",
        },
        routingPath: {
          type: "string",
          required: true,
          default: ".github/reviewer-routing.csv",
          label: "Routing file path",
          placeholder: ".github/reviewer-routing.csv",
          description: "A CSV file with the columns path_prefix, area, github_handle, slack_user_id.",
        },
        minimumOpenDays: {
          type: "number",
          required: true,
          default: 2,
          label: "Days open before a pull request is routed",
          description: "A younger pull request is left alone, so its author keeps the first chance to pick a reviewer.",
        },
      },
    },
    {
      id: "routing_table",
      type: "tool",
      service: "github",
      action: "read_repo_file",
      credential: "user",
      summary: "Read the file that maps a path to an owning area and a person",
      params: {
        owner: "{{ trigger.data.routingOwner }}",
        repo: "{{ trigger.data.routingRepository }}",
        path: "{{ trigger.data.routingPath }}",
      },
    },
    {
      // `review:none` drops every pull request a reviewer has already
      // answered. Oldest first matters more than it looks: the search
      // returns one page and cannot ask for a second, so whatever the limit
      // cuts must be the recent end of the list, not the neglected end this
      // workflow exists to find.
      id: "open_pull_requests",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Open pull requests with no review yet, oldest first",
      params: {
        q:
          "repo:{{ trigger.data.repositoryOwner }}/{{ trigger.data.repositoryName }} " +
          "is:open is:pr draft:false archived:false review:none",
        sort: "created",
        order: "asc",
        limit: 50,
      },
    },
    {
      // An empty file reads back with no error at all. Every later step
      // would then behave itself and route nothing, so the failure has to
      // be made here.
      id: "routing_table_readable",
      type: "if",
      conditions: [
        { left: "nodes.routing_table.result.content", dataType: "string", operation: "isNotEmpty" },
      ],
    },
    {
      id: "no_routing_table",
      type: "stop",
      outcome: "failure",
      message:
        "The routing file {{ trigger.data.routingPath }} in {{ trigger.data.routingOwner }}/" +
        "{{ trigger.data.routingRepository }} is empty, so no pull request can be routed. Put one row in it " +
        "for each owned path, with the columns path_prefix, area, github_handle, slack_user_id, then run the " +
        "workflow again.",
    },
    {
      id: "unclaimed",
      type: "llm",
      model: "claude-haiku-4-5",
      system:
        "You select pull requests that have waited long enough to need a reviewer. You judge age and " +
        "nothing else. You never invent a pull request, and you never report one that is not in the list.",
      prompt: [
        "The time now is {{ trigger.timestamp }}.",
        "A pull request qualifies when it was created more than {{ trigger.data.minimumOpenDays }} days before that time.",
        "",
        "Open pull requests with no review, with their created_at times:",
        "{{ nodes.open_pull_requests.result.items }}",
        "",
        'Return JSON in a ```json block: { "candidates": [ { "number": ..., "url": ..., "daysOpen": ... } ] }.',
        "Return an empty candidates array when every pull request is younger than the threshold.",
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "number" },
                url: { type: "string" },
                daysOpen: { type: "number" },
              },
              required: ["number", "url", "daysOpen"],
            },
          },
        },
        required: ["candidates"],
      },
    },
    {
      // The routing decision needs the paths a pull request touches, and the
      // search result carries none of them. This step also reads back who is
      // already requested or assigned, which is the last thing that can say
      // "someone owns this" before a comment goes out.
      id: "changed_paths",
      type: "foreach",
      items: "{{ nodes.unclaimed.result.output.candidates }}",
      maxItems: 20,
      concurrency: 3,
      // Independent pull requests: one deleted branch must not stop the rest.
      onItemError: "collect",
      body: {
        id: "inspect_pull_request",
        type: "tool",
        service: "github",
        action: "inspect_pull_request",
        credential: "user",
        summary: "Read one pull request's changed paths and its current reviewers",
        params: {
          owner: "{{ trigger.data.repositoryOwner }}",
          repo: "{{ trigger.data.repositoryName }}",
          pullNumber: "{{ item.number }}",
          filesLimit: 50,
        },
      },
    },
    {
      id: "route",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You route an unclaimed pull request to the area that owns the files it changes. The routing file " +
        "is your only source of an owner. You never guess a person, you never use a row you did not match, " +
        "and you never name anybody the routing file does not name. An unrouted pull request costs less " +
        "than a wrongly routed one.",
      prompt: [
        "The routing file is CSV with a header row and the columns path_prefix, area, github_handle, slack_user_id.",
        "A row owns a file when the file path starts with that row's path_prefix. The longest matching prefix wins.",
        "",
        "Routing file:",
        "{{ nodes.routing_table.result.content }}",
        "",
        "The pull requests that were selected, in order, each with its number and its URL:",
        "{{ nodes.unclaimed.result.output.candidates }}",
        "",
        "What was read back for each one, in the SAME order. An entry holds a status, and a data object",
        "with the pull request in it when the read succeeded:",
        "{{ nodes.changed_paths.result.items }}",
        "",
        "Take the entries one at a time. Take the number and the URL from the selected list at the same position.",
        "1. If the entry's status is not completed, the pull request could not be read. Add it to unrouted, with the entry's error as the reason.",
        "2. Drop it when requested_reviewers, requested_teams, or assignees is not empty. Somebody already owns it.",
        "3. Match every changed path against the routing file. Count the matched files for each area. The area with the most matched files wins. The longest prefix breaks a tie.",
        "4. If no changed path matches any row, add the pull request to unrouted, and give the paths that matched nothing as the reason. Do not pick a row you did not match.",
        "5. Otherwise add it to routed, with the github_handle and the slack_user_id from the winning row.",
        "",
        "Write two pieces of text for each routed pull request.",
        "comment: a GitHub comment under 80 words. Open with the handle, written with a leading @. Say in one sentence what the pull request changes, from its title, its description and its changed files. Name the area that owns it and the paths that matched. Close by asking the reader to correct {{ trigger.data.routingPath }} in {{ trigger.data.routingOwner }}/{{ trigger.data.routingRepository }} if the area is wrong.",
        "message: a Slack message under 60 words. Give the pull request URL, what it changes, why it came to this person, and how many files and lines it touches. Do not repeat the comment word for word.",
        "",
        'Return JSON in a ```json block: { "routed": [ ... ], "unrouted": [ ... ] }.',
        "Return both arrays every time. Return an empty array for the one that has nothing in it.",
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          routed: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "number" },
                url: { type: "string" },
                area: { type: "string" },
                githubHandle: { type: "string" },
                slackUserId: { type: "string" },
                comment: { type: "string" },
                message: { type: "string" },
              },
              required: ["number", "url", "area", "githubHandle", "slackUserId", "comment", "message"],
            },
          },
          unrouted: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "number" },
                url: { type: "string" },
                reason: { type: "string" },
              },
              required: ["number", "url", "reason"],
            },
          },
        },
        required: ["routed", "unrouted"],
      },
    },
    {
      // The false branch has no successor on purpose: a day with nothing
      // unclaimed and nothing unrouted ends in silence. The gate takes both
      // lists, because a run that routed nothing and found three owner-less
      // pull requests still has something the workflow owner must see.
      id: "anything_found",
      type: "if",
      combinator: "or",
      conditions: [
        { left: "nodes.route.result.output.routed", dataType: "array", operation: "lengthGreaterThan", right: 0 },
        { left: "nodes.route.result.output.unrouted", dataType: "array", operation: "lengthGreaterThan", right: 0 },
      ],
    },
    {
      // The comment goes out before the message on purpose. The message
      // tells the reviewer to read a comment, so a message that arrives
      // first can point at a comment that failed to post.
      id: "comment",
      type: "foreach",
      items: "{{ nodes.route.result.output.routed }}",
      maxItems: 10,
      concurrency: 2,
      onItemError: "collect",
      body: {
        id: "post_comment",
        type: "tool",
        service: "github",
        action: "create_comment",
        credential: "user",
        summary: "Name the reviewer on the pull request, with the context behind the choice",
        params: {
          owner: "{{ trigger.data.repositoryOwner }}",
          repo: "{{ trigger.data.repositoryName }}",
          issueNumber: "{{ item.number }}",
          body: "{{ item.comment }}",
        },
      },
    },
    {
      id: "notify",
      type: "foreach",
      items: "{{ nodes.route.result.output.routed }}",
      maxItems: 10,
      concurrency: 2,
      // A stale id in the routing file fails its own message. Collecting the
      // failure keeps the other reviewers told.
      onItemError: "collect",
      body: {
        // No `credential` here. Only github resolves an identity for a tool
        // node (`api/src/plugins/action-invoker.ts`), and slack refuses the
        // field rather than accept a selection it would ignore.
        id: "send_dm",
        type: "tool",
        service: "slack",
        action: "dm_user",
        summary: "Send the reviewer the same context on Slack",
        params: {
          user: "{{ item.slackUserId }}",
          text: "{{ item.message }}",
        },
      },
    },
    {
      id: "report",
      type: "orchestrator",
      wait: { mode: "until_idle" },
      prompt: [
        "I routed the unclaimed pull requests in {{ trigger.data.repositoryOwner }}/{{ trigger.data.repositoryName }}.",
        "Report this back to me in one short paragraph. Do not comment on a pull request and do not open one.",
        "",
        "Start with the pull requests that matched no owner. They are the ones I have to fix in the routing file:",
        "{{ nodes.route.result.output.unrouted }}",
        "",
        "Then the ones that were routed:",
        "{{ nodes.route.result.output.routed }}",
        "",
        "Comments posted: {{ nodes.comment.result.completedCount }} of {{ nodes.comment.result.inputCount }}. Failed: {{ nodes.comment.result.failedCount }}.",
        "Slack messages sent: {{ nodes.notify.result.completedCount }} of {{ nodes.notify.result.inputCount }}. Failed: {{ nodes.notify.result.failedCount }}.",
        "",
        "Say it in the first line if any of these dropped work:",
        "Pull requests left unread by the per-run cap: {{ nodes.changed_paths.result.truncatedCount }}",
        "Comments dropped by the per-run cap: {{ nodes.comment.result.truncatedCount }}",
        "Slack messages dropped by the per-run cap: {{ nodes.notify.result.truncatedCount }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "routing_table" },
    { from: "start", to: "open_pull_requests" },
    { from: "routing_table", to: "routing_table_readable" },
    { from: "routing_table_readable", to: "no_routing_table", fromOutput: "false" },
    // `unclaimed` waits for the gate as well as the search, so an unusable
    // routing file stops the run before it spends a single per-pull-request
    // call.
    { from: "routing_table_readable", to: "unclaimed", fromOutput: "true" },
    { from: "open_pull_requests", to: "unclaimed" },
    { from: "unclaimed", to: "changed_paths" },
    { from: "changed_paths", to: "route" },
    { from: "route", to: "anything_found" },
    { from: "anything_found", to: "comment", fromOutput: "true" },
    { from: "comment", to: "notify" },
    { from: "notify", to: "report" },
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
  {
    id: "github.unclaimed-pull-request-routing",
    name: "Route unclaimed pull requests",
    description:
      "Every weekday, find the open pull requests in one repository that nobody has picked up, work out which " +
      "area owns the files they change, and hand each one to that area's reviewer with a note on what it " +
      "changes and why it came to them. It needs GitHub and Slack connected on your own account, and a CSV " +
      "routing file in a repository you can read.",
    category: "nudge",
    apps: ["github", "slack", "claude"],
    steps: [
      "Read the routing file that maps a path prefix to an owning area, a GitHub handle, and a Slack user id.",
      "Search the repository for open pull requests that nobody has reviewed, oldest first.",
      "Keep the ones that have been open longer than your threshold.",
      "Read the files each one changes, and who is already requested or assigned.",
      "Match the changed paths to an owning area, and that area to a person.",
      "Comment on the pull request naming that person, with what it changes and why it came to them.",
      "Send that person the same context in a Slack message.",
      "Report what was routed, and what matched no owner, to your orchestrator.",
    ],
    caveats: [
      "It comments on GitHub as you, not as an installed application. The Slack message arrives from the app, not from you.",
      "Slack must be connected on your own account. A workflow run cannot see an org-wide connection.",
      "GitHub reviewer requests are not among this plugin's actions, so the workflow names the reviewer in a comment. Nobody is assigned, and the pull request's reviewer list does not change.",
      "A pull request whose paths match no row is reported to you and left alone. It never falls back to a default reviewer.",
      "Each run reads at most 20 pull requests and routes at most 10 of them. The report names what the caps dropped.",
      "An empty routing file fails the run and names the file to correct. A missing one fails the same way.",
      "A slack_user_id in the routing file is the id form (U... or W...), not an email address and not a display name. A stale id fails that one message and leaves the others.",
      "It sweeps one repository per install. Install it again for a second repository.",
    ],
    definition: unclaimedPullRequestRouting,
    schedule: {
      name: "Route unclaimed pull requests",
      cron: "0 15 * * 1-5",
      timezone: "UTC",
      description: "Weekdays at 15:00 UTC",
    },
  },
];
