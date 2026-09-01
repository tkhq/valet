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

/** The authorized live-testing scope the setup wizard authors (Part 08 +
 * Part 09 §Config schema extensions). `hosts` is required for a live plan;
 * `cidrs`, `loginUrl`, `signupUrl`, `rateLimitRps` are optional pre-supplies
 * that let the live cells skip mid-run interrupts. */
export interface ScopeDraft {
  hosts: string[];
  cidrs: string[];
  loginUrl: string;
  signupUrl: string;
  rateLimitRps: string;
}

/** A fresh empty ScopeDraft with lists initialized to []. */
export function emptyScopeDraft(): ScopeDraft {
  return { hosts: [], cidrs: [], loginUrl: "", signupUrl: "", rateLimitRps: "" };
}

/** The config value the form edits. */
export interface ConfigDraft {
  focus: string;
  invariants: string[];
  categories: string[];
  scope: ScopeDraft;
}

/** Return a clean scope for the wire: dropped empty strings and dedup-preserving
 * the original order. */
export function normalizeScopeHostsForSubmit(scope: ScopeDraft): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of scope.hosts) {
    const host = raw.trim();
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    clean.push(host);
  }
  return clean;
}

/** Same shape for CIDRs. */
export function normalizeScopeCidrsForSubmit(scope: ScopeDraft): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of scope.cidrs) {
    const cidr = raw.trim();
    if (cidr === "" || seen.has(cidr)) continue;
    seen.add(cidr);
    clean.push(cidr);
  }
  return clean;
}

/** Build the wire `scope` object from the draft, dropping empty optional
 * fields. Returns `null` when the draft has no hosts. */
export function scopeDraftToWire(scope: ScopeDraft): {
  hosts: string[];
  cidrs?: string[];
  loginUrl?: string;
  signupUrl?: string;
  rateLimitRps?: number;
} | null {
  const hosts = normalizeScopeHostsForSubmit(scope);
  if (hosts.length === 0) return null;
  const cidrs = normalizeScopeCidrsForSubmit(scope);
  const login = scope.loginUrl.trim();
  const signup = scope.signupUrl.trim();
  const rateText = scope.rateLimitRps.trim();
  const rate = rateText === "" ? undefined : Number(rateText);
  return {
    hosts,
    ...(cidrs.length > 0 ? { cidrs } : {}),
    ...(login !== "" ? { loginUrl: login } : {}),
    ...(signup !== "" ? { signupUrl: signup } : {}),
    ...(rate !== undefined && Number.isInteger(rate) && rate >= 1 && rate <= 1000
      ? { rateLimitRps: rate }
      : {}),
  };
}

