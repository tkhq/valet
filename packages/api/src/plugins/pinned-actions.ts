/**
 * The plugin actions this host promotes to direct, model-visible tools.
 *
 * WHY THIS FILE EXISTS. Plugin actions normally reach the model through the
 * catalog's `list_tools`/`call_tool` pair. That indirection buys two things
 * worth keeping: a dotted action id is not a legal Anthropic tool name, and
 * dozens of plugins times dozens of actions would use up the model's whole
 * tool budget. It costs one thing. An action the model must use on nearly
 * every turn is not in its tool list, so the model can describe the change
 * it intends and never make it. The workflow editor's assistant panel hit
 * exactly that: it announced the edited workflow and saved nothing.
 *
 * WHY THE HOST OWNS THE LIST. A `pinned` flag on the action itself would
 * put the choice with each plugin author, and every author would pin their
 * own actions — which brings the tool-budget problem straight back. One
 * constant here keeps the whole trade-off in one diff that a reviewer can
 * read at once. The engine caps the list at `MAX_PINNED_ACTIONS` and
 * refuses anything past it.
 *
 * SCOPE. This list applies to ONE session kind: a user-owned assistant.
 * `EngineHost.buildAssistantSession` is the only builder that passes it, and
 * it passes it only when the assistant's principal is a user. The other
 * three builders — REST sessions, `task` children and workflow-run sessions
 * — get no pins. Two rules produce that scope.
 *
 * The first rule is that a pin must not reach an unattended session. A
 * pinned tool is high-salience: it sits in the tool list, and the guidance
 * below tells the model to call it in the same turn. A workflow `session`
 * node builds its prompt from run context, so a trigger, a webhook or an
 * email can put text in it. That text must not meet a one-call save tool
 * with no human present.
 *
 * The second rule is that a pin must not reach a session whose acting
 * principal is not the person typing. A team assistant's session is cached
 * on the assistant id and freezes `userId` to the first person who woke it.
 * `workflows.patch_workflow` authorizes on that frozen user, so a pinned
 * save tool in a team assistant would let a second member drive the first
 * member's principal.
 *
 * Session tools are fixed when a session is built, so within a user-owned
 * assistant the pin does apply to that person's whole default assistant and
 * not only to the editor panel. That part is acceptable: the tool reaches
 * nothing `call_tool` could not already reach for that same user, and a
 * wrong workflow id fails loudly with "workflow not found". Revisit the
 * scope if this list grows past the workflow pair.
 *
 * DEPLOY NOTE. A cached live session keeps the tool array it was built
 * with. A change here reaches an existing session at its next build.
 */
import type { PinnedActionSpec } from "@valet/engine";

/**
 * The read/write pair the workflow editing loop needs.
 *
 * `workflows.save_workflow` stays behind `call_tool` on purpose: its
 * `definition` parameter is an opaque `Unknown`, so publishing its schema
 * teaches the model nothing, and it is the whole-definition path the editor
 * panel does not want.
 */
export const PINNED_ACTIONS: readonly PinnedActionSpec[] = [
  {
    actionId: "workflows.get_workflow",
    guidance:
      "Read the workflow with this tool before you edit it, so the patch you send matches what is stored.",
  },
  {
    actionId: "workflows.patch_workflow",
    guidance:
      "Apply the edit with this tool BEFORE you describe it. A change you only described is not saved, " +
      "and the workflow stays as it was. If the user asks for a change to a workflow, call this tool in " +
      "the same turn; report what you changed only after the call returns.",
  },
];
