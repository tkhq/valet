export interface SubjectRef { type: string; id: string }
export interface TagSubject extends SubjectRef {
  text: string;
  userId: string | null;
  ownerType: "user" | "team";
  ownerId: string;
  /** Only renderer-supplied metadata can drive deterministic rules. */
  command?: string;
}
export interface KeySeed { key: string; label: string; definition: string }
export interface Dimension {
  id: string;
  mode: "single" | "multi";
  open: boolean;
  seeds: readonly KeySeed[];
  instructions: string;
  rules?: (subject: TagSubject) => string | undefined;
  maxActiveKeys: number;
  subjectTypes: readonly string[];
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32).replace(/_+$/g, "");
}
export function validKey(value: string): boolean { return /^[a-z][a-z0-9_]{0,31}$/.test(value); }

export function defineDimension(def: Omit<Dimension, "maxActiveKeys"> & { maxActiveKeys?: number }): Dimension {
  const seeds = [...def.seeds];
  if (!seeds.some(seed => seed.key === "other")) seeds.push({ key: "other", label: "Other", definition: "A purpose that does not fit another key." });
  const maxActiveKeys = def.maxActiveKeys ?? 100;
  if (!validKey(def.id) || !def.subjectTypes.length || !def.instructions.trim() || !Number.isInteger(maxActiveKeys) || maxActiveKeys < seeds.length || maxActiveKeys > 1000) {
    throw new Error("Invalid tag dimension. Set an id, subject types, instructions, and a key limit that includes the seeds.");
  }
  if (new Set(seeds.map(seed => seed.key)).size !== seeds.length || seeds.some(seed => !validKey(seed.key) || !seed.label.trim() || !seed.definition.trim())) {
    throw new Error("Invalid tag seeds. Use unique snake_case keys with labels and definitions.");
  }
  return { ...def, seeds, maxActiveKeys };
}

/** Conservative UTF-8 bound: each byte costs at most one token in supported tokenizers. */
export function capSubjectText(text: string, tokenCap = 1024): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, tokenCap)).replace(/\uFFFD$/u, "");
}
