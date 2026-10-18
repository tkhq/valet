import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "~/lib/cn";

// The surface that every text field and native select shares: border, colors,
// and focus ring. Each control sets its own width, because a select often sits
// inline in a row of filters.
const FIELD_BASE =
  "rounded border bg-[--bg] text-[--fg] placeholder:text-muted caret-moss selection:bg-moss-wash selection:text-ink " +
  "border-[--border] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 " +
  "focus-visible:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
  "max-sm:rounded-xl max-sm:shadow-sm max-sm:hover:border-muted max-sm:focus-visible:border-moss max-sm:focus-visible:ring-4 max-sm:focus-visible:ring-moss-wash motion-reduce:transition-none";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(FIELD_BASE, "h-9 w-full px-3 text-sm max-sm:min-h-12 max-sm:text-base", className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(FIELD_BASE, "w-full px-3 py-2 text-sm max-sm:py-3 max-sm:text-base resize-y leading-relaxed", className)}
      {...rest}
    />
  );
});

export type SelectSize = "md" | "sm";

// On a phone, a select uses a 16px font, so iOS does not zoom on focus, and a
// touch target of 44px or more.
const SELECT_SIZE: Record<SelectSize, string> = {
  md: "h-9 px-3 text-sm max-sm:min-h-12 max-sm:text-base",
  sm: "h-8 px-2 text-xs max-sm:min-h-11 max-sm:text-base",
};

// The app does not use the native `size` attribute (the count of visible
// rows), so the prop name holds the visual size.
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: SelectSize;
}

/**
 * A native `<select>` with the field surface of `Input`. Use it for a form
 * field or a filter, and use `SelectMenu` when an option needs custom content.
 * It has no default width: pass `w-full` for a form field.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = "md", ...rest },
  ref,
) {
  return <select ref={ref} className={cn(FIELD_BASE, SELECT_SIZE[size], className)} {...rest} />;
});
