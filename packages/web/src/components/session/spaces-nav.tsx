import type { ReactNode } from "react";
import { ChevronDown, User, Users } from "lucide-react";
import { useSelectWorkspace, useWorkspaceOptions } from "~/components/layout/workspace-switcher";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * The thread sidebar's Spaces: Personal, then each team. The active space is
 * open and holds its Projects and threads (`children`); every other space is
 * one row that switches to it. With one space there is nothing to choose, so
 * the list renders `children` alone, as before teams existed. So does a
 * phone (`bare`), whose drawer keeps its own space dropdown.
 */
export function SpacesNav({ bare = false, children }: { bare?: boolean; children: ReactNode }) {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  const select = useSelectWorkspace();
  if (bare || options.length < 2) return <>{children}</>;
  return <section aria-label="Spaces" className="mt-2 border-t border-line pt-2">
    <h2 className="px-4 pb-1 text-xs font-medium text-muted">Spaces</h2>
    {options.map((option) => {
      const active = option.key === scope.key;
      const Icon = option.isTeam ? Users : User;
      const row = <>
        <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", !active && "-rotate-90")} />
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="flex-1 truncate">{option.label}</span>
      </>;
      const rowClass = "flex w-full items-center gap-2 py-1.5 pl-3 pr-3 text-left text-sm";
      return active
        ? <div key={option.key} role="group" aria-label={option.label}>
          <div aria-current="true" className={cn(rowClass, "font-medium text-ink")}>{row}</div>
          {children}
        </div>
        : <button key={option.key} type="button" onClick={() => select(option.key)} aria-label={`Open space ${option.label}`}
          className={cn(rowClass, "text-ink/85 hover:bg-ink-wash/60 focus-visible:bg-ink-wash focus-visible:outline-none")}>{row}</button>;
    })}
  </section>;
}
