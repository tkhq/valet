import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

/**
 * The one card box: radius, border, and paper ground. Use it on any element
 * (`cn(cardClass, ...)`) so a section, list, or form keeps its own semantics.
 * Content inside a card starts 20px in (`px-5`), the same line as `WorkRow`
 * titles, so every boxed surface lines up.
 */
export const cardClass = "rounded-lg border border-line bg-paper";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          cardClass,
          className,
        )}
        {...rest}
      />
    );
  },
);

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-3 border-b border-line", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-tight", className)} {...rest} />;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 py-3 border-t border-line flex justify-end gap-2", className)} {...rest} />
  );
}
