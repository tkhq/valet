import { useState } from "react";
import { Pencil } from "lucide-react";
import type { GetOrchestratorInfoResponse, OrchestratorPresence } from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { PresenceMark } from "./presence-mark";
import { IdentityFields } from "./identity-fields";

/**
 * Dashboard hero (assistant-centered web UI, decision 10/11): the presence
 * mark plus a one-line status derived from live presence + unsettled
 * children, and an edit affordance that reopens `IdentityFields` inline,
 * prefilled, for renaming / re-personality.
 */
export function presenceStatusLine(
  presence: OrchestratorPresence,
  activeChildren: number,
): string {
  if (presence === "working") {
    return `working on ${activeChildren} task${activeChildren === 1 ? "" : "s"}`;
  }
  return presence;
}

export function IdentityHeader({ info }: { info: GetOrchestratorInfoResponse }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="rounded-lg border border-line bg-paper px-6 py-6">
        <IdentityFields
          variant="edit"
          initialName={info.name}
          initialPersonality={info.personality}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  const name = info.name ?? "Valet";

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        {/* The hero is the dashboard's only title, so the name carries the
            page's `h1`. Without it the first heading on `/` is a card `h2`. */}
        <PresenceMark name={name} state={info.presence} size="hero" as="h1" />
        <p className="mt-1 text-sm text-muted">
          {presenceStatusLine(info.presence, info.activeChildren)}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Edit ${name}'s name and personality`}
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}
