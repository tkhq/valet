import { useEffect, useRef, useState } from "react";
import type { SecurityEngagementWire } from "@valet/api/wire";
import { Button, Input, Label } from "~/components/primitives";
import { useSetEngagementConfig, apiErrorText } from "~/api/security";

/**
 * The threat categories the panel offers (dynamic-config M-P2a). Mirrors the
 * plugin's `KNOWN_CATEGORIES` ids with a short label each. The server is the
 * authority — it validates every saved id against `isKnownCategory` — so this
 * static list only has to name the ids and read well in the checkbox list. Keep
 * it in step with `packages/plugin-security/src/lib/categories.ts`.
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

function categoryLabel(id: string): string {
  return KNOWN_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/**
 * The focus + invariants editor (dynamic-config M-F3, spec §Dynamic
 * configuration). Focus weights the review; a stated invariant turns a
 * confirmed violation into a high-signal finding. Both ride on every persona
 * dispatch (the engine injects them in `buildDispatchPrompt`).
 *
 * During planning an admin edits them and Saves; the server refuses a running
 * engagement, so once the review runs (or closes) the panel shows the active
 * focus + invariants READ-ONLY, so the user sees what the review was told.
 *
 * Mount-time-state rule: the draft seeds from the engagement's saved values and
 * resyncs when they change, UNLESS the admin has already edited it — a manual
 * edit must win over a background poll.
 */
export function ConfigEditor({
  sessionId,
  engagement,
  editable,
}: {
  sessionId: string;
  engagement: SecurityEngagementWire;
  /** True during planning for an admin; false once running/closed. */
  editable: boolean;
}) {
  const savedFocus = engagement.focus ?? "";
  const savedInvariants = engagement.invariants ?? [];
  const savedCategories = engagement.categories ?? [];

  if (!editable) {
    const hasFocus =
      savedFocus.trim() !== "" || savedInvariants.length > 0 || savedCategories.length > 0;
    const hasLive =
      (engagement.authorizedScope?.hosts.length ?? 0) > 0 ||
      (engagement.configTools?.length ?? 0) > 0;
    // Nothing to show when the review carried no focus, invariants, categories,
    // scope, or declared tools.
    if (!hasFocus && !hasLive) return null;
    return (
      <div className="border-b border-line px-4 py-3" data-testid="config-readonly">
        {hasFocus && <h3 className="text-xs font-semibold text-ink">Review focus</h3>}
        {savedFocus.trim() !== "" && (
          <p className="mt-1 text-[11px] text-muted" data-testid="config-readonly-focus">
            {savedFocus}
          </p>
        )}
        {savedInvariants.length > 0 && (
          <div className="mt-2">
            <span className="text-[11px] font-medium text-muted">Known invariants</span>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-ink">
              {savedInvariants.map((inv, i) => (
                <li key={i}>{inv}</li>
              ))}
            </ul>
          </div>
        )}
        {savedCategories.length > 0 && (
          <div className="mt-2" data-testid="config-readonly-categories">
            <span className="text-[11px] font-medium text-muted">Threat categories loaded</span>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-ink">
              {savedCategories.map((id) => (
                <li key={id}>{categoryLabel(id)}</li>
              ))}
            </ul>
          </div>
        )}
        <LiveTestingPanel engagement={engagement} />
      </div>
    );
  }

  return (
    <>
      <ConfigEditorForm
        sessionId={sessionId}
        savedFocus={savedFocus}
        savedInvariants={savedInvariants}
        savedCategories={savedCategories}
      />
      <LiveTestingPanel engagement={engagement} />
    </>
  );
}

/**
 * The "Live testing" affordance (M-P4b). Shows the authorized scope and the
 * declared live tools an engagement carries. Authorization-sensitive: when a
 * plan runs live personas, the scope names the exact hosts they may reach. The
 * scope and tools are declared in the repo's `.valet/security.yml` and are
 * read-only here — a human commits the scope, so the UI never edits it.
 *
 * Renders nothing when the engagement declares no scope and no tools.
 */