export function ConfigForm({
  value,
  onChange,
  /** True when the current plan draft carries at least one live persona
   * (dast, fuzz, exploit). When true, the scope section renders as REQUIRED
   * (asterisk, "at least one host" hint). When false, the section still
   * renders but as OPTIONAL: a scope on a source-only plan is informative and
   * seeds a future live persona if the user adds one.
   *
   * Defaults to false so existing call sites without the prop keep their
   * source-only shape. */
  requireLiveScope = false,
}: {
  value: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  requireLiveScope?: boolean;
}) {
  const { focus, invariants, categories, scope } = value;

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
  function setScopeHosts(next: string[]) {
    onChange({ ...value, scope: { ...scope, hosts: next } });
  }
  function addHost() {
    setScopeHosts([...scope.hosts, ""]);
  }
  function updateHost(i: number, next: string) {
    setScopeHosts(scope.hosts.map((h, idx) => (idx === i ? next : h)));
  }
  function removeHost(i: number) {
    setScopeHosts(scope.hosts.filter((_, idx) => idx !== i));
  }
  function setScopeCidrs(next: string[]) {
    onChange({ ...value, scope: { ...scope, cidrs: next } });
  }
  function addCidr() {
    setScopeCidrs([...scope.cidrs, ""]);
  }
  function updateCidr(i: number, next: string) {
    setScopeCidrs(scope.cidrs.map((c, idx) => (idx === i ? next : c)));
  }
  function removeCidr(i: number) {
    setScopeCidrs(scope.cidrs.filter((_, idx) => idx !== i));
  }
  function setLoginUrl(next: string) {
    onChange({ ...value, scope: { ...scope, loginUrl: next } });
  }
  function setSignupUrl(next: string) {
    onChange({ ...value, scope: { ...scope, signupUrl: next } });
  }
  function setRateLimit(next: string) {
    onChange({ ...value, scope: { ...scope, rateLimitRps: next } });
  }
  const trimmedHosts = scope.hosts.filter((h) => h.trim() !== "");
  const scopeEmpty = trimmedHosts.length === 0;

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

      {/* Authorized scope for live personas (Part 08 §Setup Step 1). When any
          live persona is in the plan, the section is REQUIRED; otherwise it is
          informative and seeds a future live persona if the user adds one. */}
      <div className="mt-4 grid gap-1" data-testid="config-scope">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">
            Authorized scope{requireLiveScope ? <span className="text-danger-600"> *</span> : null}
          </span>
          {requireLiveScope && (
            <span className="text-[11px] text-danger-600" data-testid="config-scope-required">
              required for live personas
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted">
          The exact hosts the live personas (DAST, fuzz, exploit) may reach.
          Every reachable request outside this list is refused by the runtime
          egress gate. Bare host or host:port; no scheme.
        </p>
        {requireLiveScope && scopeEmpty && (
          <p className="text-[11px] text-danger-600" data-testid="config-scope-empty">
            Add at least one host; the plan includes a live persona.
          </p>
        )}
        <div className="mt-1 flex flex-col gap-2">
          {scope.hosts.map((host, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={host}
                onChange={(e) => updateHost(i, e.target.value)}
                placeholder="e.g. api.example.com or api.example.com:8443"
                className="h-8 flex-1 text-xs"
                aria-label={`Authorized host ${i + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeHost(i)}
                aria-label={`Remove host ${i + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={addHost}>
            Add host
          </Button>
        </div>

        {/* Authorized CIDRs (v1 Part 09 §Config schema extensions). Optional;
            feeds pivot-coordinator's scope-auto-include pattern. */}
        <div className="mt-3 grid gap-1" data-testid="config-scope-cidrs">
          <span className="text-[11px] text-muted">Authorized CIDRs (optional)</span>
          <p className="text-[11px] text-muted">
            IP ranges the pivot-coordinator MAY auto-approve when a live persona
            discovers a new host inside them.
          </p>
          <div className="mt-1 flex flex-col gap-2">
            {scope.cidrs.map((cidr, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={cidr}
                  onChange={(e) => updateCidr(i, e.target.value)}
                  placeholder="e.g. 10.0.0.0/8"
                  className="h-8 flex-1 text-xs"
                  aria-label={`Authorized CIDR ${i + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCidr(i)}
                  aria-label={`Remove CIDR ${i + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={addCidr}>
              Add CIDR
            </Button>
          </div>
        </div>

        {/* Login URL (optional). Skips a mid-run credential interrupt. */}
        <div className="mt-3 grid gap-1">
          <Label htmlFor="config-scope-login-url">Login URL (optional)</Label>
          <Input
            id="config-scope-login-url"
            value={scope.loginUrl}
            onChange={(e) => setLoginUrl(e.target.value)}
            placeholder="https://api.example.com/auth/login"
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted">
            The pivot-coordinator POSTs to this endpoint with the credentials
            you provide, so DAST and exploit can proceed without a mid-run
            interrupt.
          </p>
        </div>

        {/* Signup URL (optional; L4 only). */}
        <div className="mt-3 grid gap-1">
          <Label htmlFor="config-scope-signup-url">Signup URL (optional, L4)</Label>
          <Input
            id="config-scope-signup-url"
            value={scope.signupUrl}
            onChange={(e) => setSignupUrl(e.target.value)}
            placeholder="https://api.example.com/signup"
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted">
            Only used by the L4 <span className="font-mono">create-test-account</span> pattern; leave blank to skip.
          </p>
        </div>

        {/* Rate limit. */}
        <div className="mt-3 grid gap-1">
          <Label htmlFor="config-scope-rate-limit">Rate limit (requests per second, optional)</Label>
          <Input
            id="config-scope-rate-limit"
            value={scope.rateLimitRps}
            onChange={(e) => setRateLimit(e.target.value)}
            placeholder="e.g. 5"
            className="h-8 w-24 text-xs"
          />
          <p className="text-[11px] text-muted">
            Integer 1..1000. Absent means each live persona picks a conservative default.
          </p>
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
