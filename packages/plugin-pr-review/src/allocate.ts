/**
 * Review allocation: how much review a pull request gets, chosen from the
 * change itself before any model runs. A small or docs-only change gets the
 * light model and no focused passes. A change that touches risky paths, or is
 * too large to fit the diff budget, gets the deep model and the focused
 * passes. Everything else gets the line's own model and focuses, as without
 * allocation. The rules are fixed and cheap, so the same PR always gets the
 * same depth and the summary can say why. Light and deep keep the line's model
 * unless a team sets one: on the review benchmark a smaller light model lost
 * most findings and a larger deep model added cost but not recall.
 */
import { matchesGlob } from "./context/glob.js";
import { noiseKind } from "./context/paths.js";
import { REVIEW_FOCUSES, type ReviewFocus } from "./prompt.js";

export type ReviewDepth = "light" | "standard" | "deep";

/** One changed file, as the pull request files endpoint or `git diff --numstat` counts it. */
export interface ChangedFile {
  path: string;
  /** The path before a rename, when there was one. */
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface AllocationOptions {
  /** The line's model: the standard depth uses it. */
  model: string;
  /** The line's focused passes: the standard depth uses them. */
  focuses?: readonly ReviewFocus[];
  /** Model for the light depth: a size tier (`s`) or a provider/model. Unset or empty: `model`. */
  lightModel?: string;
  /** Model for the deep depth: a size tier (`l`) or a provider/model. Unset or empty: `model`. */
  deepModel?: string;
  /** The team's risky path globs, beside the built-in risk words. */
  riskPaths?: readonly string[];
  /** The diff went over the budget, so the reviewer sees only part of it. */
  truncated?: boolean;
}

export interface Allocation {
  depth: ReviewDepth;
  model: string;
  focuses: ReviewFocus[];
  /** Why this depth, in a few words, for the summary and the log. */
  reason: string;
}

/** Changed lines at or under this, in source that is not a test or doc, make a light review. */
export const LIGHT_MAX_LINES = 40;
/** Changed lines over this make a deep review. */
export const DEEP_MIN_LINES = 1000;

/**
 * Paths where a defect is a security or data-loss defect: auth, secrets,
 * keys and signing, access control, money, and schema migrations. Narrower
 * than the diff ranking's risk words (`riskyPath`), which also rank UI
 * sessions, schemas and escaping first: those are common enough that a
 * deep review on every touch would make most reviews deep.
 */
const DEEP_RISK = /(^|[/_.-])(auth[a-z]*|oauth|password\w*|passkey\w*|webauthn|credential\w*|secret\w*|keys?|keystore|keychain|crypto\w*|cipher|encrypt\w*|decrypt\w*|sign(er|ing|ature)s?|iam|rbac|permission\w*|polic(y|ies)|acl|payment\w*|billing|webhook\w*|migrations?)([/_.-]|$)/i;

const DOC = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(docs?|LICENSE|CHANGELOG)(\/|$|\.)/i;
const TEST = /(^|\/)(tests?|__tests__|spec|e2e|testdata|fixtures?)\/|[._-](test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$/i;

export function allocateReview(files: readonly ChangedFile[], opts: AllocationOptions): Allocation {
  const source = files.filter((f) => noiseKind(f.path) === undefined);
  const lines = (list: readonly ChangedFile[]) => list.reduce((n, f) => n + f.additions + f.deletions, 0);
  const total = lines(source);
  const code = source.filter((f) => !DOC.test(f.path) && !TEST.test(f.path));
  // Tests and docs that name a risky area are not risky code; the team's own globs count on any source file.
  const riskyName = (path: string) => DEEP_RISK.test(path.replace(/([a-z])([A-Z])/g, "$1_$2"));
  const teamRisk = (path: string) => (opts.riskPaths ?? []).length > 0 && matchesGlob(path, opts.riskPaths ?? []);
  const risky = source.filter((f) =>
    [f.path, ...(f.previousPath !== undefined ? [f.previousPath] : [])].some((p) => teamRisk(p) || (code.includes(f) && riskyName(p))),
  );
  const deep = (reason: string): Allocation => ({
    depth: "deep",
    model: opts.deepModel || opts.model,
    focuses: [...new Set(opts.focuses !== undefined && opts.focuses.length > 0 ? opts.focuses : REVIEW_FOCUSES)],
    reason,
  });

  if (risky.length > 0) {
    const names = risky.slice(0, 2).map((f) => `\`${f.path}\``).join(", ");
    return deep(`touches ${names}${risky.length > 2 ? ` and ${risky.length - 2} more risky path${risky.length > 3 ? "s" : ""}` : ""}`);
  }
  if (opts.truncated === true) return deep("the diff is over the review budget");
  if (total > DEEP_MIN_LINES) return deep(`${total} changed lines`);
  if (code.length === 0) {
    return { depth: "light", model: opts.lightModel || opts.model, focuses: [], reason: source.length === 0 ? "no source changes" : "only docs and tests" };
  }
  const codeLines = lines(code);
  if (codeLines <= LIGHT_MAX_LINES) {
    return { depth: "light", model: opts.lightModel || opts.model, focuses: [], reason: `${codeLines} changed line${codeLines === 1 ? "" : "s"} of code` };
  }
  return { depth: "standard", model: opts.model, focuses: [...new Set(opts.focuses ?? [])], reason: `${codeLines} changed lines of code` };
}

/** Changed files from `git diff --numstat -M` output. Binary files count as zero lines. */
export function parseNumstat(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of text.split("\n")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    // A rename prints `old => new`, or `dir/{old => new}/rest`.
    const rename = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(m[3]) ?? /^()(.*) => (.*)()$/.exec(m[3]);
    if (rename) {
      const join = (mid: string) => `${rename[1]}${mid}${rename[4]}`.replace(/\/\//g, "/");
      files.push({ path: join(rename[3]), previousPath: join(rename[2]), additions, deletions });
    } else files.push({ path: m[3], additions, deletions });
  }
  return files;
}
