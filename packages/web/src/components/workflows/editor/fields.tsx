/**
 * Shared field components for the inspector forms (plan decision 10,
 * inspector half — Task 10). Thin wrappers over the house primitives
 * (`~/components/primitives`) so every per-type form in `inspector.tsx`
 * looks and behaves the same instead of hand-rolling labeled inputs.
 *
 * Each field pairs its `Label` with the control via `htmlFor`/`id`
 * (`useId`) rather than nesting the control inside the `<label>` element —
 * `Label` itself renders a `<label>` tag (see `primitives/label.tsx`), so
 * nesting would produce invalid, doubly-wrapped markup.
 */
import { useId, useState } from "react";
import { Input, Label, Textarea } from "~/components/primitives";
import { cn } from "~/lib/cn";

// ─── text / textarea ──────────────────────────────────────────────────────

export interface LabeledInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function LabeledInput({ label, value, onChange, placeholder }: LabeledInputProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

export interface LabeledTextareaProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export function LabeledTextarea({ label, value, onChange, placeholder, rows }: LabeledTextareaProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} />
    </div>
  );
}

// ─── number ───────────────────────────────────────────────────────────────

export interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** Empty input propagates `undefined` (field omitted from the node) rather than `0` or `NaN`. */
export function NumberField({ label, value, onChange, min, max, step }: NumberFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw.trim() === "") {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isNaN(parsed)) onChange(parsed);
        }}
      />
    </div>
  );
}

// ─── select ───────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
}

const SELECT_CLASS =
  "h-9 w-full rounded border border-line bg-paper px-3 text-sm text-ink transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss";

export function SelectField({ label, value, onChange, options }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── JSON textarea ────────────────────────────────────────────────────────

export interface JsonTextareaProps {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  rows?: number;
  placeholder?: string;
}

/**
 * Holds its own text buffer so keystrokes never get clobbered by a parent
 * re-render mid-edit, and only calls `onChange` when the buffer parses as
 * valid JSON — an in-progress edit (or a typo) shows an inline error
 * instead of silently discarding the definition's current value.
 *
 * Callers that need to reset the buffer when the underlying node changes
 * (e.g. switching the selected node in the inspector) should remount this
 * component with a `key` tied to the node id — see `inspector.tsx`.
 */
export function JsonTextarea({ label, value, onChange, rows = 4, placeholder }: JsonTextareaProps) {
  const id = useId();
  const [text, setText] = useState(() => stringifyForEdit(value));
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: string) {
    setText(next);
    if (next.trim() === "") {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      setError(null);
      onChange(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid JSON");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={cn("font-mono text-xs", error && "border-danger-500 focus-visible:ring-danger-500/40")}
        aria-invalid={error !== null}
      />
      {error && (
        <span role="alert" className="text-xs text-danger-600 dark:text-danger-500">
          {error}
        </span>
      )}
    </div>
  );
}

function stringifyForEdit(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}
