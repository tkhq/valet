/**
 * Output + argument-parsing helpers shared by CLI command modules. No
 * external deps — a tiny, typed flag parser plus stdout/stderr writers.
 */

export interface ParsedFlags {
  /** Whether `--json` was present. */
  json: boolean;
  /** Positional args (everything that wasn't a `--flag`). */
  rest: string[];
  /** All parsed flags, including `--json`. Value is a string or `true` (bool). */
  flags: Record<string, string | boolean>;
}

/**
 * Minimal global-flag parser.
 *
 * Recognizes:
 * - `--json`                    → `flags.json = true`, `json: true`
 * - `--key=value`               → `flags.key = "value"`
 * - `--key value`               → `flags.key = "value"` (consumes next token
 *                                  unless it also looks like a flag)
 * - `--flag`                    → `flags.flag = true` (boolean)
 *
 * Non-flag tokens accumulate into `rest`.
 */
export function parseGlobalFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    // `--key value`: consume the next token as the value, unless it's absent
    // or is itself a flag (then treat `--key` as a boolean).
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { json: flags.json === true, rest, flags };
}

/** Write a pretty-printed JSON value to stdout, newline-terminated. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Write a line to stdout. */
export function printLine(s: string): void {
  process.stdout.write(`${s}\n`);
}

/** Write a line to stderr. */
export function printErr(s: string): void {
  process.stderr.write(`${s}\n`);
}

/** Write one compact JSON object per line to stdout (NDJSON stream). */
export function emitNdjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Render a simple left-aligned column table as a single string (no trailing
 * newline). Columns are padded to the widest cell (header included); the last
 * column is left un-padded so trailing whitespace never leaks. Cells are
 * joined by two spaces. Pure — used by the human-readable command outputs.
 */
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cols: string[]): string =>
    cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [fmt(header), ...rows.map(fmt)].join("\n");
}
