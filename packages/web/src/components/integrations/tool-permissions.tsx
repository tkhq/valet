/**
 * Per-tool permissions in the `/integrations` detail panel (settings-redesign
 * spec, "Integrations"). Each tool shows its EFFECTIVE mode, read from
 * `GET /api/me/tool-permissions` (the same resolver a session call uses), as
 * Allow / Ask first / Off. A change writes your own override through
 * `PUT /api/me/policy-overrides`; Reset deletes it.
 *
 * Tools are grouped by risk: Read (low), Write (medium), High risk (high and
 * critical). A group's Set all writes every tool in it that takes the mode.
 * There is no Allow for every tool at once. A mode an org or team rule
 * forbids is disabled, and the row says who set it.
 */
import type { ApprovalModeWire, PluginSummary, RiskLevelWire, ToolPermissionSource, ToolPermissionWire } from "@valet/api/wire";
import { apiErrorMessage, useMyToolPermissions, useSetMyToolModes } from "~/api/policies";
import { Button, FilterChips, Spinner } from "~/components/primitives";

const MODES: readonly { value: ApprovalModeWire; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "require_approval", label: "Ask first" },
  { value: "deny", label: "Off" },
];

const GROUPS: readonly { label: string; risks: readonly RiskLevelWire[] }[] = [
  { label: "Read", risks: ["low"] },
  { label: "Write", risks: ["medium"] },
  { label: "High risk", risks: ["high", "critical"] },
];

/** The tag beside a tool's name, in words, so no state is color alone. */
const TAG: Record<ToolPermissionSource, string> = {
  default: "Default",
  plugin: "Default",
  org: "Organization",
  team: "Team",
  personal: "Custom",
  grant: "Approved",
};

const LOCKED: Record<"org" | "team", string> = {
  org: "Set by your organization",
  team: "Set by your team",
};

/** The tools a plugin's rows and panel speak for: its action services'. */
export function pluginTools(plugin: PluginSummary, tools: readonly ToolPermissionWire[]): ToolPermissionWire[] {
  const services = new Set((plugin.actionServices ?? plugin.services).map((service) => service.service));
  return tools.filter((tool) => services.has(tool.service));
}

/** "12 tools · 3 ask · 1 off", leaving out a count of zero. */
export function permissionSummary(tools: readonly ToolPermissionWire[]): string | null {
  if (tools.length === 0) return null;
  const ask = tools.filter((tool) => tool.mode === "require_approval").length;
  const off = tools.filter((tool) => tool.mode === "deny").length;
  return [
    `${tools.length} tool${tools.length === 1 ? "" : "s"}`,
    ask > 0 ? `${ask} ask` : null,
    off > 0 ? `${off} off` : null,
  ].filter(Boolean).join(" · ");
}

export function ToolPermissions({ plugin }: { plugin: PluginSummary }) {
  const query = useMyToolPermissions();
  const setModes = useSetMyToolModes();
  const tools = pluginTools(plugin, query.data?.tools ?? []);
  const overridden = tools.filter((tool) => tool.overridden);
  const set = (actionIds: string[], mode: ApprovalModeWire | null) => {
    if (actionIds.length > 0) setModes.mutate({ actionIds, mode });
  };

  if (query.isLoading) {
    return <p className="mt-2 flex items-center gap-2 text-xs text-muted"><Spinner size={12} /> Loading tool permissions…</p>;
  }
  if (query.error) {
    return <p className="mt-2 text-xs text-danger-500">Could not load tool permissions. Reload the page to try again.</p>;
  }
  if (tools.length === 0) return null;

  return (
    <div className="mt-2 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Choose what the assistant may do with each tool. Your choices apply to your own threads.</p>
        <Button
          variant="ghost"
          size="sm"
          className="max-sm:h-11"
          disabled={overridden.length === 0}
          onClick={() => set(overridden.map((tool) => tool.actionId), null)}
        >
          Reset all to defaults
        </Button>
      </div>
      {/* The live region is on the page before an error arrives, so a screen reader announces it. */}
      <p role="alert" className="text-xs text-danger-500 empty:hidden">
        {setModes.error ? apiErrorMessage(setModes.error) : ""}
      </p>
      {GROUPS.map((group) => {
        const members = tools.filter((tool) => group.risks.includes(tool.riskLevel));
        if (members.length === 0) return null;
        const common = members.every((tool) => tool.mode === members[0]?.mode) ? members[0]?.mode : undefined;
        return (
          <section key={group.label} aria-label={`${group.label} tools`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-ink">{group.label}</h4>
              <span className="flex items-center gap-2 text-xs text-muted">
                Set all
                <FilterChips
                  label={`Set all ${group.label} tools`}
                  value={common}
                  options={MODES.map((mode) => ({
                    ...mode,
                    disabled: !members.some((tool) => tool.settable.includes(mode.value)),
                  }))}
                  onChange={(mode) => set(
                    members.filter((tool) => tool.mode !== mode && tool.settable.includes(mode)).map((tool) => tool.actionId),
                    mode,
                  )}
                />
              </span>
            </div>
            <ul className="mt-2 divide-y divide-line">
              {members.map((tool) => (
                <ToolRow key={tool.actionId} tool={tool} onSet={(mode) => set([tool.actionId], mode)} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ToolRow({ tool, onSet }: { tool: ToolPermissionWire; onSet: (mode: ApprovalModeWire | null) => void }) {
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-xs font-medium text-ink">{tool.name}</span>
          <span className="text-[11px] text-muted">{TAG[tool.source]}</span>
          {tool.overridden && (
            <Button variant="ghost" size="sm" className="max-sm:h-11" aria-label={`Reset ${tool.name}`} onClick={() => onSet(null)}>
              Reset
            </Button>
          )}
        </div>
        {tool.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{tool.description}</p>}
        {tool.lockedBy && <p className="mt-0.5 text-xs text-muted">{LOCKED[tool.lockedBy]}</p>}
      </div>
      <FilterChips
        className="shrink-0 flex-nowrap"
        label={`${tool.name} permission`}
        value={tool.mode}
        options={MODES.map((mode) => ({ ...mode, disabled: !tool.settable.includes(mode.value) }))}
        onChange={(mode) => {
          if (mode !== tool.mode) onSet(mode);
        }}
      />
    </li>
  );
}