function LiveTestingPanel({ engagement }: { engagement: SecurityEngagementWire }) {
  const hosts = engagement.authorizedScope?.hosts ?? [];
  const tools = engagement.configTools ?? [];
  if (hosts.length === 0 && tools.length === 0) return null;
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="live-testing">
      <h3 className="text-xs font-semibold text-ink">Live testing</h3>
      {hosts.length > 0 ? (
        <div className="mt-1" data-testid="live-authorized-scope">
          <span className="text-[11px] font-medium text-muted">Authorized scope (hosts)</span>
          <ul className="mt-1 list-disc pl-4 text-[11px] text-ink">
            {hosts.map((host) => (
              <li key={host}>{host}</li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted">
            Live personas reach only these hosts. Egress is allowlisted to this scope.
          </p>
        </div>
      ) : (
        tools.length > 0 && (
          <p className="mt-1 text-[11px] text-muted" data-testid="live-no-scope">
            No authorized scope is declared. Live personas have no target.
          </p>
        )
      )}
      {tools.length > 0 && (
        <div className="mt-2" data-testid="live-declared-tools">
          <span className="text-[11px] font-medium text-muted">Declared tools</span>
          <ul className="mt-1 list-disc pl-4 text-[11px] text-ink">
            {tools.map((tool) => (
              <li key={tool.id}>
                {tool.id}
                {tool.egress && tool.egress.length > 0 ? (
                  <span className="text-muted"> — egress: {tool.egress.join(", ")}</span>
                ) : tool.mcp ? (
                  <span className="text-muted"> — MCP: {tool.mcp.url}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConfigEditorForm({
  sessionId,
  savedFocus,
  savedInvariants,
  savedCategories,
}: {
  sessionId: string;
  savedFocus: string;
  savedInvariants: string[];
  savedCategories: string[];
}) {
  const [focus, setFocus] = useState(savedFocus);
  const [invariants, setInvariants] = useState<string[]>(savedInvariants);
  const [categories, setCategories] = useState<string[]>(savedCategories);
  const userTouched = useRef(false);
  const lastSignature = useRef(signature(savedFocus, savedInvariants, savedCategories));

  useEffect(() => {
    const sig = signature(savedFocus, savedInvariants, savedCategories);
    if (sig === lastSignature.current) return;
    lastSignature.current = sig;
    if (userTouched.current) return;
    setFocus(savedFocus);
    setInvariants(savedInvariants);
    setCategories(savedCategories);
  }, [savedFocus, savedInvariants, savedCategories]);

  const save = useSetEngagementConfig(sessionId);

  function touchFocus(value: string) {
    userTouched.current = true;
    setFocus(value);
  }

  function touchInvariants(next: string[]) {
    userTouched.current = true;
    setInvariants(next);
  }

  function toggleCategory(id: string) {
    userTouched.current = true;
    setCategories((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function onSave() {
    userTouched.current = false;
    save.mutate({
      focus: focus.trim() === "" ? null : focus.trim(),
      invariants: invariants.map((inv) => inv.trim()).filter((inv) => inv !== ""),
      // Preserve the KNOWN_CATEGORIES order, not the toggle order.
      categories: KNOWN_CATEGORIES.filter((c) => categories.includes(c.id)).map((c) => c.id),
    });
  }

  return (
    <div className="border-b border-line px-4 py-3" data-testid="config-editor">
      <h3 className="text-xs font-semibold text-ink">Review focus</h3>
      <p className="mt-1 text-[11px] text-muted">
        Focus the review and list invariants you already know. The review flags a
        broken invariant as a high-signal finding. Both freeze once it starts.
      </p>

      <div className="mt-3 grid gap-1">
        <Label htmlFor="config-focus">Focus (optional)</Label>
        <textarea
          id="config-focus"
          value={focus}
          onChange={(e) => touchFocus(e.target.value)}
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
                  touchInvariants(invariants.map((v, i) => (i === index ? e.target.value : v)))
                }
                placeholder="e.g. every admin route sits behind requireAdmin"
                className="h-8 flex-1 text-xs"
                aria-label={`Invariant ${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => touchInvariants(invariants.filter((_, i) => i !== index))}
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
            onClick={() => touchInvariants([...invariants, ""])}
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

      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save focus"}
        </Button>
        {save.isSuccess && !save.isPending && !userTouched.current && (
          <span className="text-[11px] text-moss" data-testid="config-saved">
            Saved
          </span>
        )}
      </div>

      {save.isError && (
        <p className="mt-2 text-[11px] text-danger-600" data-testid="config-save-error">
          {apiErrorText(save.error)}
        </p>
      )}
    </div>
  );
}

/** A stable signature of the saved config, so the resync effect fires only on a
 * real change, not on every poll's fresh array identity. */
function signature(focus: string, invariants: string[], categories: string[]): string {
  return JSON.stringify([focus, invariants, categories]);
}
