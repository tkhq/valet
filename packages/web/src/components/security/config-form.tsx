import { useEffect, useRef, useState } from "react";
import type {
  SecurityConfigCredentialDeclWire,
  SecurityCredentialWarningWire,
  SecurityEngagementWire,
} from "@valet/api/wire";
import {
  duplicateEnvMessage,
  SECURITY_CREDENTIAL_KINDS,
  validateCredentialDecl,
  type SecurityCredentialKind,
} from "@valet/shared";
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
 * The threat categories the form offers (dynamic-config M-P2a): the plugin's
 * category ids, with a short label each. The server is the authority. It
 * validates every saved id against `isKnownCategory`.
 */
const KNOWN_CATEGORIES: { id: string; label: string }[] = [
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
interface ScopeDraft {
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

/** A single declared credential kind, from the shared vocabulary. */
type CredentialKind = SecurityCredentialKind;

/** The display text for each declared credential kind. The ids come from the
 * shared vocabulary, so the select can never offer a kind the server refuses;
 * this map only says how each one reads to a human. */
const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  password: "Password",
  session: "Session cookie",
  headerToken: "Header token",
  mtls: "mTLS client cert",
  signingKey: "Signing key",
  toolAuth: "Tool auth (structured)",
  testData: "Test data",
};

const CREDENTIAL_KINDS: { id: CredentialKind; label: string }[] = SECURITY_CREDENTIAL_KINDS.map(
  (id) => ({ id, label: CREDENTIAL_KIND_LABELS[id] }),
);

/** One plain sentence for each kind, shown under the Kind select. A reader
 * with no security background picks a kind from this sentence alone. */
const CREDENTIAL_KIND_HELP: Record<CredentialKind, string> = {
  password:
    "A login password. The persona gets it as an environment variable inside its launcher command.",
  session: "A cookie value that keeps a logged-in session.",
  headerToken: "A bearer or API token sent in an HTTP header.",
  mtls:
    "A client certificate and key for mutual TLS. Declare the certificate reference in the certificate field below.",
  signingKey: "A private key used to sign requests.",
  toolAuth:
    "Credentials a tool reads as a block, for example a JSON service account. Choose Ref shape json when the 1Password field holds JSON.",
  testData: "Non-secret test values such as a payment card number the fuzzer may send.",
};

/** True when `value` is one of the declared credential kinds. Narrows a
 * `<select>`'s plain string `onChange` value before it reaches a
 * `CredentialDraft`, whose `kind` is the union, not `string`. */
function isCredentialKind(value: string): value is CredentialKind {
  // `includes` on a readonly tuple of literals refuses an arbitrary string
  // argument, so the tuple widens to string[] for the membership test only.
  return (SECURITY_CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/** A single declared 1Password credential reference, as edited in the form.
 * The wire shape plus a client-only `id` that keys the row in the list so
 * removing one row never disturbs another row's identity; the setup page
 * strips `id` before it sends the list on create. */
type CredentialDraft = SecurityConfigCredentialDeclWire & { id: string };

/** A fresh empty CredentialDraft row, with a new client-only id. */
function emptyCredentialDraft(): CredentialDraft {
  return { id: crypto.randomUUID(), label: "", env: "", reference: "", kind: "password" };
}

/** A declaration whose every field is valid, so a probe of one field reports
 * only that field. The form checks fields one at a time as they are typed;
 * the shared validator checks a whole declaration. */
const PROBE_DECL = {
  label: "probe",
  env: "PROBE",
  reference: "op://vault/item/field",
  kind: "password",
};

/** The row's own label when that label is itself valid, so a refusal about
 * some other field reads as the user's credential instead of a placeholder.
 * Returns null while the row has no usable label yet. */
function messageLabel(rowLabel: string): string | null {
  const trimmed = rowLabel.trim();
  if (trimmed === "") return null;
  return validateCredentialDecl({ ...PROBE_DECL, label: trimmed }).ok ? trimmed : null;
}

/** The probe label names the credential in every shared message. A row with
 * no label of its own would show that placeholder as if the user had typed
 * it, so swap the phrase for the wording the shared duplicate-env message
 * already uses when it has no label either. */
function withoutProbeLabel(message: string, named: boolean): string {
  if (named) return message;
  return message.replace(`Credential "${PROBE_DECL.label}"`, "A credential");
}

/**
 * The server's own refusal message for one field of a credential row, or null
 * when the field is valid or still empty. The form shows exactly what the
 * create route would say, so a row the form accepts is a row the server
 * accepts, and a refusal names the same fix in both places.
 */
function credentialFieldMessage(
  field: "label" | "env" | "reference",
  value: string,
  rowLabel = "",
): string | null {
  if (value === "") return null;
  const named = messageLabel(rowLabel);
  const result = validateCredentialDecl({
    ...PROBE_DECL,
    ...(named !== null ? { label: named } : {}),
    [field]: value,
  });
  return result.ok ? null : withoutProbeLabel(result.message, named !== null);
}

/** The same refusal for the mTLS certificate reference, which the server
 * reads from `meta.certRef`. Null when the field is valid or still empty. */
function certificateFieldMessage(value: string, rowLabel: string): string | null {
  if (value === "") return null;
  const named = messageLabel(rowLabel);
  const result = validateCredentialDecl({
    ...PROBE_DECL,
    ...(named !== null ? { label: named } : {}),
    kind: "mtls",
    meta: { certRef: value },
  });
  return result.ok ? null : withoutProbeLabel(result.message, named !== null);
}

/** One known invariant, as edited in the form. A client-only `id` keys the
 * row in the list so removing one row never disturbs another row's identity;
 * the wire carries only the trimmed `text`, and the setup page never sends
 * `id`. */
interface InvariantDraft {
  id: string;
  text: string;
}

/** A fresh empty InvariantDraft row, with a new client-only id. */
function emptyInvariantDraft(): InvariantDraft {
  return { id: crypto.randomUUID(), text: "" };
}

/** The config value the form edits. */
export interface ConfigDraft {
  focus: string;
  invariants: InvariantDraft[];
  categories: string[];
  scope: ScopeDraft;
  /** Declared 1Password credential references (Part 12). */
  credentials: CredentialDraft[];
}

/** A fresh empty ConfigDraft. */
export function emptyConfigDraft(): ConfigDraft {
  return { focus: "", invariants: [], categories: [], scope: emptyScopeDraft(), credentials: [] };
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
function normalizeScopeCidrsForSubmit(scope: ScopeDraft): string[] {
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
  /** Declared credentials the preview could not verify, each with the fix in
   * `message`. Read straight from the preview query, so a refetch replaces
   * the list and a cleared warning disappears with it. */
  credentialWarnings = [],
}: {
  value: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  requireLiveScope?: boolean;
  credentialWarnings?: SecurityCredentialWarningWire[];
}) {
  const { focus, invariants, categories, scope, credentials } = value;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referenceHelpOpen, setReferenceHelpOpen] = useState(false);
  // A warning lives inside Advanced, so a collapsed Advanced would hide the
  // one thing the user must fix before Start. Open the section for them, but
  // never fight a user who has already chosen a state.
  const advancedTouched = useRef(false);
  const warningCount = credentialWarnings.length;
  useEffect(() => {
    if (advancedTouched.current || warningCount === 0) return;
    setAdvancedOpen(true);
  }, [warningCount]);

  function setFocus(next: string) {
    onChange({ ...value, focus: next });
  }
  function setInvariants(next: InvariantDraft[]) {
    onChange({ ...value, invariants: next });
  }
  function addInvariant() {
    setInvariants([...invariants, emptyInvariantDraft()]);
  }
  function updateInvariantText(index: number, text: string) {
    setInvariants(invariants.map((v, i) => (i === index ? { ...v, text } : v)));
  }
  function removeInvariant(index: number) {
    setInvariants(invariants.filter((_, i) => i !== index));
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

  function setCredentials(next: CredentialDraft[]) {
    onChange({ ...value, credentials: next });
  }
  function addCredential() {
    setCredentials([...credentials, emptyCredentialDraft()]);
  }
  function updateCredential(i: number, patch: Partial<CredentialDraft>) {
    setCredentials(
      credentials.map((c, idx) => {
        if (idx !== i) return c;
        const next = { ...c, ...patch };
        // refShape only means anything for toolAuth; drop it on any other kind.
        if (next.kind !== "toolAuth") delete next.refShape;
        // certRef only means anything for mtls, and the create route refuses
        // it on any other kind. Drop it with the kind, and drop an empty meta
        // map so the row ships nothing the server has to strip.
        if (next.kind !== "mtls" && next.meta !== undefined) {
          const meta = { ...next.meta };
          delete meta.certRef;
          if (Object.keys(meta).length === 0) delete next.meta;
          else next.meta = meta;
        }
        return next;
      }),
    );
  }
  /** Write the mTLS certificate reference into `meta.certRef`. An empty field
   * removes the key instead of storing a blank the server would refuse. */
  function updateCertRef(i: number, next: string) {
    const meta = { ...(credentials[i].meta ?? {}) };
    if (next === "") delete meta.certRef;
    else meta.certRef = next;
    updateCredential(i, Object.keys(meta).length === 0 ? { meta: undefined } : { meta });
  }
  function removeCredential(i: number) {
    setCredentials(credentials.filter((_, idx) => idx !== i));
  }
  const duplicateLabels = new Set(
    credentials
      .map((c) => c.label.trim())
      .filter((label, idx, all) => label !== "" && all.indexOf(label) !== all.lastIndexOf(label)),
  );
  // Two credentials sharing an env name would overwrite each other in the
  // launcher script, so the create route refuses it. Flag it here too, or the
  // user only learns about it after filling in the whole form.
  const duplicateEnvs = new Set(
    credentials
      .map((c) => c.env.trim())
      .filter((env, idx, all) => env !== "" && all.indexOf(env) !== all.lastIndexOf(env)),
  );

  return (
    <div data-testid="config-form">
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            advancedTouched.current = true;
            setAdvancedOpen((open) => !open);
          }}
          aria-expanded={advancedOpen}
        >
          Advanced
        </Button>
      </div>

      {advancedOpen && (
        <div className="mt-2 grid gap-4" data-testid="config-advanced">
          <div>
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
                className="min-h-[3rem] rounded border border-line bg-paper px-2 py-2 text-base sm:py-1 sm:text-xs text-ink"
              />
            </div>
          </div>

          <div className="grid gap-1">
            <span className="text-xs text-muted">Known invariants (optional)</span>
            <div className="flex flex-col gap-2">
              {invariants.map((inv, index) => (
                <div key={inv.id} className="flex items-center gap-2">
                  <Input
                    value={inv.text}
                    onChange={(e) => updateInvariantText(index, e.target.value)}
                    placeholder="e.g. every admin route sits behind requireAdmin"
                    className="min-h-11 sm:min-h-0 sm:h-8 min-w-0 flex-1 text-base sm:text-xs"
                    aria-label={`Invariant ${index + 1}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeInvariant(index)}
                    aria-label={`Remove invariant ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={addInvariant}>
                Add invariant
              </Button>
            </div>
          </div>

          <div className="grid gap-1" data-testid="config-credentials">
            <span className="text-xs font-semibold text-ink">Credentials (optional)</span>
            <p className="text-[11px] text-muted">
              A credential is a secret the review needs to log in or call an API,
              for example an admin password or an API token. Store it in 1Password
              and paste its op:// reference here. Valet never stores the value. The
              sandbox reads it from 1Password when a persona runs a command.
            </p>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setReferenceHelpOpen((open) => !open)}
                aria-expanded={referenceHelpOpen}
              >
                How do I find an op:// reference?
              </Button>
            </div>
            {referenceHelpOpen && (
              <div
                className="rounded border border-line bg-paper px-2 py-1.5 text-[11px] text-muted"
                data-testid="credential-reference-help"
              >
                <ol className="list-decimal space-y-0.5 pl-4">
                  <li>Open the item in 1Password.</li>
                  <li>Open the menu on the field you want.</li>
                  <li>Choose Copy Secret Reference.</li>
                </ol>
                <p className="mt-1">
                  Example:{" "}
                  <span className="font-mono text-ink">op://Security/Staging admin/password</span>
                </p>
              </div>
            )}
            {credentialWarnings.map((warning) => (
              <div
                key={warning.label}
                className="rounded border border-warning-500/40 bg-warning-500/10 px-2 py-1.5 text-[11px] text-warning-700"
                data-testid={`credential-warning-${warning.label}`}
              >
                <p>
                  Credential &quot;{warning.label}&quot; could not be verified: {warning.message}
                </p>
                <p className="mt-0.5">
                  Fix this before you start the review, or the start will fail with
                  the same message.
                </p>
              </div>
            ))}
            <div className="mt-1 flex flex-col gap-2">
              {credentials.map((cred, index) => {
                const n = index + 1;
                const labelMessage = credentialFieldMessage("label", cred.label);
                const labelDuplicate = duplicateLabels.has(cred.label.trim());
                const envMessage = credentialFieldMessage("env", cred.env, cred.label);
                const envDuplicate = duplicateEnvs.has(cred.env.trim());
                const referenceMessage = credentialFieldMessage(
                  "reference",
                  cred.reference,
                  cred.label,
                );
                const certRef = cred.meta?.certRef ?? "";
                const certMessage = certificateFieldMessage(certRef, cred.label);
                return (
                  <div
                    key={cred.id}
                    className="grid gap-2 rounded border border-line p-2"
                    data-testid={`config-credential-${index}`}
                  >
                    <div className="grid gap-1">
                      <Label htmlFor={`config-credential-${index}-label`}>Label</Label>
                      <Input
                        id={`config-credential-${index}-label`}
                        value={cred.label}
                        onChange={(e) => updateCredential(index, { label: e.target.value })}
                        placeholder="admin-login"
                        className="h-8 text-xs"
                        aria-label={`Credential ${n} label`}
                      />
                      <p className="text-[11px] text-muted">
                        The persona sees this name, never the value.
                      </p>
                      {labelMessage !== null && (
                        <p className="text-[11px] text-danger-600">{labelMessage}</p>
                      )}
                      {labelMessage === null && labelDuplicate && (
                        <p className="text-[11px] text-danger-600">
                          Duplicate label. Give each credential a unique label, for
                          example &quot;admin-login&quot;.
                        </p>
                      )}
                    </div>

                    <div className="grid gap-1">
                      <Label htmlFor={`config-credential-${index}-kind`}>Kind</Label>
                      <select
                        id={`config-credential-${index}-kind`}
                        value={cred.kind}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (isCredentialKind(next)) updateCredential(index, { kind: next });
                        }}
                        className="h-8 rounded border border-line bg-paper px-2 text-xs text-ink"
                        aria-label={`Credential ${n} kind`}
                      >
                        {CREDENTIAL_KINDS.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      <p
                        className="text-[11px] text-muted"
                        data-testid={`credential-kind-help-${index}`}
                      >
                        {CREDENTIAL_KIND_HELP[cred.kind]}
                      </p>
                    </div>

                    <div className="grid gap-1">
                      <Label htmlFor={`config-credential-${index}-reference`}>
                        op:// reference
                      </Label>
                      <Input
                        id={`config-credential-${index}-reference`}
                        value={cred.reference}
                        onChange={(e) => updateCredential(index, { reference: e.target.value })}
                        placeholder="op://vault/item/field"
                        className="h-8 text-xs"
                        aria-label={`Credential ${n} op:// reference`}
                      />
                      {referenceMessage !== null && (
                        <p className="text-[11px] text-danger-600">{referenceMessage}</p>
                      )}
                    </div>

                    <div className="grid gap-1">
                      <Label htmlFor={`config-credential-${index}-env`}>Env</Label>
                      <Input
                        id={`config-credential-${index}-env`}
                        value={cred.env}
                        onChange={(e) => updateCredential(index, { env: e.target.value })}
                        placeholder="ADMIN_PASSWORD"
                        className="h-8 text-xs"
                        aria-label={`Credential ${n} env`}
                      />
                      {envMessage !== null && (
                        <p className="text-[11px] text-danger-600">{envMessage}</p>
                      )}
                      {envMessage === null && envDuplicate && (
                        <p className="text-[11px] text-danger-600">
                          {duplicateEnvMessage(cred.label.trim(), cred.env.trim())}
                        </p>
                      )}
                    </div>

                    {cred.kind === "mtls" && (
                      <div className="grid gap-1">
                        <Label htmlFor={`config-credential-${index}-cert-ref`}>
                          Certificate reference (op://)
                        </Label>
                        <Input
                          id={`config-credential-${index}-cert-ref`}
                          value={certRef}
                          onChange={(e) => updateCertRef(index, e.target.value)}
                          placeholder="op://Security/Partner/cert"
                          className="h-8 text-xs"
                          aria-label={`Credential ${n} certificate reference`}
                        />
                        <p className="text-[11px] text-muted">
                          The certificate that goes with the key in the op:// reference
                          above.
                        </p>
                        {certMessage !== null && (
                          <p className="text-[11px] text-danger-600">{certMessage}</p>
                        )}
                      </div>
                    )}

                    {cred.kind === "toolAuth" && (
                      <div className="grid gap-1">
                        <Label htmlFor={`config-credential-${index}-ref-shape`}>Ref shape</Label>
                        <select
                          id={`config-credential-${index}-ref-shape`}
                          value={cred.refShape ?? "raw"}
                          onChange={(e) =>
                            updateCredential(index, {
                              refShape: e.target.value === "json" ? "json" : "raw",
                            })
                          }
                          className="h-8 rounded border border-line bg-paper px-2 text-xs text-ink"
                          aria-label={`Credential ${n} ref shape`}
                        >
                          <option value="raw">raw</option>
                          <option value="json">json</option>
                        </select>
                        <p className="text-[11px] text-muted">
                          raw passes the field text as is. json parses it and exports
                          each key as its own variable.
                        </p>
                      </div>
                    )}

                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeCredential(index)}
                        aria-label={`Remove credential ${n}`}
                      >
                        Remove credential
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={addCredential}>
                Add credential
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-1">
        <span className="text-xs text-muted">Threat categories to load (optional)</span>
        <p className="text-[11px] text-muted">
          A loaded category puts its domain attack patterns (CWE/CAPEC) in front
          of every persona. Pick the domains this repo covers.
        </p>
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1" data-testid="config-categories">
          {KNOWN_CATEGORIES.map((cat) => (
            <label key={cat.id} className="flex min-h-11 items-center gap-2 text-[11px] text-ink sm:min-h-0">
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
          The exact hosts the live personas may reach: DAST (live web testing),
          Fuzz (malformed input testing), and Exploit (proof of concept for a
          confirmed finding). The sandbox refuses every request to a host outside
          this list. Bare host or host:port; no scheme.
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
                className="min-h-11 sm:min-h-0 sm:h-8 min-w-0 flex-1 text-base sm:text-xs"
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
            CIDR ranges (IP address blocks, for example 10.0.0.0/8) the
            pivot-coordinator MAY auto-approve when a live persona discovers a
            new host inside them.
          </p>
          <div className="mt-1 flex flex-col gap-2">
            {scope.cidrs.map((cidr, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={cidr}
                  onChange={(e) => updateCidr(i, e.target.value)}
                  placeholder="e.g. 10.0.0.0/8"
                  className="min-h-11 sm:min-h-0 sm:h-8 min-w-0 flex-1 text-base sm:text-xs"
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
            className="min-h-11 sm:min-h-0 sm:h-8 text-base sm:text-xs"
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
            className="min-h-11 sm:min-h-0 sm:h-8 text-base sm:text-xs"
          />
          <p className="text-[11px] text-muted">
            Only the <span className="font-mono">create-test-account</span> pattern at
            L4 (the deepest tier, which may create accounts) uses this URL. Leave
            blank to skip.
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
            className="min-h-11 sm:min-h-0 sm:h-8 w-24 text-base sm:text-xs"
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
