import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { cn } from "~/lib/cn";
import type { AppPath } from "./link-tabs.js";

export type ManagedScope = "org" | "team";

const OWNER: Record<ManagedScope, string> = { org: "organization", team: "team" };
const PLACE: Record<ManagedScope, string> = { org: "Organization settings", team: "team settings" };

/**
 * The one line for a setting that a higher scope or the viewer's role locks.
 * Put it next to the control and keep the control on the page, disabled.
 * A viewer who can change it at the higher scope gets a link there
 * (`changeAt`); anyone else gets "Ask an admin to change it." (`askAdmin`).
 */
export function ManagedNote({ scope, askAdmin = false, changeAt, className }: {
  scope: ManagedScope;
  /** Adds "Ask an admin to change it." for a viewer who cannot change it. */
  askAdmin?: boolean;
  /** The page where this viewer can change it. Wins over `askAdmin`. */
  changeAt?: AppPath;
  className?: string;
}) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted", className)}>
      <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>
        {`Managed by your ${OWNER[scope]}.`}
        {changeAt ? (
          <>
            {" Change it in "}
            <Link to={changeAt} className="text-ink underline-offset-2 hover:underline">{PLACE[scope]}</Link>.
          </>
        ) : askAdmin ? " Ask an admin to change it." : null}
      </span>
    </p>
  );
}
