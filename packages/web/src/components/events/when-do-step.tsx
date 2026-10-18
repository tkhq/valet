/**
 * The wizard's first step: When, then Do (docs/specs/2026-10-16-presence-hub-design.md
 * Part H steps 2 and 4). Each When choice shows its service mark. A service
 * that is not connected is greyed and disabled, with a link to connect it.
 */
import { Link } from "@tanstack/react-router";
import type { PluginSummary } from "@valet/api/wire";
import { isConnected } from "~/components/integrations/integration-row";
import { Button } from "~/components/primitives";
import { ServiceMark, SERVICE_NAMES } from "~/components/presence/service-mark";
import type { WhenService } from "./wizard-preview";

/** The outcome the reader picks first. It decides the steps and the store. */
export type Outcome = "reply" | "workflow" | "notify" | "advanced" | "schedule" | "thread";

/** The services the When step offers, in the order a default is picked. */
export const EVENT_SERVICES: readonly WhenService[] = ["slack", "github", "linear"];

/**
 * The When services that are connected, or null while unknown (loading or a
 * failed read). A service counts as connected when the reader connected it
 * or the organization's credential provides it, the same rule the
 * Integrations page groups by.
 */
export function connectedServices(plugins: readonly PluginSummary[] | undefined): ReadonlySet<WhenService> | null {
  if (plugins === undefined) return null;
  const connected = new Set<WhenService>();
  for (const plugin of plugins) {
    const service = EVENT_SERVICES.find((s) => s === plugin.name);
    if (service !== undefined && plugin.services.some(isConnected)) connected.add(service);
  }
  return connected;
}

/** The Do choices. `reply` and `thread` are Slack only. */
type DoChoice = "reply" | "thread" | "notify" | "workflow";

const WHEN_CHOICES: { value: WhenService | "schedule"; title: string }[] = [
  { value: "slack", title: "Something happens in Slack" },
  { value: "github", title: "Something happens on GitHub" },
  { value: "linear", title: "Something happens in Linear" },
  { value: "schedule", title: "On a schedule" },
];

const DO_CHOICES: { value: DoChoice; title: string; slackOnly: boolean }[] = [
  { value: "reply", title: "Reply", slackOnly: true },
  { value: "thread", title: "Follow a Slack thread", slackOnly: true },
  { value: "notify", title: "Work on it", slackOnly: false },
  { value: "workflow", title: "Run a workflow", slackOnly: false },
];

export function isWhenService(service: string): service is WhenService {
  return EVENT_SERVICES.some((s) => s === service);
}

/**
 * Step 1: When, then Do. Each When choice shows its service mark. A service
 * that is not connected is greyed and disabled, with a link to connect it.
 * Advanced picks raw events under a disclosure.
 */
export function WhenDoStep({ outcome, service, fixedService, fixedWorkflow, connected, onWhenChange, onDoChange, onAdvanced }: {
  outcome: Outcome;
  service: WhenService;
  /** A place's service: the only When choice, selected. */
  fixedService: WhenService | undefined;
  /** A preselected workflow fixes Do on Run a workflow. */
  fixedWorkflow: boolean;
  /** The connected services, or null while unknown. */
  connected: ReadonlySet<WhenService> | null;
  onWhenChange: (next: WhenService | "schedule") => void;
  onDoChange: (next: Outcome) => void;
  onAdvanced: () => void;
}) {
  const when = outcome === "schedule" ? "schedule" : outcome === "advanced" ? null : service;
  const whenChoices = fixedService !== undefined ? WHEN_CHOICES.filter((c) => c.value === fixedService) : WHEN_CHOICES;
  const doChoices = DO_CHOICES.filter((c) => service === "slack" || !c.slackOnly);
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">When</legend>
        {whenChoices.map((c) => {
          // A place's own service stays open: the place exists, so its events arrive.
          const off = c.value !== "schedule" && fixedService === undefined && connected !== null && !connected.has(c.value);
          return (
            <div key={c.value} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 sm:min-h-0">
              <label className={`flex items-center gap-3 text-sm ${off ? "text-muted" : "text-ink"}`}>
                <input type="radio" name="wizard-when" checked={when === c.value} disabled={off} onChange={() => onWhenChange(c.value)} />
                <ServiceMark service={c.value} size="lg" className={off ? "opacity-60" : undefined} />
                {c.title}
              </label>
              {off && c.value !== "schedule" && (
                <Link to="/integrations" className="ml-auto text-xs text-muted underline hover:text-ink">
                  Connect {SERVICE_NAMES[c.value]} first
                </Link>
              )}
            </div>
          );
        })}
      </fieldset>
      {when !== "schedule" && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">Do</legend>
          {doChoices.map((c) => (
            <label key={c.value} className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name="wizard-do"
                checked={outcome === c.value}
                disabled={fixedWorkflow && c.value !== "workflow"}
                onChange={() => onDoChange(c.value)}
              />
              {c.title}
            </label>
          ))}
        </fieldset>
      )}
      <details open={outcome === "advanced"} className="text-sm text-ink">
        <summary className="cursor-pointer text-sm text-muted">Advanced: pick events and filters</summary>
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted">Pick raw event keys and filters, then what Valet does.</p>
          <Button type="button" variant="secondary" size="sm" aria-pressed={outcome === "advanced"} disabled={fixedWorkflow} onClick={onAdvanced}>
            Pick raw events
          </Button>
        </div>
      </details>
    </div>
  );
}
