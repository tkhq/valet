# Assistants as first-class rows

Status: in progress. Supersedes the one-orchestrator-per-principal model.

## What changes

Today a principal — a user, a team, an org — has exactly one assistant, and
the database enforces it: `orchestrator_identities` carries
`UNIQUE (org_id, owner_type, owner_id)`. The session id is derived from the
principal alone (`orchestratorSessionId` in `packages/engine/src/principal.ts`
returns `orchestrator:{type}:{id}`), so "the team's assistant" and "the team"
are the same address.

An assistant becomes its own row. A principal owns any number of them. The
principal stops being the assistant's identity and becomes its **owner and
scope**.

The reference shape is Claude Projects: a project holds documents, steering
and skills, and owns the chats inside it. An assistant holds the same and
owns its threads.

## Definition versus binding

The requirement has two halves that read as contradictory and are not:

- an assistant is scoped to a team, and
- the same assistant behaviour follows you across teams.

They resolve by splitting what an assistant IS from where it RUNS. The
**definition** — name, steering, allowed skills, assigned tools — is
portable. The **binding** — documents, memory, credentials, the sessions it
has actually held — belongs to one owner. Copying a definition into another
team gives you the same behaviour with none of the first team's context,
which is what "carry the behaviour across" has to mean if team data is not
to leak between teams.

This document covers the definition and the owning row. Per-assistant
documents, skill restriction and tool assignment build on it and are not in
this pass.

## One address, not two

Every assistant addresses its session as `assistant:{assistantId}`, the
default one included.

The cheaper-looking alternative was to keep `orchestrator:{type}:{id}` for a
principal's default assistant and use a second scheme for the rest. It was
rejected: two schemes mean every consumer branches, and the branch would go
unexercised until the first non-default assistant reached a path only the
default had ever taken. A single address costs one lookup and cannot rot in
that way.

The client loses the ability to derive a session id with no request
(`packages/web/src/lib/orchestrator-id.ts` did exactly that, so the rail
could link to a team's assistant without creating one). That property is not
lost, it moves: the rail must list assistants anyway to show more than one,
and the list carries each `sessionId`. No extra request, same guarantee that
browsing creates nothing.

## The default assistant

Each principal has exactly one default, held by a partial unique index.

It exists for the machine-driven paths. A workflow's `orchestrator` node, an
event subscription and a channel binding all say "prompt the team's
assistant" and have no basis for choosing between several. They resolve
principal → default assistant, so every existing dispatch path keeps working
with one indirection and no new decision. Humans get the choice; automation
gets a stable target.

A default cannot be archived while it is the default. Promote another first.

## Schema

`assistants` replaces `orchestrator_identities`. `handle` becomes `name`,
which is what it always was to a reader.

```
assistants
  id           text pk            -- asst_...
  org_id       text not null
  owner_type   text not null      -- user | team | org
  owner_id     text not null
  name         text
  session_id   text not null      -- assistant:{id}
  is_default   boolean not null
  created_at   bigint not null
  archived_at  bigint             -- null while live

  UNIQUE (session_id)
  UNIQUE (org_id, owner_type, owner_id) WHERE is_default   -- one default
  INDEX  (org_id, owner_type, owner_id)                    -- list by owner
```

Pre-1.0 rules apply: `0000_app.sql` is edited in place and every developer
runs `rm -rf ~/.valet/pg`. There is no backfill, and none is written.

## Access

Unchanged, and deliberately so. `canViewSession` already admits any live
member of the owning team to read and prompt, and `canAdministerSession`
holds model, pause and delete to a team admin. An assistant's session
inherits both through its `owner_type`/`owner_id`, so multiplying assistants
adds no new authorization surface.

Creating and archiving an assistant follows the same rule as administering
one: your own for a user assistant, team admin for a team's.

## What this unblocks

Channel bindings already carry `owner_type`/`owner_id`/`session_id`
(`channel_bindings`), so binding a Slack channel to a specific assistant
rather than to "the team's one assistant" needs no new column — only a
`channelThreadFor` codec that is not hardcoded to DMs.
