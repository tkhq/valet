/**
 * The bundled brain snapshot. `data/brain.json` is generated from the
 * xors-brain repo by scripts/build.py, which withholds entries above the
 * chosen sensitivity. The data stays JSON on purpose: as a TypeScript literal
 * it is one ~400 KB expression, and `tsc` runs out of heap on it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BrainDoc {
  id: string;
  title: string;
  section: string;
  type: string;
  status: string;
  sensitivity: string;
  updated: string;
  summary: string;
  links: string[];
  tags: string[];
  body: string;
  /** Token count of the weighted searchable text, for BM25 length normalization. */
  len: number;
  /** Term frequencies over that same weighted text. */
  tf: Record<string, number>;
}

export interface BrainBundle {
  built: string;
  maxSensitivity: string;
  avgLen: number;
  stopwords: string[];
  docs: BrainDoc[];
}

const bundle = JSON.parse(
  readFileSync(fileURLToPath(new URL("../data/brain.json", import.meta.url)), "utf8"),
) as BrainBundle;

export const BUILT = bundle.built;
export const MAX_SENSITIVITY = bundle.maxSensitivity;
export const AVG_LEN = bundle.avgLen;
export const STOPWORDS = bundle.stopwords;
export const DOCS = bundle.docs;
