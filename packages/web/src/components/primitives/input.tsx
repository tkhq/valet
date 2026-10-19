import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "~/lib/cn";
import { CONTROL_SIZE, type ControlSize } from "./control.js";

// The surface that every text field and native select shares: border, colors,
// and focus ring. Each control sets its own width, because a select often sits
// inline in a row of filters.
const FIELD_BASE =
  "rounded border bg-[--bg] text-[--fg] placeholder:text-muted caret-moss selection:bg-moss-wash selection:text-ink " +
  "border-[--border] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 " +
  "focus-visible:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
  "max-sm:rounded-xl max-sm:shadow-sm max-sm:hover:border-muted max-sm:focus-visible:border-moss max-sm:focus-visible:ring-4 max-sm:focus-visible:ring-moss-wash motion-reduce:transition-none";

// A field takes its height from the shared control scale. On a phone, its text
// is 16px, so iOS does not zoom on focus.
const FIELD_SIZE: Record<ControlSize, string> = {
  md: `${CONTROL_SIZE.md} px-3 max-sm:text-base`,
  sm: `${CONTROL_SIZE.sm} px-2.5 max-sm:text-base`,
};

// The app does not use the native `size` attribute (a width in characters on an
// input, a count of visible rows on a select), so the prop holds the visual size.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: ControlSize;
}

/** A text, date, or number field. Use `size="sm"` in a toolbar or filter row. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "md", ...rest },
  ref,
) {
  return <input ref={ref} className={cn(FIELD_BASE, FIELD_SIZE[size], "w-full", className)} {...rest} />;
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

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: ControlSize;
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
  return <select ref={ref} className={cn(FIELD_BASE, FIELD_SIZE[size], className)} {...rest} />;
});
