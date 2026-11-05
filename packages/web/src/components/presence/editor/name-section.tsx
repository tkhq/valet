/**
 * The editor's **Name** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 6): a text field that starts with a name suggested from the
 * sentence. The reader keeps it or types another.
 */
import { useId } from "react";
import { Button, Input, Label } from "~/components/primitives";

export function NameSection({ name, edited, suggestion, onChange, onUseSuggestion }: {
  /** The name the field shows: the reader's, else the suggestion. */
  name: string;
  /** True once the reader typed a name. */
  edited: boolean;
  suggestion: string;
  onChange: (name: string) => void;
  onUseSuggestion: () => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>Name</Label>
      <Input id={id} value={name} maxLength={120} onChange={(e) => onChange(e.target.value)} placeholder="Name" />
      {!edited && suggestion.length > 0 && <p className="text-xs text-muted">Suggested from the sentence.</p>}
      {edited && suggestion.length > 0 && name !== suggestion && (
        <Button type="button" variant="ghost" size="sm" className="h-auto justify-self-start px-1 py-0 text-xs font-normal text-muted" onClick={onUseSuggestion}>
          Use the suggestion
        </Button>
      )}
    </div>
  );
}
