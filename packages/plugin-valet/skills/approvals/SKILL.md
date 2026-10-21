---
name: approvals
description: Explain why a Valet action asks for approval, is refused, or never asks a person; pick the approval option that matches what the person wants; handle a teammate's shared account; and know which runs cannot ask. Use before you tell anyone that an action needs approval or how to stop the asks.
---

# Approvals and permissions

Read this before you tell a person that an action needs approval, that it was refused, or how to stop being asked. Workflow runs have extra rules. For those, also read the `workflows` skill.

## How Valet decides

Every integration action resolves to one mode: `allow`, `require_approval`, or `deny`. Valet checks these rules in order and stops at the first one that decides:

1. An organization policy that denies the action. Nothing overrides it.
2. A team policy that denies the action.
3. A grant that is live for this session: "Approve for this session" in a chat.
4. The person's own override, set with "Always allow for me" or on the personal Policies page.
5. The team or organization policy mode. A team can make an organization rule stricter, never looser.
6. A saved permission for a workflow step. It applies only when no team or organization policy matches the action, so it never loosens a policy.
7. The plugin's own default mode.
8. The risk default. `low` and `medium` actions run. `high` and `critical` actions require approval.

The deciding rule appears as `provenance.source` on the approval and in `get_permissions`: `org_policy`, `team_policy`, `runtime_grant`, `workflow_grant`, `override`, `plugin_default`, `risk_default`, or `shared_account`. Name that source when you explain an approval. Do not guess it from the risk level: a `critical` action can run without asking because a policy allows it.

## The approval card in a chat

A chat approval offers these choices. Explain what each one does before the person picks:

- **Approve** allows this one call.
- **Approve for this session** allows the same action for the rest of this session.
- **Always allow for me** (personal session) or **Always allow for this team** (team session) saves a setting for the session's owner. It is the same setting as the Integrations and team permission pages. Valet shows it only where that setting can allow the action.
- **Always allow (org)** saves an organization policy. Only an organization admin can pick it.
- **Deny** stops the call.

A person decides an approval. Never pick an option for them, and never tell them that an approval is pending when no card exists.

## A teammate's shared account

When an action uses an account that another member shared with the team, that member decides, and nobody else can. The card goes to them.

In a chat, the card offers:

- **Allow** lets later actions on that account in the same thread use it too, including ones other teammates ask for.
- **Always allow for this team**, when the card offers it, covers later threads and runs until the member stops sharing the account in Integrations. Action approvals still apply.
- **Deny** stops the call.

In a workflow run, the card offers **Allow for this run**, **Always allow for this workflow** (later runs, until someone changes its steps), and **Always allow for this team** when offered.

Only that member can choose **Always allow for this team**, in the browser or from a verified Slack link. An assistant, an API key, and an automated turn cannot grant it.

Tell the person who asked that you are waiting for that member, and name them. To avoid the wait, the team can connect an account that the team owns.

For Slack and Linear, a team session picks an account in this order: the asking member's own shared account, the team's own connection, another member's shared account (which asks that member, as above), then Valet's own app identity when the organization connected it. GitHub never uses another member's shared account: a team session uses the asking member's own shared GitHub account, then the team's own GitHub connection, then the organization's GitHub App. So these actions can run as the Valet app when nobody's account applies. A workflow `tool` step can pin `credential: "app"` or `credential: "user"`. Other services use only an account that someone connected.

## Runs that cannot ask

Some runs have no person to answer. In these runs, `ask_approval` and `ask_question` return a refusal at once, and no card opens:

- an agent step (`session` or `orchestrator`) in a workflow run
- an event delivery that no person wrote: an app's post (`slack.bot_message`), a reaction, or a GitHub or Linear event other than a comment on a pull request that Valet opened
- a scheduled prompt to the assistant (a routine)

A message that a person wrote in Slack (`slack.message` or `slack.app_mention`, in a channel or a thread) can still ask, and so can a comment on a pull request that Valet opened.

When a refusal comes back, do not retry and do not ask in a message. Say what did not run and which fix applies:

- For a workflow, put the action in a `tool` step, which stops for approval on each run, or allow the agent step's actions on the workflow page. The `workflows` skill has the details.
- For a subscription or a schedule, allow the action by policy: the owner for a personal rule, a team admin for a team rule, an organization admin for an organization rule.

## Runs that an assistant starts

A workflow run that an assistant starts on its own (`startedBy: "agent"`) never uses the workflow's saved grants. This stops a prompt from borrowing permissions that a person gave the workflow.

- When a person asks you in their own signed-in chat, the run counts as theirs, and saved grants apply. In a team workspace, that can be any member. In a personal workspace, only its owner can start a run; another person's request starts no run.
- When an event, a routine, a workflow step, or a delegated session leads you to start a run, the run is agent-started. Its agent steps that need saved grants are refused.

For an agent-started run, tell the owner to start the run from the workflow page or from their own chat, or to let its trigger start it.

## Where each rule changes

- A personal setting: the person's Integrations page or personal Policies page.
- A team policy: a team admin, on the team's Policies page.
- An organization policy: an organization admin, in Settings → Organization → Policies.

Do not change a policy to get around a refusal. Explain the missing permission and who can change it.
