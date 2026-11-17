import { Lock } from "lucide-react";
import { cn } from "~/lib/cn";

export type ManagedScope = "org" | "team";

const OWNER: Record<ManagedScope, string> = { org: "organization", team: "team" };

/**
 * The one line for a setting that a higher scope or the viewer's role locks.
 * Put it next to the control and keep the control on the page, disabled.
 */
export function ManagedNote({ scope, askAdmin = false, className }: {
  scope: ManagedScope;
  /** Adds "Ask an admin to change it." for a viewer who cannot change it. */
  askAdmin?: boolean;
  className?: string;
}) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted", className)}>
      <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>{`Managed by your ${OWNER[scope]}.${askAdmin ? " Ask an admin to change it." : ""}`}</span>
    </p>
  );
}
