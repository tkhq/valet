import * as RPopover from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "~/lib/cn";

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;

/**
 * Portalled popover panel. Radix handles what a hand-rolled
 * `position: absolute` panel can't: it escapes `overflow` scroll
 * containers, repositions on collision, and closes on Escape or an
 * outside click.
 *
 * `@radix-ui/react-popover` is pinned (no caret) to the release generation
 * of the resolved `@radix-ui/react-dialog`. Radix packages pin their
 * internals (`react-dismissable-layer`, `react-focus-scope`) exactly; a
 * newer popover forks those singletons into second copies, and a popover
 * nested in a dialog then breaks Escape/outside-click layering. When you
 * bump one Radix package, bump them together and check
 * `pnpm why -r @radix-ui/react-dismissable-layer` stays at one version.
 */
export const PopoverContent = forwardRef<
  ElementRef<typeof RPopover.Content>,
  ComponentPropsWithoutRef<typeof RPopover.Content>
>(function PopoverContent({ className, align = "end", sideOffset = 4, ...rest }, ref) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-lg border border-line bg-[--bg] p-3 shadow-xl outline-none " +
            "data-[state=open]:animate-in data-[state=closed]:animate-out " +
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          className,
        )}
        {...rest}
      />
    </RPopover.Portal>
  );
});
