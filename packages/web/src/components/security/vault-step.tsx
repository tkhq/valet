/**
 * Vault wizard step (Part 10 §Ingress). The user drafts credentials for the
 * upcoming engagement here. Values live in React state only until Start
 * fires; after the session-create response lands, the drafts are handed to
 * `POST /security/vault` and the plaintext is discarded from state.
 *
 * The step is optional: skipping it seeds no vault. A run whose plan
 * contains a live persona and whose vault is empty still runs; each live
 * persona then surfaces a needs_human at the first credential requirement.
 *
 * Seven variants (Part 10 §Credential shape). Each variant renders its
 * own input widget; every value field uses `type="password"` so the
 * browser autofill and screen readers treat it as a secret.
 */
import { useCallback } from "react";
import { Button, Input, Label, Textarea } from "~/components/primitives";

export type CredentialKind =
  | "password"
  | "session"
  | "headerToken"
  | "mtls"
  | "signingKey"
  | "toolAuth"
  | "testData";

/**
 * One row on the wizard. `value` is the raw secret bytes (or file body);
 * the wizard passes it to the vault write and never persists it to
 * localStorage. `meta` carries the non-value fields — host, algo, scheme,
 * tool, format, role.
 */
export interface VaultDraftRow {
  clientId: string; // client-side row id (not the server credential id)
  label: string;
  kind: CredentialKind;
  value: string;
  meta: {
    host?: string;
    loginUrl?: string;
    username?: string;
    scheme?: string;
    algo?: string;
    keyId?: string;
    tool?: string;
    format?: string;
    role?: string;
    scope?: string;
  };
}

export function emptyVaultDraft(): VaultDraftRow[] {
  return [];
}

const KIND_LABELS: Record<CredentialKind, string> = {
  password: "Password login",
  session: "Session cookie jar",
  headerToken: "Header token (Bearer / API key)",
  mtls: "mTLS cert + key",
  signingKey: "Signing key (ECDSA / Ed25519 / HMAC / RSA)",
  toolAuth: "Opaque tool auth (JSON blob)",
  testData: "Test data (marker, seed row)",
};

const KIND_HINTS: Record<CredentialKind, string> = {
  password: "Persona posts these to the login URL to seed a session cookie.",
  session: "Netscape cookies.txt bytes the persona replays as an authed session.",
  headerToken: "Bearer or API-key token the persona sends on every request.",
  mtls: "Certificate + key PEM the persona presents to a mTLS-guarded target.",
  signingKey: "Private key material for signing (Turnkey X-Stamp, JWT forgery, SSH).",
  toolAuth: "Opaque blob a specific tool needs; the tool reads the raw bytes.",
  testData: "Non-credential input a persona reads at run-time (seed account, marker).",
};

function newRow(): VaultDraftRow {
  const clientId =
    "row_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : String(Date.now()));
  return {
    clientId,
    label: "",
    kind: "headerToken",
    value: "",
    meta: {},
  };
}

