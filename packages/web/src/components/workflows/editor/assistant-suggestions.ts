/**
 * What the assistant can be asked about THIS workflow.
 *
 * The assistant panel opens on an empty transcript, and "ask me anything"
 * teaches a first-time builder nothing. It therefore offers openings drawn
 * from the definition on screen: the steps that are actually broken first,
 * then edits that make sense for the steps that exist. The same ordering
 * makes the list a repair list later in the conversation, when the agent
 * has added a step and left it unwired.
 *
 * Every prompt names the workflow id. The panel seeds its thread with the
 * id once, but a conversation outlives that message, and an instruction the
 * agent can act on without scrolling is cheaper than one it cannot.
 *
 * Prompts are put in the composer, not sent. Several end mid-sentence on
 * purpose — the user finishes the condition or the channel, which is the
 * part only they know.
 */
import type { WorkflowDefinition, WorkflowNode } from "@valet/workflow";

export interface WorkflowSuggestion {
  /** Short button label. */
  label: string;
  /** The text put in the composer. */
  prompt: string;
}

/** Nodes that end a branch, so having no outgoing edge is correct. */
const TERMINAL_TYPES: ReadonlySet<string> = new Set(["stop"]);

function nodeIdsWithoutOutgoing(definition: WorkflowDefinition): string[] {
  const sources = new Set(definition.edges.map((edge) => edge.from));
  return definition.nodes
    .filter((node) => !TERMINAL_TYPES.has(node.type) && !sources.has(node.id))
    .map((node) => node.id);
}

function nodeIdsWithoutIncoming(definition: WorkflowDefinition): string[] {
  const targets = new Set(definition.edges.map((edge) => edge.to));
  return definition.nodes
    .filter((node) => node.type !== "trigger" && !targets.has(node.id))
    .map((node) => node.id);
}

function firstNodeOfType(definition: WorkflowDefinition, type: string): WorkflowNode | undefined {
  return definition.nodes.find((node) => node.type === type);
}

/** The step a new one would most naturally follow: the last node that is
 * neither the trigger nor a stop, falling back to the trigger. */
function anchorNodeId(definition: WorkflowDefinition): string | undefined {
  const middle = definition.nodes.filter(
    (node) => node.type !== "trigger" && !TERMINAL_TYPES.has(node.type),
  );
  const last = middle[middle.length - 1];
  return last?.id ?? firstNodeOfType(definition, "trigger")?.id;
}

export const MAX_SUGGESTIONS = 3;

export function workflowSuggestions(
  definition: WorkflowDefinition,
  workflowId: string,
): WorkflowSuggestion[] {
  const suggestions: WorkflowSuggestion[] = [];
  const inThisWorkflow = `In workflow \`${workflowId}\``;

  // Broken structure first — these are the asks with a right answer.
  for (const id of nodeIdsWithoutIncoming(definition)) {
    suggestions.push({
      label: `Wire up "${id}"`,
      prompt: `${inThisWorkflow}, the step "${id}" is never reached. Connect it into the flow.`,
    });
  }
  for (const id of nodeIdsWithoutOutgoing(definition)) {
    suggestions.push({
      label: `Finish "${id}"`,
      prompt: `${inThisWorkflow}, the step "${id}" has nothing after it. Connect it to a stop node.`,
    });
  }

  const llm = firstNodeOfType(definition, "llm");
  if (llm) {
    suggestions.push({
      label: `Send "${llm.id}" somewhere`,
      prompt: `${inThisWorkflow}, add a step after "${llm.id}" that sends its output to Slack in channel `,
    });
  }

  const anchor = anchorNodeId(definition);
  if (anchor && !firstNodeOfType(definition, "if")) {
    suggestions.push({
      label: "Add a branch",
      prompt: `${inThisWorkflow}, add an if node after "${anchor}" so the flow only continues when `,
    });
  }
  if (anchor) {
    suggestions.push({
      label: "Add a step",
      prompt: `${inThisWorkflow}, add a step after "${anchor}" that `,
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}
