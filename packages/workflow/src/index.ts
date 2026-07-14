export type { WorkflowDefinition, WorkflowInputDefinition, WorkflowPolicy, WorkflowEdge, WorkflowTriggerPayload } from './dag/shape.js';
export type {
  WorkflowNode,
  DagNodeType,
  TriggerNode,
  SetNode,
  IfNode,
  IfCondition,
  WaitNode,
  ApprovalNode,
  SessionNode,
  StopNode,
} from './dag/nodes.js';

export {
  parseExpression,
  evaluateExpression,
  parseTemplate,
  renderTemplate,
  renderJsonTemplates,
  TemplateParseError,
  TemplateEvalError,
} from './dag/expression.js';
export type { TemplateContext } from './dag/expression.js';

export { normalizeIfOperation, isIfOperationSupported, allowedIfOperations } from './dag/if-operations.js';
export type { IfDataType } from './dag/if-operations.js';

export { parseDurationMs } from './dag/duration.js';

export { validateWorkflowDefinition } from './dag/validate.js';
export type { ValidationResult } from './dag/validate.js';