export function VaultStep({
  value,
  onChange,
  hasLivePersona,
}: {
  value: VaultDraftRow[];
  onChange: (next: VaultDraftRow[]) => void;
  hasLivePersona: boolean;
}) {
  const updateRow = useCallback(
    (clientId: string, patch: Partial<VaultDraftRow>) => {
      onChange(
        value.map((row) => (row.clientId === clientId ? { ...row, ...patch, meta: { ...row.meta, ...(patch.meta ?? {}) } } : row)),
      );
    },
    [value, onChange],
  );
  const removeRow = useCallback(
    (clientId: string) => {
      onChange(value.filter((row) => row.clientId !== clientId));
    },
    [value, onChange],
  );
  const addRow = useCallback(() => {
    onChange([...value, newRow()]);
  }, [value, onChange]);

  const empty = value.length === 0;

  return (
    <section data-testid="vault-step" className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Vault (optional)</h2>
        <p className="text-xs text-muted">
          Drop in the credentials the live personas need. Values encrypt at rest
          and mount inside each persona sandbox at
          {" "}
          <code>/etc/valet/creds/vault-&lt;label&gt;.&lt;ext&gt;</code>. Only you
          (the review's owner) can list or delete a vault credential; nobody
          else on your workspace sees the labels or the values.
        </p>
        {hasLivePersona ? (
          <p className="text-xs text-warning-700" data-testid="vault-step-live-hint">
            Your plan runs dast, fuzz, or exploit. Adding credentials here now
            keeps the run from pausing later to ask for them.
          </p>
        ) : (
          <p className="text-xs text-muted" data-testid="vault-step-safe-hint">
            Your plan is source-only, so the vault is not required. You can
            still add credentials for the pivot-coordinator or a future re-scan.
          </p>
        )}
      </header>

      {empty ? (
        <div
          className="rounded border border-dashed border-line px-3 py-4 text-xs text-muted"
          data-testid="vault-step-empty"
        >
          No credentials drafted. The vault stays empty; live personas will
          surface a needs_human at first use.
        </div>
      ) : (
        <ul className="space-y-3" data-testid="vault-step-list">
          {value.map((row, idx) => (
            <li
              key={row.clientId}
              className="rounded border border-line p-3 text-xs"
              data-testid={`vault-row-${idx}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 grow space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor={`vault-label-${row.clientId}`}>Label</Label>
                      <Input
                        id={`vault-label-${row.clientId}`}
                        value={row.label}
                        placeholder="admin"
                        onChange={(e) => updateRow(row.clientId, { label: e.target.value })}
                        data-testid={`vault-label-${idx}`}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`vault-kind-${row.clientId}`}>Kind</Label>
                      <select
                        id={`vault-kind-${row.clientId}`}
                        value={row.kind}
                        onChange={(e) =>
                          updateRow(row.clientId, {
                            kind: e.target.value as CredentialKind,
                          })
                        }
                        className="block w-full rounded border border-line bg-transparent px-2 py-1"
                        data-testid={`vault-kind-${idx}`}
                      >
                        {Object.entries(KIND_LABELS).map(([kind, label]) => (
                          <option key={kind} value={kind}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="text-muted">{KIND_HINTS[row.kind]}</p>
                  <VariantFields row={row} onPatch={(patch) => updateRow(row.clientId, patch)} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRow(row.clientId)}
                  data-testid={`vault-remove-${idx}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button type="button" onClick={addRow} data-testid="vault-add-row">
          Add credential
        </Button>
      </div>
    </section>
  );
}

function VariantFields({
  row,
  onPatch,
}: {
  row: VaultDraftRow;
  onPatch: (patch: Partial<VaultDraftRow>) => void;
}) {
  switch (row.kind) {
    case "password":
      return (
        <>
          <div>
            <Label>Login URL</Label>
            <Input
              value={row.meta.loginUrl ?? ""}
              placeholder="https://app.example.com/login"
              onChange={(e) => onPatch({ meta: { loginUrl: e.target.value } })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Username</Label>
              <Input
                value={row.meta.username ?? ""}
                onChange={(e) => onPatch({ meta: { username: e.target.value } })}
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={row.value}
                onChange={(e) => onPatch({ value: e.target.value })}
              />
            </div>
          </div>
        </>
      );
    case "session":
      return (
        <>
          <div>
            <Label>Host</Label>
            <Input
              value={row.meta.host ?? ""}
              placeholder="app.example.com"
              onChange={(e) => onPatch({ meta: { host: e.target.value } })}
            />
          </div>
          <div>
            <Label>Netscape cookie jar</Label>
            <Textarea
              rows={6}
              value={row.value}
              placeholder="# Netscape HTTP Cookie File …"
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
    case "headerToken":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Host</Label>
              <Input
                value={row.meta.host ?? ""}
                placeholder="api.example.com"
                onChange={(e) => onPatch({ meta: { host: e.target.value } })}
              />
            </div>
            <div>
              <Label>Scheme</Label>
              <select
                value={row.meta.scheme ?? "Bearer"}
                onChange={(e) => onPatch({ meta: { scheme: e.target.value } })}
                className="block w-full rounded border border-line bg-transparent px-2 py-1"
              >
                <option value="Bearer">Bearer</option>
                <option value="ApiKey">ApiKey</option>
                <option value="Token">Token</option>
                <option value="Custom">Custom</option>
              </select>
            </div>
          </div>
          <div>
            <Label>Token</Label>
            <Input
              type="password"
              value={row.value}
              placeholder="eyJ..."
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
    case "mtls":
      return (
        <>
          <div>
            <Label>Host</Label>
            <Input
              value={row.meta.host ?? ""}
              placeholder="api.example.com"
              onChange={(e) => onPatch({ meta: { host: e.target.value } })}
            />
          </div>
          <div>
            <Label>Certificate + key PEM (bundle)</Label>
            <Textarea
              rows={8}
              value={row.value}
              placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END PRIVATE KEY-----"}
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
    case "signingKey":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Algorithm</Label>
              <select
                value={row.meta.algo ?? "ecdsa"}
                onChange={(e) => onPatch({ meta: { algo: e.target.value } })}
                className="block w-full rounded border border-line bg-transparent px-2 py-1"
              >
                <option value="ecdsa">ECDSA</option>
                <option value="ed25519">Ed25519</option>
                <option value="hmac">HMAC</option>
                <option value="rsa">RSA</option>
              </select>
            </div>
            <div>
              <Label>Key id (optional)</Label>
              <Input
                value={row.meta.keyId ?? ""}
                onChange={(e) => onPatch({ meta: { keyId: e.target.value } })}
              />
            </div>
          </div>
          <div>
            <Label>Private key PEM</Label>
            <Textarea
              rows={8}
              value={row.value}
              placeholder={"-----BEGIN PRIVATE KEY-----\n…"}
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
    case "toolAuth":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Tool</Label>
              <Input
                value={row.meta.tool ?? ""}
                placeholder="turnkey-x-stamp"
                onChange={(e) => onPatch({ meta: { tool: e.target.value } })}
              />
            </div>
            <div>
              <Label>Format</Label>
              <select
                value={row.meta.format ?? "json"}
                onChange={(e) => onPatch({ meta: { format: e.target.value } })}
                className="block w-full rounded border border-line bg-transparent px-2 py-1"
              >
                <option value="json">JSON</option>
                <option value="raw">Raw</option>
              </select>
            </div>
          </div>
          <div>
            <Label>Blob</Label>
            <Textarea
              rows={6}
              value={row.value}
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
    case "testData":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Scope (optional)</Label>
              <Input
                value={row.meta.scope ?? ""}
                onChange={(e) => onPatch({ meta: { scope: e.target.value } })}
              />
            </div>
          </div>
          <div>
            <Label>Value</Label>
            <Textarea
              rows={4}
              value={row.value}
              onChange={(e) => onPatch({ value: e.target.value })}
            />
          </div>
        </>
      );
  }
}

/** Normalize a draft row set for the vault write. Drops rows whose label
 * or value is empty (the user opened the row but did not fill it in). */
export function vaultDraftsForSubmit(rows: VaultDraftRow[]): VaultDraftRow[] {
  return rows.filter((r) => r.label.trim() !== "" && r.value.length > 0);
}
