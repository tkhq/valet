import type { ReactNode } from "react";
import { Button } from "./button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * A pick-one control styled as a `DropdownMenu`: a trigger button showing
 * the current selection's label, opening a list of options. Replaces the
 * repeated trigger-Button + DropdownMenuContent + option-map pattern that
 * shows up anywhere a small enum is chosen from a button instead of a
 * native `<select>` (filter pickers, single-target choosers).
 */
export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  triggerLabel,
  triggerClassName,
  align = "start",
}: {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  /** Overrides the trigger's label; defaults to the selected option's label. */
  triggerLabel?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className={triggerClassName}>
          {triggerLabel ?? current?.label ?? value}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
