import type { SecurityEngagementWire } from "@valet/api/wire";
import { Button, Input, Label } from "~/components/primitives";

/**
 * The controlled review-config form (value + onChange, no data fetching or
 * mutation). The setup page (`/security/new`) owns the value and posts it on
 * create. Focus weights the review; a stated invariant turns a confirmed
 * violation into a high-signal finding; a loaded category puts its domain
 * attack patterns in front of every persona. All three ride on every persona
 * dispatch (the engine injects them in `buildDispatchPrompt`).
 */

/**
 * The threat categories the form offers (dynamic-config M-P2a). Mirrors the
 * plugin's `KNOWN_CATEGORIES` ids with a short label each. The server is the
 * authority — it validates every saved id against `isKnownCategory`. Keep it in
 * step with `packages/plugin-security/src/lib/categories.ts`.
 */
export const KNOWN_CATEGORIES: { id: string; label: string }[] = [
  { id: "authz", label: "Authorization" },
  { id: "authn", label: "Authentication" },
  { id: "multi-tenancy", label: "Multi-tenancy" },
  { id: "key-management", label: "Key management" },
  { id: "crypto-wallets", label: "Crypto wallets" },
  { id: "secrets-handling", label: "Secrets handling" },
  { id: "policy-engines", label: "Policy engines" },
  { id: "webhooks", label: "Webhooks" },
  { id: "parsers", label: "Parsers" },
  { id: "state-machines", label: "State machines" },
];

export function categoryLabel(id: string): string {
  return KNOWN_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** The config value the form edits. */
export interface ConfigDraft {
  focus: string;
  invariants: string[];
  categories: string[];
}

export function ConfigForm({
  value,
  onChange,
}: {
  value: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
}) {
  const { focus, invariants, categories } = value;

  function setFocus(next: string) {
    onChange({ ...value, focus: next });
  }
  function setInvariants(next: string[]) {
    onChange({ ...value, invariants: next });
  }
  function toggleCategory(id: string) {
    const next = categories.includes(id)
      ? categories.filter((c) => c !== id)
      : // Preserve the KNOWN_CATEGORIES order, not the toggle order.
        KNOWN_CATEGORIES.filter((c) => categories.includes(c.id) || c.id === id).map((c) => c.id);
    onChange({ ...value, categories: next });
  }

  return (
    <div data-testid="config-form">
      <h3 className="text-xs font-semibold text-ink">Review focus</h3>
      <p className="mt-1 text-[11px] text-muted">
        Focus the review and list invariants you already know. The review flags a
        broken invariant as a high-signal finding. Both freeze when it starts.
      </p>

      <div className="mt-3 grid gap-1">
        <Label htmlFor="config-focus">Focus (optional)</Label>
        <textarea
          id="config-focus"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="e.g. the multi-tenant data path and the webhook verifier"
          className="min-h-[3rem] rounded border border-line bg-paper px-2 py-1 text-xs text-ink"
        />
      </div>

      <div className="mt-3 grid gap-1">
        <span className="text-xs text-muted">Known invariants (optional)</span>
        <div className="flex flex-col gap-2">
          {invariants.map((inv, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={inv}
                onChange={(e) =>
                  setInvariants(invariants.map((v, i) => (i === index ? e.target.value : v)))
                }
                placeholder="e.g. every admin route sits behind requireAdmin"
                className="h-8 flex-1 text-xs"
                aria-label={`Invariant ${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setInvariants(invariants.filter((_, i) => i !== index))}
                aria-label={`Remove invariant ${index + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setInvariants([...invariants, ""])}
          >
            Add invariant
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-1">
        <span className="text-xs text-muted">Threat categories to load (optional)</span>
        <p className="text-[11px] text-muted">
          A loaded category puts its domain attack patterns (CWE/CAPEC) in front
          of every persona. Pick the domains this repo covers.
        </p>
        <div className="mt-1 grid grid-cols-2 gap-1" data-testid="config-categories">
          {KNOWN_CATEGORIES.map((cat) => (
            <label key={cat.id} className="flex items-center gap-2 text-[11px] text-ink">
              <input
                type="checkbox"
                checked={categories.includes(cat.id)}
                onChange={() => toggleCategory(cat.id)}
                aria-label={cat.label}
              />
              {cat.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The read-only "Live testing" affordance (M-P4b). Shows the authorized scope
 * and the declared live tools an engagement carries. Authorization-sensitive:
 * the scope names the exact hosts live personas may reach. These are declared in
 * the repo's `.valet/security.yml` and are never edited in the UI.
 *
 * Renders nothing when the engagement declares no scope and no tools.
 */
export function LiveTestingPanel({ engagement }: { engagement: SecurityEngagementWire }) {
  const hosts = engagement.authorizedScope?.hosts ?? [];
  const tools = engagement.configTools ?? [];
  if (hosts.length === 0 && tools.length === 0) return null;
  return (
    <div className="mt-2 border-t border-line pt-2" data-testid="live-testing">
      <h4 className="text-[11px] font-semibold text-ink">Live testing</h4>
      {hosts.length > 0 ? (
        <div className="mt-1" data-testid="live-authorized-scope">
          <span className="text-[11px] text-muted">Scope: </span>
          <span className="text-[11px] text-ink">{hosts.join(", ")}</span>
        </div>
      ) : (
        tools.length > 0 && (
          <p className="mt-1 text-[11px] text-muted" data-testid="live-no-scope">
            No authorized scope is declared. Live personas have no target.
          </p>
        )
      )}
      {tools.length > 0 && (
        <div className="mt-1" data-testid="live-declared-tools">
          <span className="text-[11px] text-muted">Tools: </span>
          <span className="text-[11px] text-ink">{tools.map((t) => t.id).join(", ")}</span>
        </div>
      )}
    </div>
  );
}
