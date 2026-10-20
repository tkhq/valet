# Save-time grants for workflow agent steps

Status: accepted 2026-10-17 with the recommended answers. Builds on PR #940 (build-time permissions for tool steps, with #943: unattended runs refuse every decision).

## Problem

Workflow runs never ask a person. PR #943 enforces this: an unattended workflow task refuses a decision before a gate opens, and `awaitResult` fails the step. A refused approval in an agent step therefore fails the run.

PR #940 lets a person allow actions and accounts once, when the workflow is built: in Review permissions or in one `workflows.allow_permissions` card. A save allows nothing. That path covers only direct tool steps and foreach tool bodies. Agent steps cannot use it:

- A session step runs in its own engine session, `wf:{runId}:{nodeId}[:{iteration}]`. A Thread step (an `orchestrator` node) submits a `workflow.request` signal to an assistant session.
- Both call actions through the engine `invokeAction`. It resolves policy with `appliesIn: "session"`, the session id, and the thread id. The input carries no run id, so `loadPolicyRows` loads no workflow grants.
- `canBorrowCredential` honors `workflow_account_grants` only for the tool-step scope `wf:{runId}`.
- Permission review lists only tool-step actions and tool-step services.

## Design

The design reuses the #940 grant tables, review, approval card, and revocation rules. It adds no table.

### Declaring actions

Session and Thread nodes already accept `toolScope.actions`. The engine filters discovery by it and checks it again at execution. Children inherit the intersection.

An agent step can use a workflow grant only for an exact `service.action` entry in its own `toolScope.actions`. A `service.*` entry still limits the step, but it uses no action grant. A step with no `actions` list uses no action grant. A grant is per workflow and action, as in #940, so two steps that list the same exact action share one grant.

### Review

Permission review adds the exact entries of each agent step as rows with `agentStep: true`. The prediction uses `partialParams: true`, because the agent supplies every parameter. A dynamic action outside the static catalog, such as a Granola action, shows as `unknown` and is still grantable, because the step names it exactly.

The services of every agent-step entry, exact or `service.*`, join the workflow's credential services. A member's approval therefore covers their own shared accounts for those services, as #940 does for tool steps.

Review permissions and the `workflows.allow_permissions` card grant these rows the same way as tool-step rows. A save still allows nothing. The review and the card say that in an agent step, the agent chooses when to call an action and which values to send.

### Run time

The host derives the step of each agent-step call from host-written data:

- The session id, when it has the `wf:{runId}:{nodeId}` form of a session step.
- Otherwise, the running submission's `workflowStep` metadata. The host writes it on the Thread-step `workflow.request` signal and its repairs. A child of an unattended step inherits the parent's step the same way.

The engine passes the running submission id, `queueItemId`, on `PolicyResolveInput`, on `CredentialUse`, and on the child spawn and send contexts. The engine knows nothing about workflows.

Before it uses any grant, the host checks the step:

1. The run exists in the org and has not settled.
2. The node in the run snapshot is a `session` or `orchestrator` node, or a foreach body of that type.
3. The workflow's current owner is the run owner.
4. The session's policy owner is the run owner. A team run that reports into a member's personal assistant thread fails this check. Team policies do not load in that session, so the step gets no team grant there.
5. The run snapshot has the same steps as the saved workflow (`sameWorkflowSteps`).
6. An agent did not start the run. See "Agent-started runs".

When all checks pass and the action is an exact entry of the node, policy resolution loads the workflow's grants. It reads the grants and both definitions in one statement and drops them when the run's steps differ, so an edit and a new approval between the checks and the read give the run nothing. Review permissions resolves agent rows the same way, so an allowed row shows as allowed. The `workflow_grant` rung then applies to the call. For an agent step, the rung requires that no explicit org or team policy matches the action under any `appliesIn`. Agent steps resolve as `session`, so without this check a grant would skip an admin rule scoped to workflows.

The borrow check accepts the member's `workflow_account_grants` row for the step's workflow and the current share generation. It keeps the #940 checks for team membership, the lender's credential, the share generation, and the saved steps. It does not require a session with no app row, because a Thread step runs in an assistant session.

### Agent-started runs

Whoever starts a run writes its input, and the input reaches the agent step's prompt. An agent could therefore start a run to get an action that its own session would have to ask a person for. A run that an agent starts on its own records `startedBy: "agent"` in its params, and its agent steps use no workflow grants. Such a start is an assistant start without the person's own signed-in prompt, or an MCP, CLI, or API-key start. A nested `workflow` call and a retry keep the old run's value, because the input does not change. When such a run's agent step is refused an action, the failed-step error says that an agent started or retried the run and that its agent steps do not use saved permissions (2026-10-20). The marker comes from the source run or from an agent's retry, so the error tells the owner to start a new run, and names the setup that run needs. The engine's refusal result, which the agent reports, cannot see the marker, so it says that saved permissions do not apply to a run an agent started or retried. Before this, the error told the owner to review permissions, which they had already done.

Runs from schedules, events, and webhooks keep using grants. Trigger rows record no fact about who created them. An agent-created trigger with a fixed input is therefore a known gap. It matches the risk that #940 accepts for templated tool-step values.

### Failure text

The #943 step failure text adds the new remedy: list the exact action in the agent step's actions, then review the workflow's permissions.

## Not covered

- Scripts in a session step's sandbox. `/sandbox-actions` calls the headless invoker without a session, so scripts still get `approvalRequired`.
- A Thread-step turn that no submission with `workflowStep` owns, such as some `child.settled` wakes. It uses no grant.
- Which org policies apply to agent steps in general. They keep `appliesIn: "session"` for base resolution.
- Parameter limits on agent-step grants, for example one Slack channel. This is the follow-up that most reduces prompt-injection risk.

## Threat cases

| Case | Result |
| --- | --- |
| Prompt injection in content the step reads asks for a granted action with attacker values | The action runs. This is the accepted risk. Explicit policies, including parameter-scoped deny and approval rules, still apply. The review states that the agent chooses values |
| Injection asks for an undeclared action | Scope enforcement refuses it |
| Injection delegates to a child to escape the scope | The child's scope is the intersection of the parent's scope |
| The agent edits its own workflow | Any step change revokes the grants (#940). The running step's snapshot then differs from the saved steps |
| A teammate edits a step after an admin approved it | Any step change revokes action grants and account consent (#940) |
| A lender stops sharing and shares again | The new share generation does not match the stored row |
| A forged step | Session ids and submission metadata are host-written. The host checks the run, org, owner, node type, and steps |
| A person's prompt in a thread that a run also uses | Its submission has no `workflowStep`, so no grant applies |
| An agent starts the run and writes its input | The run records `startedBy: "agent"`, so its agent steps use no grants |
| An admin restricts the action for workflows only | The agent-step rung checks explicit policies under every `appliesIn` |

## Rollout

Grants allowed under #940 before this change start to cover agent steps that list the same exact action, and account consent starts to cover agent steps that list the service. The review then listed tool steps only. No revocation runs: an existing grant covers an agent step only when that step lists the exact action or the service.

## Validation

- Unit tests: the resolution rung for agent steps, including a workflow-only policy. Step derivation and each check. Review rows and services for agent steps.
- Borrow tests: a Thread-step session with a saved account grant, a changed share generation, and a run whose steps changed.
- `make e2e` before the code is done.
