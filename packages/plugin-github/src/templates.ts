/**
 * GitHub workflow templates.
 *
 * The first three templates act as the person who owns the workflow: two of
 * them search with the `@me` qualifier, which only resolves against a user
 * token, and the third writes comments that must carry a person's name
 * rather than an application's. So each of their GitHub tool nodes pins
 * `credential: "user"` instead of taking the host's default precedence.
 * GitHub is also the only service that reads that field — every other one
 * refuses it rather than ignore it — so the Slack node in the third
 * template leaves it off and sends as the app.
 *
 * The fourth template inverts that choice and pins `credential: "app"`
 * everywhere. It posts a machine-written code review, and a machine-written
 * review that carries a person's name reads as that person's judgement. The
 * `app` selection also has no fallback (`api/src/plugins/action-invoker.ts`),
 * so a deployment with no installed application fails the step visibly
 * instead of signing the review with the workflow owner's account.
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

/**
 * The maximum number of changed files this workflow will read a diff for.
 *
 * Above it the run posts a short note and reviews nothing. A partial review
 * of a 300-file pull request is the failure this number exists to prevent:
 * it reads as a whole review, and the files it never opened are the ones
 * nobody looks at twice.
 */
const MAX_CHANGED_FILES = 60;

/**
 * Byte budget for the diff text fed to the model, and the file count above
 * it.
 *
 * 120 KB of patch is roughly 30,000 input tokens. `inspect_pull_request`
 * spends the budget in file order, marks every file it cut short or left
 * out, and returns the counts in `patch_summary` — which is what lets the
 * review body state its own coverage instead of implying full coverage.
 */
const PATCH_BYTES = 120000;

/** The file list is fetched before the cap above is applied, so fetching
 * more than the cap allows would only pay for files the run then discards. */
const FILES_LIMIT = MAX_CHANGED_FILES;

/**
 * Findings per review.
 *
 * The prompt asks for the cap and `outputSchema` enforces it. The prompt
 * alone would not: `github.create_review` takes an unbounded comment array
 * and forwards every element, so a verbose model on a 55-file pull request
 * would post 60 inline comments while the caveats promised 20. `maxItems`
 * is checked by the same `Value.Check` that validates the rest of the
 * output, so an over-long reply costs one repair round instead of turning
 * a documented cap into a false claim.
 */
const MAX_FINDINGS = 20;

/**
 * The coverage block every posted review carries.
 *
 * Every number here comes from the inspect step, never from the model, so
 * the block cannot overstate what the run read.
 *
 * Two distinctions the wording has to keep. `matched_file_count` counts the
 * files whose METADATA was fetched — `attachPatches` marks a file it could
 * not afford `patch_omitted` instead of dropping it, so the count never
 * shrinks. Saying the run "read" that many files would report full coverage
 * on a pull request whose budget covered a tenth of it. So this block says
 * "fetched", and lets the cut-short and not-read counts carry the truth.
 *
 * The block names no filenames. The names of the unread files exist only in
 * `files[*].patch_truncated`, and the dag/v1 expression language has no map
 * or filter to pull them out (`dag/expression.ts`: no function calls beyond
 * `exists`). Asking the model for the list instead was the earlier design,
 * and it put a guess next to a measurement: a model that wrote "none" while
 * three files went unread produced a block that contradicted itself two
 * lines apart. A count the run can prove beats a name list it cannot.
 */
const COVERAGE_REPORT = [
  "---",
  "",
  "Automated review by Valet. It fetched {{ nodes.inspect.result.matched_file_count }} of " +
    "{{ nodes.inspect.result.changed_files }} changed files, against a " +
    "{{ nodes.inspect.result.patch_summary.limit_bytes }}-byte diff budget. Of the files it " +
    "fetched, the diff was cut short in " +
    "{{ nodes.inspect.result.patch_summary.truncated_files }} and was not read at all in " +
    "{{ nodes.inspect.result.patch_summary.omitted_files }}. A file in either count was not " +
    "reviewed.",
  "",
  "This review reads the diff and the pull request. It does not open an unchanged file, so it " +
    "cannot judge a caller it never saw. It never approves a pull request.",
].join("\n");

