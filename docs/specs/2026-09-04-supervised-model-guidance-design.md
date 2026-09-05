# Supervised model selection and runtime model context

## Purpose

Valet supervisors assign bounded tasks to children. Current prompts require L/XL before every code change, which defeats smaller drafting models.
Agents also lack an automatic statement of the model that executes each call.

## Decisions

1. Supervisors use L/XL for planning, task assessment, supervision, and final judgment. Short status and routing turns can remain small.
2. Supervisors select each child's tier explicitly. S handles mechanical work. M handles bounded implementation. L handles difficult implementation when justified.
3. Separate L/XL children review requirements and code quality. XL children review only. Drafting children address findings before review repeats.
4. Children retain their assigned model during normal work. A capability gap after meaningful attempts can justify the smallest sufficient escalation.
5. Children explain escalation. A routine failing test, long task, missing credential, or unavailable tool is insufficient evidence of a capability gap.
6. Review children report findings without implementing fixes. Supervisors retain ownership of delegation and completion checks.
7. These rules guide selection; they do not add runtime tier restrictions or change user model preferences.

## Runtime context

The engine appends a compact `Runtime model` section to the outbound system prompt for each agent model call.
It reports the assigned model selection, active selection, actual provider and model ID, and any temporary override scope.
The assigned selection comes from the submission model, thread pin, or session default, in that order.
The engine captures it when the turn resolves its model. A later user pin change affects the next turn.
Tier tokens remain tokens. A concrete selection has no inferred tier because several tiers can resolve to the same model.

The active model comes from the model passed to the stream function, after resolution and role or agent overrides.
An agent switch takes precedence over a successful role override. Both overrides expire when the turn ends.
The context is recomputed for subsequent calls and restored sessions. Failed switches leave it on the model actually running.
The context does not mutate the durable prompt, transcript, thread pin, or session preference.
Its stable text preserves the existing system prefix and does not add timestamps or per-call counters.

## Implementation boundaries

API prompt fragments own supervisor and coding guidance. Generic tool descriptions must agree with these fragments.
The portable engine owns runtime model context. It needs no API imports, provider lookup, migration, or new public endpoint.
Existing model switching and role application remain authoritative.

## Validation

Prompt tests cover the supervisor/child distinction and remove blanket escalation requirements.
Engine tests inspect outbound provider context for initial assignment, same-turn switches, rejection, next-turn reset, role overrides, and restore.
Tests also check that context is not duplicated or persisted and that an unchanged model keeps identical context.
Concurrent user pin changes must not relabel an active turn.
Run the affected suites, typecheck, and the complete `make e2e` scorecard.
