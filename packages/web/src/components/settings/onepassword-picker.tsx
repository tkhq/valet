import { useEffect, useState } from "react";
import { apiErrorMessage } from "~/api/client";
import { useOpItemDetail, useOpItems, useOpVaults, type OnePasswordTokenScope } from "~/api/onepassword";
import { Label } from "~/components/primitives";

const SELECT_CLASS =
  "h-8 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg] disabled:cursor-not-allowed disabled:opacity-50";

export interface OnePasswordComposedReference {
  reference: string;
  tokenScope: OnePasswordTokenScope;
}

export interface OnePasswordPickerProps {
  /** Which service-account token to browse with. */
  scope: OnePasswordTokenScope;
  /** Fired once a field is chosen, with the composed `op://vault/item/field`
   * reference. Not fired again until the user picks a (possibly different)
   * field — changing an upstream select clears any prior composition. */
  onCompose: (composed: OnePasswordComposedReference) => void;
}

/**
 * Three-step cascade: vault → item → field. Each select is disabled until
 * its predecessor has a value and that predecessor's data has loaded
 * (1Password credential provider plan, Task 4). Composes
 * `op://${vault.title}/${item.title}/${field.title}` — the reference shape
 * `PutCredentialRequest.onepassword.reference` and the CLI/SDK's own
 * `op://` syntax expect.
 */
export function OnePasswordPicker({ scope, onCompose }: OnePasswordPickerProps) {
  const [vaultId, setVaultId] = useState("");
  const [itemId, setItemId] = useState("");
  const [fieldId, setFieldId] = useState("");

  const vaultsQ = useOpVaults(scope);
  const itemsQ = useOpItems(scope, vaultId || undefined);
  const itemDetailQ = useOpItemDetail(scope, vaultId || undefined, itemId || undefined);

  // Changing `scope` (e.g. the tokenScope selector next to this picker)
  // invalidates every downstream choice — the vault/item/field ids belong
  // to the previous scope's token.
  useEffect(() => {
    setVaultId("");
    setItemId("");
    setFieldId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const vaults = vaultsQ.data?.vaults ?? [];
  const items = itemsQ.data?.items ?? [];
  const fields = itemDetailQ.data?.fields ?? [];

  const error = vaultsQ.error
    ? apiErrorMessage(vaultsQ.error, "Failed to load 1Password vaults.")
    : itemsQ.error
      ? apiErrorMessage(itemsQ.error, "Failed to load 1Password items.")
      : itemDetailQ.error
        ? apiErrorMessage(itemDetailQ.error, "Failed to load 1Password fields.")
        : null;

  function selectVault(id: string) {
    setVaultId(id);
    setItemId("");
    setFieldId("");
  }

  function selectItem(id: string) {
    setItemId(id);
    setFieldId("");
  }

  function selectField(id: string) {
    setFieldId(id);
    const vault = vaults.find((v) => v.id === vaultId);
    const item = items.find((i) => i.id === itemId);
    const field = fields.find((f) => f.id === id);
    if (!vault || !item || !field) return;
    onCompose({ reference: `op://${vault.title}/${item.title}/${field.title}`, tokenScope: scope });
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="op-picker-vault">Vault</Label>
        <select
          id="op-picker-vault"
          className={SELECT_CLASS}
          value={vaultId}
          disabled={vaultsQ.isLoading}
          onChange={(e) => selectVault(e.target.value)}
        >
          <option value="">Select a vault…</option>
          {vaults.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="op-picker-item">Item</Label>
        <select
          id="op-picker-item"
          className={SELECT_CLASS}
          value={itemId}
          disabled={!vaultId || itemsQ.isLoading}
          onChange={(e) => selectItem(e.target.value)}
        >
          <option value="">Select an item…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="op-picker-field">Field</Label>
        <select
          id="op-picker-field"
          className={SELECT_CLASS}
          value={fieldId}
          disabled={!itemId || itemDetailQ.isLoading}
          onChange={(e) => selectField(e.target.value)}
        >
          <option value="">Select a field…</option>
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}
