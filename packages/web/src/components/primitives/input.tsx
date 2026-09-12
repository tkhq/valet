import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

const FIELD_BASE =
  "w-full rounded border bg-[--bg] text-[--fg] placeholder:text-muted caret-moss selection:bg-moss-wash selection:text-ink " +
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
      className={cn(FIELD_BASE, "h-9 px-3 text-sm max-sm:min-h-12 max-sm:px-3.5 max-sm:text-base", className)}
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
      className={cn(FIELD_BASE, "px-3 py-2 text-sm max-sm:px-3.5 max-sm:py-3 max-sm:text-base resize-y leading-relaxed", className)}
      {...rest}
    />
  );
});
