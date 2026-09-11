import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

const FIELD_BASE =
  "w-full rounded border bg-[--bg] text-[--fg] placeholder:text-muted " +
  "border-[--border] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 " +
  "focus-visible:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(FIELD_BASE, "h-9 px-3 text-sm max-sm:min-h-11 max-sm:text-base", className)}
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
      className={cn(FIELD_BASE, "px-3 py-2 text-sm max-sm:text-base resize-y leading-relaxed", className)}
      {...rest}
    />
  );
});
