import type { ReactNode } from "react";
import { User, Users } from "lucide-react";
import { useSelectWorkspace, useWorkspaceOptions } from "~/components/layout/workspace-switcher";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * The thread sidebar's Spaces: Personal, then each team, as one short list.
 * The open space is marked, and its Projects and threads (`children`) follow
 * the list; any other row switches to that space. With one space there is nothing to choose, so
 * the list renders `children` alone, as before teams existed. So does a
 * phone (`bare`), whose drawer keeps its own space dropdown.
 */
export function SpacesNav({ bare = false, children }: { bare?: boolean; children: ReactNode }) {
  const options = useWorkspaceOptions();
  const scope = useWorkspaceScope();
  const select = useSelectWorkspace();
  if (bare || options.length < 2) return <>{children}</>;
  const active = options.find((option) => option.key === scope.key);
  return <section aria-label="Spaces" className="mt-2 border-t border-line pt-2">
    <h2 className="px-4 pb-1 text-xs font-medium text-muted">Spaces</h2>
    {/* Every space stays near the top; the open space's threads follow the list. */}
    <ul className="pb-1">
      {options.map((option) => {
        const open = option.key === scope.key;
        const Icon = option.isTeam ? Users : User;
        return <li key={option.key}>
          <button type="button" aria-current={open || undefined} onClick={() => select(option.key)} aria-label={open ? option.label : `Open space ${option.label}`}
            className={cn("flex w-full items-center gap-2 border-l-2 py-1.5 pr-3 text-left text-sm focus-visible:bg-ink-wash focus-visible:outline-none",
              open ? "border-moss bg-moss-wash pl-[calc(1rem-2px)] font-medium text-ink" : "border-transparent pl-4 text-ink/85 hover:bg-ink-wash/60")}>
            <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="flex-1 truncate">{option.label}</span>
          </button>
        </li>;
      })}
    </ul>
    <div role="group" aria-label={active?.label ?? "Space"} className="border-t border-line/60">{children}</div>
  </section>;
}