/**
 * Reviews one pull request when a GitHub event names it.
 *
 * This is the first event-driven template in the gallery, and the event is
 * what shapes the graph.
 *
 * A dag/v1 definition does not name its own trigger — `TriggerNode` carries
 * an id, a type, and an optional `dataSchema`, and the payload's `type` is
 * set by whoever starts the run. So this definition declares one hidden
 * `payload` field and reads the webhook body under it. An event run puts
 * `{ key, summary, refs, payload }` in `trigger.data`
 * (`api/src/events/dispatcher.ts`), which is why every repository and pull
 * request value here is a `trigger.data.payload.…` path.
 *
 * Install cannot arm that trigger. `WorkflowTemplate` has no field for an
 * event subscription and `installWorkflowTemplate` writes none, so the
 * installed workflow is inert until a person adds the trigger by hand. The
 * caveats say so first, because a workflow that looks installed and never
 * fires is worse than one that refuses to install.
 *
 * `policy.onUnresolvedPath: "fail"` is what stops a run started by hand
 * from posting half a review built out of empty strings. The first gate is
 * an `if` node rather than a template read, because `if` conditions are
 * exempt from that policy — that is what lets the run answer "this was not
 * started by a pull request event" with a corrective message instead of an
 * unresolved-path error.
 *
 * The reviewing work is an `llm` node over the diff, not a `session` node
 * over a clone. A session node cannot be pointed at a repository today
 * (`SessionNode` is start-mode only, `dag/nodes.ts`), and an agent loop
 * over a live sandbox has no bounded per-event cost — one push to a busy
 * repository would boot a sandbox. One model call over a byte-capped diff
 * has a cost a person can read off this file before they install.
 */
