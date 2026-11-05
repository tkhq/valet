/**
 * A link to an archived thread, kept in place but disabled
 * (docs/specs/2026-10-16-presence-hub-design.md Part F step 3). An archived
 * thread takes no deliveries, so its name shows, and nothing opens.
 */
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

export function ArchivedThreadLink({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span role="link" aria-disabled="true" title="This thread is archived." className={cn("opacity-70", className)}>
      {children}
    </span>
  );
}
