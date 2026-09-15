import type { AuthorizationKind } from "@valet/engine/authorization";
import type { ComparisonOperator, FieldType, PolicyContextDescriptor, PolicyFieldDescriptor, Sensitivity } from "./types.js";

const OPS: Record<FieldType, readonly ComparisonOperator[]> = {
  string: ["eq", "neq", "regex", "in", "not_in", "exists", "not_exists"],
  number: ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "not_exists"],
  boolean: ["eq", "neq", "exists", "not_exists"],
  string_set: ["in", "not_in", "exists", "not_exists"],
  timestamp: ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "not_exists"],
};
const field = (path: string, type: FieldType, location: PolicyFieldDescriptor["location"] = "attribute", sensitivity: Sensitivity = "public", operators = OPS[type]): PolicyFieldDescriptor => ({
  path,
  label: path.split(".").at(-1) ?? path,
  location,
  type,
  sensitivity,
  operators,
});
const common = [field("subject.principalId", "string", "fact"), field("subject.ownerId", "string", "fact", "sensitive")];
const descriptor = (kind: AuthorizationKind, label: string, fields: readonly PolicyFieldDescriptor[], options: Partial<Pick<PolicyContextDescriptor, "publishable" | "humanApproval" | "appliesIn" | "obligations">> = {}): PolicyContextDescriptor => {
  const humanApproval = options.humanApproval ?? false;
  return {
    schemaVersion: 1,
    kind,
    label,
    subjectKinds: ["user", "team", "org", "app"],
    fields: [...fields, ...common],
    effects: humanApproval ? ["allow", "deny", "require_approval"] : ["allow", "deny"],
    humanApproval,
    fallback: humanApproval ? "require_approval" : "deny",
    publishable: options.publishable ?? false,
    appliesIn: options.appliesIn ?? false,
    obligations: options.obligations ?? ["redact"],
  };
};

export const POLICY_CONTEXTS = {
  "tool.action": descriptor("tool.action", "Tool and action", [field("action.service", "string", "target"), field("action.id", "string", "target"), field("action.riskLevel", "string", "target"), field("parameters.*", "string", "attribute")], {
    publishable: true,
    humanApproval: true,
    appliesIn: true,
    obligations: [],
  }),
  "tool.builtin": descriptor("tool.builtin", "Tool and action", [field("action.service", "string", "target"), field("action.id", "string", "target"), field("action.riskLevel", "string", "target")], { publishable: true, humanApproval: true, appliesIn: true, obligations: [] }),
  "workflow.action": descriptor("workflow.action", "Workflow", [field("action.service", "string", "target"), field("action.id", "string", "target"), field("action.riskLevel", "string", "target"), field("parameters.*", "string"), field("workflow.definitionId", "string"), field("workflow.nodeId", "string"), field("workflow.executionId", "string", "fact", "sensitive"), field("workflow.trigger", "string")], { humanApproval: true, appliesIn: true }),
  "api.route": descriptor("api.route", "Route and API", [field("action.service", "string", "target"), field("action.id", "string", "target"), field("action.riskLevel", "string", "target"), field("route.method", "string"), field("route.id", "string"), field("route.operation", "string"), field("route.conceal", "boolean")], { humanApproval: true, obligations: [] }),
  "resource.access": descriptor("resource.access", "Resource", [field("action.service", "string", "target"), field("action.id", "string", "target"), field("action.riskLevel", "string", "target"), field("resource.type", "string"), field("resource.id", "string", "target", "sensitive"), field("resource.ownerId", "string", "fact", "sensitive"), field("resource.visibility", "string"), field("resource.operation", "string")], { humanApproval: true, obligations: [] }),
  "plugin.entitlement": descriptor("plugin.entitlement", "Entitlement", [field("plugin.id", "string", "target"), field("plugin.available", "boolean", "fact"), field("plugin.organizationMode", "string"), field("plugin.teamIds", "string_set", "fact"), field("plugin.operation", "string")]),
  "delegation.create": descriptor("delegation.create", "Delegation and child session", [field("delegation.parentId", "string", "fact", "sensitive"), field("delegation.childId", "string", "target", "sensitive"), field("delegation.edgeType", "string"), field("delegation.repository", "string", "attribute", "sensitive"), field("delegation.modelTier", "string"), field("delegation.hopCount", "number")], { humanApproval: true }),
  "agent.signal": descriptor("agent.signal", "Delegation and child session", [field("delegation.childId", "string", "target", "sensitive"), field("delegation.edgeType", "string")]),
  "sandbox.capability": descriptor("sandbox.capability", "Sandbox capability", [field("sandbox.profile", "string", "target"), field("sandbox.provider", "string"), field("sandbox.image", "string"), field("sandbox.docker", "boolean"), field("sandbox.cpu", "number"), field("sandbox.memory", "number"), field("sandbox.mount", "string", "attribute", "sensitive"), field("sandbox.terminal", "boolean"), field("sandbox.capability", "string", "target")], {
    humanApproval: true,
    obligations: [],
  }),
  "credential.use": descriptor("credential.use", "Credential", [field("credential.service", "string", "target"), field("credential.ownerId", "string", "fact", "sensitive"), field("credential.use", "string"), field("credential.secret", "string", "attribute", "secret_reference_only")], { humanApproval: true, obligations: ["credential_owner", "redact"] }),
  "credential.delegate": descriptor("credential.delegate", "Credential", [field("credential.service", "string", "target"), field("credential.ownerId", "string", "fact", "sensitive"), field("credential.delegationSource", "string", "fact", "sensitive")], { humanApproval: true, obligations: ["credential_owner", "redact"] }),
  "egress.connect": descriptor("egress.connect", "Egress", [field("egress.scheme", "string", "target"), field("egress.host", "string", "target", "public", ["eq", "neq", "suffix", "in", "not_in"]), field("egress.port", "number", "target"), field("egress.protocol", "string"), field("egress.destinationClass", "string"), field("egress.redirect", "boolean")], {
    humanApproval: true,
    obligations: ["egress_hosts", "redact"],
  }),
} as const satisfies Record<AuthorizationKind, PolicyContextDescriptor>;

export const AUTHORIZATION_CONTEXT_KINDS = Object.freeze(Object.keys(POLICY_CONTEXTS) as AuthorizationKind[]);
