# Thread auto-archive

Status: implemented (2026-11-03).

## Problem

Threads stay in the sidebar list until a person archives them by hand. Lists fill with threads that nobody opened for weeks.

## Behavior

- An hourly sweep (`packages/api/src/services/thread-auto-archive.ts`) archives each thread that nobody used for `VALET_THREAD_ARCHIVE_DAYS` days. The default is 7. 0 turns auto-archive off. An invalid value stops the API at startup and names the variable.
- The archive is the same display-only state as a manual archive: `session_threads.archived_at`. The engine thread and its history do not change. `session_threads.archived_by` records who archived the thread: `system` for the sweep, or the user id for a manual archive.
- "Used" means the later of the newest engine entry (`engine_threads.updated_at`) and the last user action (`session_threads.last_user_activity_at`). Each entry moves `updated_at`, so a message from anyone, a turn, or a tool run counts. A message the user sends moves `last_user_activity_at`.
- The sweep skips these threads:
  - a running or queued turn (an unsettled queue item);
  - a pending approval or decision;
  - a pending or running wakeup (schedules, background commands, child subscriptions);
  - an unfinished child task (`child_watches` not settled, or still delivering);
  - a thread anyone pinned in their sidebar (`thread-projects` documents);
  - the Home thread;
  - a team conversation's governing thread, because its execution session carries the activity and deliveries read its archive state;
  - threads in archived or deleted sessions;
  - a thread that is already archived.

## Where an archived thread shows

- It leaves the sidebar thread list and the Home Tasks panel.
- Search finds it. `GET /sessions/:id/threads?archived=all` lists active and archived threads together. The web search dialog uses it and marks archived results "Archived".
- `ThreadSummary.autoArchived` is `{ idleDays }` when the sweep archived the thread. Opening an archived thread shows a notice in the thread header: "Archived automatically after 7 days idle." or "Archived.", with an Unarchive button.

## Unarchive

- A new message from a user in an archived thread unarchives it, however it was archived (`services/thread-activity.ts`).
- A delivery counts a thread the sweep archived as live (`isDeliverableTarget`, `threadForPullRequest`) and reopens it. A Slack reply or a pull request comment continues in its thread, not in a new one. A thread a person archived still refuses a pinned delivery.
- The Unarchive button and `PATCH .../threads/:id { archived: false }` clear `archived_at` and `archived_by`.

## Replicas

Each API process runs the sweep. Each batch of up to 500 threads runs in a transaction that takes `pg_try_advisory_xact_lock`. A process that does not get the lock skips the pass. The write only changes rows that are still unarchived. Two passes at the same time never archive a thread twice.

## Observability

Each pass logs one line with the count and duration, and adds the count to the `valet.threads.auto_archived` counter.

## Limits

- An open client sees an archive the sweep made only after its thread list refreshes.
- The Ask Valet panel's durable conversation starts a new conversation after its thread is archived, the same as after a manual archive.
- The Helm chart does not set `VALET_THREAD_ARCHIVE_DAYS` yet. Deployments use the default until the chart adds it.
