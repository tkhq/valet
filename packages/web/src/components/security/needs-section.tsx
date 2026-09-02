import { useState } from "react";
import type { SecurityNeedWire } from "@valet/api/wire";
import { Button, Textarea } from "~/components/primitives";
import { apiErrorText, useResolveNeeds } from "~/api/security";
import { cn } from "~/lib/cn";

/**
 * The pivot-coordinator needs section (pivot-coordinator + needs loop, M-P4c,
 * spec §Pivot-coordinator). A persona that cannot go deeper records a need. The
 * coordinator auto-resolves what is already-authorized (shown informational)
 * and surfaces the rest to ONE consolidated human ask. Each needs-human item
 * gets an input and a "Resolve & continue" action that posts to the resolve
 * route; the answer resets the affected cell for a delta re-run.
 *
 * Renders nothing when the engagement recorded no needs, so a review with none
 * adds no clutter. The auto-resolved and answered/dismissed items are read-only
 * context; only needs-human items get the resolve control (admin-gated).
 */
export function NeedsSection({
  sessionId,
  needs,
  canAdminister,
}: {
  sessionId: string;
  needs: SecurityNeedWire[];
  canAdminister: boolean;
}) {
  if (needs.length === 0) return null;
  const needsHuman = needs.filter((n) => n.status === "needs_human");
  const autoResolved = needs.filter((n) => n.status === "auto_resolved");
  const settled = needs.filter((n) => n.status === "answered" || n.status === "dismissed");

  return (
    <section className="border-b border-line px-4 py-3" aria-label="Needs">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-ink">Needs</span>
        <span className="text-muted tabular-nums">
          {needsHuman.length} waiting · {autoResolved.length} auto-resolved
        </span>
      </div>

      {needsHuman.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {needsHuman.map((need) => (
            <NeedsHumanItem
              key={need.id}
              sessionId={sessionId}
              need={need}
              canAdminister={canAdminister}
            />
          ))}
        </ul>
      )}

      {autoResolved.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {autoResolved.map((need) => (
            <li
              key={need.id}
              className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-ink"
            >
              <span className="font-medium">Auto-resolved: {need.description}</span>
              <span className="text-muted"> [{need.kind}]</span>
              {need.resolution && <span className="block text-muted">{need.resolution}</span>}
            </li>
          ))}
        </ul>
      )}

      {settled.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {settled.map((need) => (
            <li key={need.id} className="px-2.5 py-1 text-[11px] text-muted">
              <span className="capitalize">{need.status}</span>: {need.description}
              {need.resolution && <span className="block">{need.resolution}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NeedsHumanItem({
  sessionId,
  need,
  canAdminister,
}: {
  sessionId: string;
  need: SecurityNeedWire;
  canAdminister: boolean;
}) {
  const [answer, setAnswer] = useState("");
  // Part 10: a cred-typed need routes through the vault. State is a mini
  // credential draft (label, kind, value); values are discarded from React
  // state as soon as the mutation lands.
  const [credLabel, setCredLabel] = useState("");
  const [credKind, setCredKind] = useState<
    | "password"
    | "session"
    | "headerToken"
    | "mtls"
    | "signingKey"
    | "toolAuth"
    | "testData"
  >("headerToken");
  const [credValue, setCredValue] = useState("");
  const resolve = useResolveNeeds(sessionId);
  const isCredKind = need.kind === "credential";

  const canSubmit = isCredKind
    ? credLabel.trim() !== "" && credValue !== ""
    : answer.trim() !== "";

  return (
    <li className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-ink">
      <div className="font-medium">{need.description}</div>
      <div className="text-muted">
        [{need.kind}] — blocks its cell until you answer.
      </div>
      {canAdminister && (
        <div className="mt-1.5 space-y-1.5">
          {isCredKind ? (
            <div
              className="space-y-1.5 rounded border border-line/60 p-2"
              data-testid="needs-cred-form"
            >
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="text-[10px] text-muted">Label</label>
                  <input
                    className="block w-full rounded border border-line bg-transparent px-1.5 py-1 text-[11px]"
                    value={credLabel}
                    placeholder="admin"
                    onChange={(e) => setCredLabel(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted">Kind</label>
                  <select
                    className="block w-full rounded border border-line bg-transparent px-1.5 py-1 text-[11px]"
                    value={credKind}
                    onChange={(e) =>
                      setCredKind(
                        e.target.value as
                          | "password"
                          | "session"
                          | "headerToken"
                          | "mtls"
                          | "signingKey"
                          | "toolAuth"
                          | "testData",
                      )
                    }
                  >
                    <option value="headerToken">Header token</option>
                    <option value="password">Password login</option>
                    <option value="session">Session jar</option>
                    <option value="mtls">mTLS cert+key</option>
                    <option value="signingKey">Signing key</option>
                    <option value="toolAuth">Tool auth blob</option>
                    <option value="testData">Test data</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-muted">Value (secret)</label>
                <input
                  type="password"
                  className="block w-full rounded border border-line bg-transparent px-1.5 py-1 text-[11px]"
                  value={credValue}
                  onChange={(e) => setCredValue(e.target.value)}
                  placeholder="The plaintext value the persona needs."
                />
              </div>
              <p className="text-[10px] text-muted">
                Encrypted at rest. Delivered to the persona at
                {" "}
                <code>/etc/valet/creds/vault-&lt;label&gt;.&lt;ext&gt;</code>.
              </p>
            </div>
          ) : (
            <Textarea
              rows={2}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={
                need.kind === "decision"
                  ? "Your decision…"
                  : "The scope, dependency, or decision the persona needs…"
              }
              className="text-[11px]"
            />
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!canSubmit || resolve.isPending}
              onClick={() => {
                const payload = isCredKind
                  ? [
                      {
                        needId: need.id,
                        credentialInput: {
                          label: credLabel.trim(),
                          kind: credKind,
                          value: credValue,
                        },
                      },
                    ]
                  : [{ needId: need.id, resolution: answer }];
                resolve.mutate(payload, {
                  onSuccess: () => {
                    setAnswer("");
                    setCredLabel("");
                    setCredValue("");
                  },
                });
              }}
            >
              Resolve &amp; continue
            </Button>
            <button
              type="button"
              disabled={resolve.isPending}
              className={cn(
                "text-[11px] text-muted underline-offset-2 hover:underline",
                resolve.isPending && "opacity-50",
              )}
              onClick={() =>
                resolve.mutate([
                  { needId: need.id, resolution: answer, dismiss: true },
                ])
              }
            >
              Dismiss
            </button>
          </div>
          {resolve.isError && (
            <div className="text-danger-600">{apiErrorText(resolve.error)}</div>
          )}
        </div>
      )}
    </li>
  );
}
