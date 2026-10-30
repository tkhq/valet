import { NATIVE_IMAGE_RESULT_TOOL } from "@valet/engine";
import { SCOPE_SERVICE_NAME, type ToolScope } from "@valet/shared";
import { buildSecurityPersonaTools } from "../engine/security-tools.js";

/**
 * Every tool a persona child receives besides its `sec_*` tools and the
 * tools in `PERSONA_DENIED_TOOLS`: the sandbox builtins, plus the catalog and
 * host tools (`list_tools`, `call_tool`, `focus_tools`, and the skill tools).
 * `ToolScope.tools` is an exact-name allowlist over every ToolDef, so a name
 * missing here removes that tool.
 */
export const PERSONA_SANDBOX_TOOLS: readonly string[] = [
  // packages/engine/src/builtin-tools/index.ts
  "read", "write", "edit", "bash", "thread_read",
  // packages/engine/src/builtin-tools/update-plan.ts
  "update_plan",
  // packages/engine/src/builtin-tools/wakeups.ts
  "watch", "wake_at", "hold_sandbox", "process_read", "wakeup_list", "wakeup_cancel",
  // packages/engine/src/plugin-catalog.ts; `actions` still gates each call_tool action.
  "list_tools", "call_tool",
  // packages/api/src/plugins/tool-focus.ts
  "focus_tools",
  // packages/api/src/plugins/skill-tool.ts and skill-script-tool.ts
  "skill", "skill_script",
];

/** Tools a persona never holds: it does not steer children, ask a person, change its model, or store unscanned bytes. */
export const PERSONA_DENIED_TOOLS: readonly string[] = [
  "child_send", "child_read", "child_status", "ask_question", "ask_approval", "switch_model", "wait_for_event", "task", "list_threads",
  // packages/api/src/services/generated-files.ts: stores file bytes as a blob with no tripwire scan.
  "file_attach",
  // packages/engine/src/native-images.ts: the receipt tool puts any sandbox image in front of the
  // model and the transcript, and a persona can render a value into a PNG.
  NATIVE_IMAGE_RESULT_TOOL,
];

/**
 * The service names a declared MCP tool may not take (INV-32): every installed
 * service key, plus the prefix of every dotted action id, because some plugins
 * qualify actions under another name (`slack-user` declares `slack_user.*`)
 * and a `<service>.*` scope matches by prefix.
 */
export function reservedToolServices(
  actionPluginByService: ReadonlyMap<string, { actionPlugin: { actions: readonly { id: string }[] } }>,
): ReadonlySet<string> {
  const reserved = new Set(actionPluginByService.keys());
  for (const { actionPlugin } of actionPluginByService.values()) {
    for (const { id } of actionPlugin.actions) {
      const dot = id.indexOf(".");
      if (dot > 0) reserved.add(id.slice(0, dot));
    }
  }
  return reserved;
}

/**
 * The tool scope of a persona cell (INV-32). Dispatch intersects it with the
 * runner ceiling. `reservedServices` names the installed integrations, which a
 * declared MCP service never grants.
 */
export function personaToolScope(
  cell: { persona: string; review: boolean },
  mcpServices: readonly string[],
  reservedServices: ReadonlySet<string> = new Set(),
): ToolScope {
  const secTools = buildSecurityPersonaTools(cell).map((tool) => tool.name);
  // The config parser refuses these names. A row stored before that check must
  // not make readToolScope turn the child's whole scope into deny-all, nor
  // grant an installed integration's actions.
  const valid = mcpServices.filter((service) => SCOPE_SERVICE_NAME.test(service) && !reservedServices.has(service));
  if (valid.length < mcpServices.length) {
    console.warn(`security: dropped invalid or integration-named declared MCP services from the persona scope: ${mcpServices.filter((service) => !valid.includes(service)).join(", ")}`);
  }
  return {
    tools: [...new Set([...secTools, ...PERSONA_SANDBOX_TOOLS])],
    actions: valid.map((service) => `${service}.*`),
  };
}
