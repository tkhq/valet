/**
 * Load eval cases from YAML files (TKAI-328).
 *
 * Each `*.yaml` / `*.yml` file in the cases directory holds one `EvalCase`.
 * Validation is strict: an invalid case throws `CaseValidationError` naming
 * the file and the field, so a typo fails the run instead of silently
 * skipping a check.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CHECK_TYPES,
  type Check,
  type EvalCase,
  type EvalTurn,
  type MockToolSpec,
} from "./types.js";

export class CaseValidationError extends Error {
  constructor(
    readonly source: string,
    detail: string,
  ) {
    super(`invalid eval case (${source}): ${detail}`);
    this.name = "CaseValidationError";
  }
}

const PROFILES = ["unit", "mock", "integration", "full"] as const;
const SESSION_TYPES = ["default", "orchestrator"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(raw: Record<string, unknown>, key: string, source: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new CaseValidationError(source, `\`${key}\` must be a string`);
  return v;
}

function optionalNumber(raw: Record<string, unknown>, key: string, source: string): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CaseValidationError(source, `\`${key}\` must be a finite number`);
  }
  return v;
}

function optionalStringArray(raw: Record<string, unknown>, key: string, source: string): string[] | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new CaseValidationError(source, `\`${key}\` must be an array of strings`);
  }
  return v as string[];
}

function parseTurns(raw: Record<string, unknown>, source: string): EvalTurn[] {
  const v = raw.turns;
  if (!Array.isArray(v) || v.length === 0) {
    throw new CaseValidationError(
      source,
      "`turns` must be a non-empty array. Single-prompt cases use a one-element array.",
    );
  }
  return v.map((t, i) => {
    if (!isRecord(t)) throw new CaseValidationError(source, `\`turns[${i}]\` must be an object`);
    if (t.role !== "user") {
      throw new CaseValidationError(source, `\`turns[${i}].role\` must be "user"`);
    }
    if (typeof t.content !== "string" || t.content.length === 0) {
      throw new CaseValidationError(source, `\`turns[${i}].content\` must be a non-empty string`);
    }
    return { role: "user", content: t.content };
  });
}

function parseCheck(raw: unknown, i: number, source: string): Check {
  if (!isRecord(raw)) throw new CaseValidationError(source, `\`checks[${i}]\` must be an object`);
  const type = raw.type;
  if (typeof type !== "string" || !(CHECK_TYPES as readonly string[]).includes(type)) {
    throw new CaseValidationError(
      source,
      `\`checks[${i}].type\` must be one of: ${CHECK_TYPES.join(", ")}`,
    );
  }
  const at = `checks[${i}]`;
  const requireString = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new CaseValidationError(source, `\`${at}.${key}\` is required for ${type} and must be a non-empty string`);
    }
    return v;
  };
  const requireNumber = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new CaseValidationError(source, `\`${at}.${key}\` is required for ${type} and must be a finite number`);
    }
    return v;
  };
  const optNumber = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new CaseValidationError(source, `\`${at}.${key}\` must be a finite number`);
    }
    return v;
  };
  const optString = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new CaseValidationError(source, `\`${at}.${key}\` must be a string`);
    return v;
  };
  const validPattern = (pattern: string): string => {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new CaseValidationError(
        source,
        `\`${at}.pattern\` is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return pattern;
  };

  switch (type) {
    case "tool_called": {
      const count = optNumber("count");
      const min = optNumber("min");
      const max = optNumber("max");
      const after = optString("after");
      if (count !== undefined && (min !== undefined || max !== undefined)) {
        throw new CaseValidationError(source, `\`${at}\`: use either \`count\` or \`min\`/\`max\`, not both`);
      }
      return {
        type,
        tool: requireString("tool"),
        ...(count !== undefined ? { count } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    }
    case "tool_not_called":
      return { type, tool: requireString("tool") };
    case "tool_result_matches":
    case "tool_result_not_matches":
      return { type, tool: requireString("tool"), pattern: validPattern(requireString("pattern")) };
    case "tool_args_match": {
      const args = raw.args;
      if (!isRecord(args)) {
        throw new CaseValidationError(source, `\`${at}.args\` is required for tool_args_match and must be an object`);
      }
      return { type, tool: requireString("tool"), args };
    }
    case "output_contains":
    case "output_not_contains": {
      const value = optString("value");
      const pattern = raw.pattern !== undefined && raw.pattern !== null ? validPattern(requireString("pattern")) : undefined;
      if ((value === undefined) === (pattern === undefined)) {
        throw new CaseValidationError(source, `\`${at}\` needs exactly one of \`value\` or \`pattern\``);
      }
      return { type, ...(value !== undefined ? { value } : {}), ...(pattern !== undefined ? { pattern } : {}) };
    }
    case "all_terminal":
    case "no_errors":
      return { type };
    case "max_turns":
    case "max_tokens":
    case "max_cost":
    case "max_duration":
      return { type, value: requireNumber("value") };
    case "judge_output":
    case "judge_trajectory": {
      const threshold = optNumber("threshold");
      const judgeModel = optString("judge_model");
      return {
        type,
        rubric: requireString("rubric"),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(judgeModel !== undefined ? { judge_model: judgeModel } : {}),
      };
    }
    case "judge_equivalence": {
      const rubric = optString("rubric");
      const threshold = optNumber("threshold");
      const judgeModel = optString("judge_model");
      return {
        type,
        ...(rubric !== undefined ? { rubric } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(judgeModel !== undefined ? { judge_model: judgeModel } : {}),
      };
    }
    default:
      throw new CaseValidationError(source, `unhandled check type ${type}`);
  }
}

function parseMockTools(
  raw: Record<string, unknown>,
  source: string,
): Record<string, MockToolSpec> | undefined {
  const v = raw.mock_tools;
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) throw new CaseValidationError(source, "`mock_tools` must be a map of tool name to spec");
  const out: Record<string, MockToolSpec> = {};
  for (const [tool, spec] of Object.entries(v)) {
    if (!isRecord(spec) || typeof spec.response !== "string") {
      throw new CaseValidationError(source, `\`mock_tools.${tool}.response\` must be a string`);
    }
    out[tool] = { response: spec.response };
  }
  return out;
}

/** Validate one parsed YAML document as an `EvalCase`. Throws `CaseValidationError`. */
export function parseEvalCase(raw: unknown, source: string): EvalCase {
  if (!isRecord(raw)) throw new CaseValidationError(source, "the document must be a YAML mapping");

  const id = raw.id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CaseValidationError(source, "`id` is required and must be kebab-case (letters, digits, dashes)");
  }

  const checksRaw = raw.checks;
  if (!Array.isArray(checksRaw) || checksRaw.length === 0) {
    throw new CaseValidationError(source, "`checks` must be a non-empty array");
  }

  const sessionType = optionalString(raw, "session_type", source);
  if (sessionType !== undefined && !(SESSION_TYPES as readonly string[]).includes(sessionType)) {
    throw new CaseValidationError(source, `\`session_type\` must be one of: ${SESSION_TYPES.join(", ")}`);
  }
  const profile = optionalString(raw, "profile", source);
  if (profile !== undefined && !(PROFILES as readonly string[]).includes(profile)) {
    throw new CaseValidationError(source, `\`profile\` must be one of: ${PROFILES.join(", ")}`);
  }

  const evalCase: EvalCase = {
    id,
    turns: parseTurns(raw, source),
    checks: checksRaw.map((c, i) => parseCheck(c, i, source)),
  };
  const description = optionalString(raw, "description", source);
  const model = optionalString(raw, "model", source);
  const timeoutMs = optionalNumber(raw, "timeout_ms", source);
  const tools = optionalStringArray(raw, "tools", source);
  const requiredCredentials = optionalStringArray(raw, "required_credentials", source);
  const mockTools = parseMockTools(raw, source);
  if (description !== undefined) evalCase.description = description;
  if (model !== undefined) evalCase.model = model;
  if (timeoutMs !== undefined) evalCase.timeout_ms = timeoutMs;
  if (tools !== undefined) evalCase.tools = tools;
  if (sessionType !== undefined) evalCase.session_type = sessionType as EvalCase["session_type"];
  if (profile !== undefined) evalCase.profile = profile as EvalCase["profile"];
  if (mockTools !== undefined) evalCase.mock_tools = mockTools;
  if (requiredCredentials !== undefined) evalCase.required_credentials = requiredCredentials;
  return evalCase;
}

/**
 * Load every `*.yaml` / `*.yml` case file in `dir`, sorted by file name.
 * Throws `CaseValidationError` on the first invalid case, and on duplicate
 * case ids across files.
 */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    throw new Error(`cases directory not found: ${dir}. Create it and add case YAML files.`);
  }
  const caseFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  const cases: EvalCase[] = [];
  const seen = new Map<string, string>();
  for (const file of caseFiles) {
    const text = await readFile(join(dir, file), "utf8");
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (err) {
      throw new CaseValidationError(file, `YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const evalCase = parseEvalCase(doc, file);
    const prior = seen.get(evalCase.id);
    if (prior !== undefined) {
      throw new CaseValidationError(file, `duplicate case id \`${evalCase.id}\` (also defined in ${prior})`);
    }
    seen.set(evalCase.id, file);
    cases.push(evalCase);
  }
  return cases;
}