const pullRequestReview: WorkflowDefinition = {
  version: "dag/v1",
  // A hand-started run has no webhook body. Without this, every
  // `trigger.data.payload.…` path renders empty and the run posts a review
  // written from nothing. With it, the node fails before it calls GitHub.
  policy: { onUnresolvedPath: "fail" },
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        payload: {
          type: "object",
          hidden: true,
          description:
            "The GitHub pull_request webhook body. An event trigger maps it in; nobody types it.",
        },
      },
    },
    {
      // Not a template read: an `if` condition is exempt from
      // `onUnresolvedPath: "fail"`, so this is the one place that can ask
      // whether the payload arrived and answer with an instruction.
      id: "started_by_event",
      type: "if",
      conditions: [
        { left: "trigger.data.payload.pull_request.number", dataType: "number", operation: "exists" },
      ],
    },
    {
      id: "no_pull_request",
      type: "stop",
      outcome: "failure",
      message:
        "This workflow reviews the pull request a GitHub event names, and this run carried no " +
        "pull request. Open the workflow, then Triggers, then New trigger, and subscribe it to " +
        "github.pull_request.opened, github.pull_request.synchronize, " +
        "github.pull_request.reopened and github.pull_request.ready_for_review.",
    },
    {
      // Three reasons to leave a pull request alone, and all three are in
      // the event payload, so none of them costs a GitHub call.
      //
      // The bot check is the loop guard. Subscription filters cannot do it:
      // the matcher offers eq, in, prefix and contains, with no negation
      // (`api/src/events/match.ts`), so "not a bot" has to be a node.
      id: "worth_reviewing",
      type: "if",
      conditions: [
        { left: "trigger.data.payload.pull_request.state", dataType: "string", operation: "equals", right: "open" },
        { left: "trigger.data.payload.pull_request.draft", dataType: "boolean", operation: "isFalse" },
        {
          left: "trigger.data.payload.pull_request.user.login",
          dataType: "string",
          operation: "doesNotContain",
          right: "[bot]",
        },
      ],
    },
    {
      id: "not_reviewed",
      type: "stop",
      outcome: "success",
      message:
        "Pull request {{ trigger.data.payload.pull_request.number }} was not reviewed. It is " +
        "closed, it is a draft, or an application opened it. Mark a draft ready for review to " +
        "start a review.",
    },
    {
      id: "inspect",
      type: "tool",
      service: "github",
      action: "inspect_pull_request",
      credential: "app",
      summary: "Read the pull request, its diff, and the review comments already on it",
      params: {
        owner: "{{ trigger.data.payload.repository.owner.login }}",
        repo: "{{ trigger.data.payload.repository.name }}",
        pullNumber: "{{ trigger.data.payload.pull_request.number }}",
        includePatch: true,
        patchBytesLimit: PATCH_BYTES,
        filesLimit: FILES_LIMIT,
        commentsLimit: 50,
      },
    },
    {
      // The gate is on the repository's own `changed_files` count, taken
      // before the model call. Gating after it would spend the tokens and
      // then refuse to use them.
      id: "within_diff_cap",
      type: "if",
      conditions: [
        {
          left: "nodes.inspect.result.changed_files",
          dataType: "number",
          operation: "lessThanOrEqual",
          right: MAX_CHANGED_FILES,
        },
      ],
    },
    {
      // `updateExisting` replaces this action's own previous note instead
      // of adding another one, which it can do here because this review
      // carries no inline comments. Every further push to the same oversized
      // pull request rewrites one comment.
      id: "report_too_large",
      type: "tool",
      service: "github",
      action: "create_review",
      credential: "app",
      summary: "Say that the pull request is too large to review, and post nothing else",
      params: {
        owner: "{{ trigger.data.payload.repository.owner.login }}",
        repo: "{{ trigger.data.payload.repository.name }}",
        pullNumber: "{{ trigger.data.payload.pull_request.number }}",
        event: "COMMENT",
        updateExisting: true,
        updateKey: "valet-review-size",
        body:
          "This pull request changes {{ nodes.inspect.result.changed_files }} files. The " +
          `automated review reads at most ${MAX_CHANGED_FILES}, so it read none of them and ` +
          "found nothing. A review of part of a change is worse than no review, because the " +
          "part nobody read looks reviewed.\n\n" +
          "Split the pull request, or review it by hand.",
      },
    },
    {
      id: "review",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You review one pull request diff. You report a finding only when you can name the file " +
        "and the line it is on, and only when that line is one the pull request added or " +
        "changed. You never write a finding that says a reader should consider something; you " +
        "name the failure it causes. You never report a finding you are not confident in — a " +
        "wrong finding costs the author more time than a missed one. You have the diff and " +
        "nothing else: you cannot see an unchanged file, a caller, or a type definition, so you " +
        "never claim something about code that is not in front of you.",
      prompt: [
        "Repository: {{ trigger.data.payload.repository.owner.login }}/{{ trigger.data.payload.repository.name }}",
        "Pull request {{ nodes.inspect.result.number }}: {{ nodes.inspect.result.title }}",
        "Base branch: {{ nodes.inspect.result.base.ref }}. Head commit: {{ nodes.inspect.result.head.sha }}.",
        "It changes {{ nodes.inspect.result.changed_files }} files, {{ nodes.inspect.result.additions }} lines added and {{ nodes.inspect.result.deletions }} removed.",
        "",
        "Description:",
        "{{ nodes.inspect.result.body }}",
        "",
        "Changed files. Each entry holds the path, the counts, and a `patch` with the unified diff.",
        "An entry with `patch_truncated` holds the first part of its diff only. An entry with",
        "`patch_omitted` holds no diff at all. Neither can be reviewed, and you must not guess at",
        "what they contain:",
        "{{ nodes.inspect.result.files }}",
        "",
        "Review comments already on this pull request. Do not repeat a point one of these makes:",
        "{{ nodes.inspect.result.comments }}",
        "",
        "Grade every finding:",
        "- Blocker: a correctness bug, a security hole, data loss, or a breaking change.",
        "- Major: a likely bug, a missed edge case, or a performance loss on a hot path.",
        "- Minor: readability, naming, a small refactor, a missing test.",
        "Drop anything below Minor. Style preference is not a finding.",
        "",
        'Set verdict to "REQUEST_CHANGES" when there is at least one Blocker, or a Major you are',
        'sure of. Otherwise set it to "COMMENT". There is no approving verdict.',
        "",
        "Rules for each finding:",
        "1. Take `line` from the diff of the file it names. GitHub rejects the whole review when",
        "   one line is not in that diff, so a line you are unsure of costs every other finding.",
        "2. Anchor to a line the pull request added or changed, never to an unchanged line.",
        `3. Write at most ${MAX_FINDINGS} findings. Keep the most serious ones.`,
        "4. Open each `body` with the grade in bold, then one sentence naming the failure, then",
        "   what to do. Add a ```suggestion block when the fix is mechanical.",
        "",
        "Write `summary` as 2 to 5 sentences of markdown: what the pull request does, and what",
        "the findings add up to. Do not list the findings in it.",
        "",
        "Write `findingsMarkdown` as the same findings in a markdown list, one per line, each as",
        "`- **Grade** `path:line` — the failure, then the fix`. It is used only when the inline",
        "comments cannot be posted, so it has to stand on its own.",
        "",
        'Return JSON in a ```json block with the keys verdict, summary, findings and findingsMarkdown.',
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES"] },
          summary: { type: "string" },
          findings: {
            type: "array",
            // The cap is enforced here, not only asked for in the prompt.
            // `create_review` forwards every comment it is given.
            maxItems: MAX_FINDINGS,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "number" },
                body: { type: "string" },
              },
              required: ["path", "line", "body"],
            },
          },
          findingsMarkdown: { type: "string" },
        },
        required: ["verdict", "summary", "findings", "findingsMarkdown"],
      },
    },
    {
      // Two pushes are two deliveries and two runs — event idempotency is
      // per delivery, and nothing debounces. Re-reading the head SHA after
      // the model call is what collapses a burst back to one review: the
      // run that reviewed an overtaken commit posts nothing, and the run
      // that reviewed the newest one posts.
      id: "recheck_head",
      type: "tool",
      service: "github",
      action: "inspect_pull_request",
      credential: "app",
      summary: "Read the head commit again, to see whether a newer push landed during the review",
      params: {
        owner: "{{ trigger.data.payload.repository.owner.login }}",
        repo: "{{ trigger.data.payload.repository.name }}",
        pullNumber: "{{ trigger.data.payload.pull_request.number }}",
        filesLimit: 1,
        commentsLimit: 1,
      },
    },
    {
      // The whole comparison is the `left` expression: an `if` condition's
      // `right` is a literal and is never rendered, so two moving values
      // can only be compared inside one expression.
      id: "head_unchanged",
      type: "if",
      conditions: [
        {
          left: "nodes.recheck_head.result.head.sha == trigger.data.payload.pull_request.head.sha",
          dataType: "boolean",
          operation: "isTrue",
        },
      ],
    },
    {
      id: "superseded",
      type: "stop",
      outcome: "success",
      message:
        "Nothing was posted. A newer commit ({{ nodes.recheck_head.result.head.sha }}) landed on " +
        "pull request {{ trigger.data.payload.pull_request.number }} while this review was being " +
        "written, and the run started by that commit reviews it instead.",
    },
    {
      // `onError: "continue"` is what makes the next gate reachable.
      // GitHub answers 422 and rejects the WHOLE review when one comment
      // names a line outside the diff, so without a fallback one bad line
      // number means the pull request gets no review and nobody is told.
      //
      // `onDeny: "skip"` is what keeps a refusal apart from a rejection.
      // `create_review` is a medium-risk action, so an org policy can raise
      // an approval gate on it. Under the default `onDeny: "fail"` a denied
      // gate writes the same `failed` checkpoint a 422 writes, and
      // `onError: "continue"` tolerates both identically — so the run would
      // answer "a person refused this" by asking again for the same text
      // through the fallback. `"skip"` completes the node with
      // `policyDenied: true` instead, which the next node can read: a
      // tolerated FAILURE contributes `nodes.<id>.error` and no `result`,
      // and the validator rejects `.error` paths, so a readable `result`
      // field is the only way to tell the two outcomes apart.
      id: "post_review",
      type: "tool",
      service: "github",
      action: "create_review",
      credential: "app",
      onError: "continue",
      onDeny: "skip",
      summary: "Post one review, with every finding anchored to its line",
      params: {
        owner: "{{ trigger.data.payload.repository.owner.login }}",
        repo: "{{ trigger.data.payload.repository.name }}",
        pullNumber: "{{ trigger.data.payload.pull_request.number }}",
        event: "{{ nodes.review.result.output.verdict }}",
        // The SHA the diff was read at, not the SHA at post time. The gate
        // above proves they are the same; pinning it keeps them the same if
        // a push lands in the seconds between.
        commitId: "{{ nodes.inspect.result.head.sha }}",
        comments: "{{ nodes.review.result.output.findings }}",
        body: "{{ nodes.review.result.output.summary }}\n\n" + COVERAGE_REPORT,
      },
    },
    {
      // Reached before the fallback gate, because a refusal must not fall
      // through to it. `policyDenied` is set only by `onDeny: "skip"`, so
      // this is true for a denied gate and for one that timed out, and
      // absent for every other outcome.
      id: "posting_denied",
      type: "if",
      conditions: [
        { left: "nodes.post_review.result.policyDenied", dataType: "boolean", operation: "exists" },
      ],
    },
    {
      // A denial is the end of the run. Posting the same findings through
      // the fallback would ask a second time for what a person just
      // refused, and reviewer fatigue is how that becomes a real bypass.
      id: "review_not_posted",
      type: "stop",
      outcome: "failure",
      message:
        "Nothing was posted. The review step needs approval, and the request was denied or it " +
        "timed out. The findings are on this run's review step. To post them, run the workflow " +
        "again and approve the step. To stop the request from being asked every time, " +
        "pre-approve github.create_review for this workflow.",
    },
    {
      id: "inline_comments_accepted",
      type: "if",
      conditions: [
        { left: "nodes.post_review.result.review_id", dataType: "number", operation: "exists" },
      ],
    },
    {
      // The degraded form: same findings, same verdict, no anchors. It
      // keeps the run's output in front of the author, which is the whole
      // point of not dropping a finding GitHub would not place.
      //
      // The body names no cause. This node runs whenever `post_review`
      // produced no review id, and a bad line anchor is only the most
      // likely reason among many — a 403, a secondary rate limit, an
      // action timeout, an archived repository, a body over GitHub's
      // 65536-character limit. The run cannot read its own failure
      // (`nodes.<id>.error` is rejected by the validator), so it states
      // what it knows and does not guess at what it does not.
      id: "post_review_body_only",
      type: "tool",
      service: "github",
      action: "create_review",
      credential: "app",
      summary: "Post the same findings in the review body, after GitHub rejected the line anchors",
      params: {
        owner: "{{ trigger.data.payload.repository.owner.login }}",
        repo: "{{ trigger.data.payload.repository.name }}",
        pullNumber: "{{ trigger.data.payload.pull_request.number }}",
        event: "{{ nodes.review.result.output.verdict }}",
        commitId: "{{ nodes.inspect.result.head.sha }}",
        body: [
          "{{ nodes.review.result.output.summary }}",
          "",
          "The inline comments could not be posted, so the findings are below instead, each with " +
            "the file and the line it belongs to. A line that is not in this pull request's diff " +
            "is the usual reason.",
          "",
          "{{ nodes.review.result.output.findingsMarkdown }}",
          "",
          COVERAGE_REPORT,
        ].join("\n"),
      },
    },
  ],
  edges: [
    { from: "start", to: "started_by_event" },
    { from: "started_by_event", to: "no_pull_request", fromOutput: "false" },
    { from: "started_by_event", to: "worth_reviewing", fromOutput: "true" },
    { from: "worth_reviewing", to: "not_reviewed", fromOutput: "false" },
    { from: "worth_reviewing", to: "inspect", fromOutput: "true" },
    { from: "inspect", to: "within_diff_cap" },
    { from: "within_diff_cap", to: "report_too_large", fromOutput: "false" },
    { from: "within_diff_cap", to: "review", fromOutput: "true" },
    { from: "review", to: "recheck_head" },
    { from: "recheck_head", to: "head_unchanged" },
    { from: "head_unchanged", to: "superseded", fromOutput: "false" },
    { from: "head_unchanged", to: "post_review", fromOutput: "true" },
    { from: "post_review", to: "posting_denied" },
    { from: "posting_denied", to: "review_not_posted", fromOutput: "true" },
    { from: "posting_denied", to: "inline_comments_accepted", fromOutput: "false" },
    // The true branch has no successor on purpose: an accepted review is
    // the end of the run.
    { from: "inline_comments_accepted", to: "post_review_body_only", fromOutput: "false" },
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
  {
    id: "github.pull-request-review",
    name: "Review a pull request when it opens or updates",
    description:
      "When a GitHub pull_request event arrives, read the pull request and its diff, then post one " +
      "review with the findings anchored to the lines they belong to. It arms no schedule: you add " +
      "the event trigger yourself after you install it.",
    category: "review",
    apps: ["github", "claude"],
    steps: [
      "Stop when the run did not come from a pull request event, and say which trigger to add.",
      "Stop when the pull request is closed, is a draft, or was opened by an application.",
      "Read the pull request, its diff, and the review comments already on it.",
      "Stop before the model call when the pull request changes more than 60 files, and say so on the pull request.",
      "Read the diff and write findings, each one anchored to a file and a line.",
      "Read the head commit again, and post nothing when a newer push landed during the review.",
      "Post one review with the findings inline, a summary, and a count of what was not read.",
      "Move the findings into the review body when the inline comments cannot be posted.",
    ],
    caveats: [
      "Installing it does not start it. Open the installed workflow, then Triggers, then New trigger, and subscribe it to github.pull_request.opened, github.pull_request.synchronize, github.pull_request.reopened and github.pull_request.ready_for_review. Until you do, it never runs.",
      "Set the trigger's repo filter. Without one it reviews every pull request in every repository the webhook reaches.",
      "The review is advisory and it never approves. The create_review action offers COMMENT and REQUEST_CHANGES only, because an approving review can satisfy branch protection, which is a merge authorization rather than a review remark.",
      "It posts as the installed GitHub App, not as you, so nobody mistakes it for a colleague's review. If your organization has no GitHub App installed for the repository, the posting step fails and the run says so. Connecting your own GitHub account is still what the install checks for.",
      "It reads the diff and the pull request, and nothing else. It never opens an unchanged file, so it cannot tell you whether a changed function's callers still hold.",
      "Each run makes one model call over at most 60 files and 120,000 bytes of diff, which is roughly 30,000 input tokens, plus the pull request description and up to 50 existing review comments. When the model's first reply does not match the expected shape, the run makes a second call that repeats the whole prompt, so the worst case is about twice that. Every push to every open pull request starts a run, so a busy repository is a real bill.",
      "A run that hits the diff budget says so in the review body: how many files it fetched, in how many the diff was cut short, and in how many it read no diff at all. It never presents a partial read as a whole one. It reports counts and not filenames, because only the counts are measured rather than written by the model.",
      "A pull request that changes more than 60 files is not reviewed at all. The run posts one comment naming the count and asking for a smaller pull request, and later pushes rewrite that comment instead of adding another.",
      "When the inline comments cannot be posted, the run posts the same findings in the review body instead. A comment naming a line that is not in the diff is the usual reason, and GitHub then rejects the whole review. Nothing is dropped, but those findings carry no anchor.",
      "Two pushes close together start two runs. Each one re-reads the head commit before it posts and stops when a newer commit has landed, so the newest push is normally the only one that produces a review. Two pushes far apart produce two reviews, and GitHub marks the older one's comments outdated.",
      "Each review holds at most 20 findings, on lines the pull request added or changed. A longer reply is refused and asked for again once, and the run fails without posting when the second reply is also too long.",
      "If your organization requires approval for github.create_review, every run waits for a person. A denied or timed-out request ends the run and posts nothing; it never re-asks through the fallback.",
      "The review is written from text the pull request author controls — the title, the description, and the diff. A pull request can therefore try to steer what the review says, and on a public repository that includes pull requests from forks. It cannot change the verdict beyond COMMENT and REQUEST_CHANGES, approve, or merge.",
      "The model can be wrong. Read REQUEST_CHANGES as one reviewer's opinion, and do not make it a merge gate on its own.",
    ],
    definition: pullRequestReview,
  },
];
