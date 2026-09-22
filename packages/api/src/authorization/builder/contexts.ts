import { DELEGATED_EXECUTION_REGISTRY_V1, type AuthorizationKind } from "@valet/engine/authorization";
import { API_ROUTE_REGISTRY_V1, RESOURCE_ACCESS_REGISTRY } from "../route-resource-registry.js";
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
const descriptor = (kind: AuthorizationKind, label: string, fields: readonly PolicyFieldDescriptor[], options: Partial<Pick<PolicyContextDescriptor, "publishable" | "humanApproval" | "appliesIn" | "obligations" | "targets">> = {}): PolicyContextDescriptor => {
  const humanApproval = options.humanApproval ?? false;
  return {
    schemaVersion: 1,
    kind,
    label,
    subjectKinds: ["user", "team", "org", "app"],
    fields: [...fields, ...common],
    targets: options.targets ?? [],
    effects: humanApproval ? ["allow", "deny", "require_approval"] : ["allow", "deny"],
    humanApproval,
    fallback: humanApproval ? "require_approval" : "deny",
    publishable: options.publishable ?? false,
    appliesIn: options.appliesIn ?? false,
    obligations: options.obligations ?? ["redact"],
  };
};

const delegatedContext = (kind: AuthorizationKind, obligations: PolicyContextDescriptor["obligations"], publishable = true): Partial<Pick<PolicyContextDescriptor, "publishable" | "humanApproval" | "obligations" | "targets">> => {
  const entries = DELEGATED_EXECUTION_REGISTRY_V1.filter((entry) => entry.kind === kind);
  return {
    publishable,
    humanApproval: entries.some((entry) => entry.approvalSupported),
    obligations,
    targets: entries.map((entry) => ({
      actionId: entry.actionId,
      service: entry.service,
      operation: entry.actionId.slice(entry.actionId.indexOf(".") + 1),
      riskLevel: entry.riskLevel,
      approvalSupported: entry.approvalSupported,
      label: entry.actionId,
    })),
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
  "api.route": descriptor("api.route", "Route and API", [field("action.id", "string", "target")], { publishable: true, humanApproval: true, obligations: [], targets: API_ROUTE_REGISTRY_V1.map(({ actionId, service, operation, riskLevel, method, template, approvalSupported }) => ({ actionId, service, operation, riskLevel, method, template, approvalSupported, label: `${method} ${template}` })) }),
  "resource.access": descriptor("resource.access", "Resource", [field("action.id", "string", "target")], { publishable: true, humanApproval: true, obligations: [], targets: RESOURCE_ACCESS_REGISTRY.map(({ actionId, service, operation, resourceKind, riskLevel }) => ({ actionId, service, operation, resourceKind, riskLevel, approvalSupported: false, label: `${resourceKind}: ${operation}` })) }),
  "plugin.entitlement": descriptor("plugin.entitlement", "Entitlement", [field("plugin.id", "string", "target"), field("plugin.available", "boolean", "fact"), field("plugin.organizationMode", "string"), field("plugin.teamIds", "string_set", "fact"), field("plugin.operation", "string")]),
  "delegation.create": descriptor("delegation.create", "Delegation and child session", [field("action.id", "string", "target"), field("parameters.parentSessionId", "string", "fact", "sensitive"), field("parameters.childSessionId", "string", "fact", "sensitive"), field("parameters.modelTier", "string"), field("parameters.profile", "string"), field("parameters.docker", "boolean"), field("parameters.depth", "number", "fact")], delegatedContext("delegation.create", [])),
  "agent.signal": descriptor("agent.signal", "Agent signal", [field("action.id", "string", "target"), field("parameters.parentSessionId", "string", "fact", "sensitive"), field("parameters.childSessionId", "string", "fact", "sensitive"), field("parameters.relationship", "string")], delegatedContext("agent.signal", [])),
  "sandbox.capability": descriptor("sandbox.capability", "Sandbox capability", [field("action.id", "string", "target"), field("parameters.requested.profile", "string"), field("parameters.requested.docker", "boolean"), field("parameters.requested.browser", "boolean"), field("parameters.requested.nestedKubernetes", "boolean"), field("parameters.requested.tunnels", "boolean")], delegatedContext("sandbox.capability", ["sandbox_capabilities"])),
  "credential.use": descriptor("credential.use", "Credential use", [field("action.id", "string", "target"), field("parameters.service", "string"), field("parameters.credentialClass", "string"), field("parameters.owner.id", "string", "fact", "sensitive"), field("parameters.operation", "string")], delegatedContext("credential.use", ["credential_owner"])),
  "credential.delegate": descriptor("credential.delegate", "Credential delegation", [field("action.id", "string", "target"), field("parameters.service", "string"), field("parameters.credentialClass", "string"), field("parameters.delegateeSessionId", "string", "fact", "sensitive"), field("parameters.expiresAtMs", "timestamp")], delegatedContext("credential.delegate", ["credential_owner"])),
  "egress.connect": descriptor("egress.connect", "Egress", [field("action.id", "string", "target"), field("parameters.destination.scheme", "string"), field("parameters.destination.host", "string", "attribute", "public", ["eq", "neq", "suffix", "in", "not_in"]), field("parameters.destination.port", "number"), field("parameters.destination.protocol", "string"), field("parameters.destination.destinationClass", "string")], delegatedContext("egress.connect", ["egress_hosts"], false)),

} as const satisfies Record<AuthorizationKind, PolicyContextDescriptor>;

export const AUTHORIZATION_CONTEXT_KINDS = Object.freeze(Object.keys(POLICY_CONTEXTS) as AuthorizationKind[]);
