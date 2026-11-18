/**
 * Stage 1 of secret intake (`docs/specs/2026-11-17-secret-intake-design.md`):
 * finds tokens in message text that may be pasted credentials, in any
 * format. It is tuned for recall. The composer asks the person about each
 * candidate; the api confirms each one with a model before acting.
 *
 * Known provider formats come from `detectSecrets` and score highest.
 */
import { detectSecrets } from "./secret-detect.js";

export type CandidateReason = "known" | "assigned" | "shape" | "context" | "password";

export interface SecretTokenCandidate {
  start: number;
  end: number;
  value: string;
  /** 0 to 1. Above 0.5 the composer prompts without a nearby keyword. */
  score: number;
  reason: CandidateReason;
  /** Provider label from a known format or a nearby provider name. */
  provider?: string;
  /** Env-style name from a known format or an assignment. */
  suggestedName?: string;
}

/** The name to offer when saving: the format's name, else PROVIDER_API_KEY, else PASTED_KEY. */
export function suggestSecretName(candidate: Pick<SecretTokenCandidate, "suggestedName" | "provider">, provider?: string): string {
  if (candidate.suggestedName) return candidate.suggestedName;
  const from = (provider ?? candidate.provider ?? "").trim();
  const base = from.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base ? `${base}_API_KEY` : "PASTED_KEY";
}

const CREDENTIAL_WORDS =
  /\b(?:api[_ -]?key|apikey|key|token|secret|password|passwd|pwd|pw|pat|credentials?|bearer|auth|access[_ -]?key|private[_ -]?key|client[_ -]?secret|regenerated|rotated|creds)\b/i;
/** Words that mark a value as public, so a nearby "key" does not count. */
const PUBLIC_WORDS = /\b(?:public[_ -]?key|pubkey|deploy key|wallet|address|fingerprint)\b/i;
const PASSWORD_WORDS = /\b(?:password|passwd|pwd|pw|passphrase|pin)\b\s*(?:is|=|:)?\s*$/i;

/** Lower-case provider names people use next to a key. */
export const PROVIDER_WORDS: readonly string[] = [
  "anthropic", "openai", "github", "gitlab", "slack", "aws", "google", "gcp", "stripe", "hugging face", "huggingface",
  "hetzner", "digitalocean", "linode", "vultr", "cloudflare", "vercel", "netlify", "fly", "render", "railway",
  "heroku", "supabase", "neon", "planetscale", "mongodb", "datadog", "sentry", "linear", "notion", "airtable",
  "twilio", "sendgrid", "mailgun", "postmark", "resend", "discord", "telegram", "npm", "pypi", "docker",
  "openrouter", "groq", "mistral", "cohere", "replicate", "xai", "grok", "pinecone", "tailscale", "doppler",
  "shopify", "algolia", "mapbox", "turnkey", "alchemy", "infura", "etherscan", "coinbase",
];

const TOKEN = /[^\s"'`<>()[\]{},;]+/g;
/** Encoded media and data URLs, not credentials. */
const MEDIA_PREFIX = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|data:)/;
/** Short lower-case segments, such as `th-0o98qio8-h8glnlnf`: an id, not a key. */
const SEGMENTED_ID = /^[a-z]{1,8}(?:[-_][a-z0-9]{3,12})+$/;
/** Content digests (`sha256:…`, `sha512-…`) and versions (`v2.14.0-rc.3`). */
const DIGEST_OR_VERSION = /(?:^|[@/])(?:sha1|sha224|sha256|sha384|sha512|md5)[:-]|^v?\d+\.\d+\.\d+/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^(?:0x)?[0-9a-f]+$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const WORDY_PATH = /^[./~]?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*$/;

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function charClasses(value: string): number {
  let n = 0;
  if (/[a-z]/.test(value)) n++;
  if (/[A-Z]/.test(value)) n++;
  if (/[0-9]/.test(value)) n++;
  if (/[^A-Za-z0-9]/.test(value)) n++;
  return n;
}

/**
 * One piece of a name made of words: `passkey`, `API`, `Sign`, `signCommits`,
 * `SecretStore`, a short number (`2`, `2026`), or a version (`v1`). A random
 * key's pieces mix letters and digits, so they never match.
 */
const WORD_PIECE = /^(?:[a-z]{1,14}|[A-Z]{1,10}|[A-Z][a-z]{1,14}|[A-Z]?[a-z]+(?:[A-Z][a-z]+)+|\d{1,4}|v\d{1,3})$/;

/**
 * A branch, ref, action id, dotted call, or constant made of words, such as
 * `origin/valet/passkey-pilot-2`, `turnkey.sign_commits`, or
 * `SecretStore.confirmIntake`. Never a key on its own.
 */
function isWordSegmented(value: string): boolean {
  const pieces = value.split(/[/._:-]+/).filter(Boolean);
  return pieces.length >= 2 && pieces.every((p) => WORD_PIECE.test(p));
}

/** A path made of ordinary words, such as `src/lib/secret-detect.ts`. */
function isWordyPath(value: string): boolean {
  if (!WORDY_PATH.test(value)) return false;
  return value.split("/").every((seg) => seg.length === 0 || shannonEntropy(seg) < 3.3 || seg.length < 12);
}

function lookalike(value: string): "uuid" | "hex" | "base58-address" | null {
  if (UUID.test(value)) return "uuid";
  if (HEX.test(value) && value.replace(/^0x/i, "").length >= 7) return "hex";
  if (BASE58.test(value) && value.length >= 26 && value.length <= 44) {
    // Bitcoin and Solana-style addresses. A base58 API key with a credential
    // word nearby still becomes a candidate through context.
    return "base58-address";
  }
  return null;
}

function nearbyText(text: string, start: number, before = 40): string {
  return text.slice(Math.max(0, start - before), start);
}

function providerNear(text: string, start: number, end: number): string | undefined {
  const around = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 40)).toLowerCase();
  return PROVIDER_WORDS.find((p) => new RegExp(`\\b${p.replace(/ /g, "\\s?")}\\b`).test(around));
}

function overlaps(taken: { start: number; end: number }[], start: number, end: number): boolean {
  return taken.some((c) => start < c.end && end > c.start);
}

/** Splits a raw token into the part that may be a secret and its offset. */
function valuePart(raw: string): { value: string; offset: number } | null {
  // URL: only a password in the userinfo counts.
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]*)@/i.exec(raw);
  if (url) {
    const userinfo = url[1] ?? "";
    const colon = userinfo.indexOf(":");
    if (colon < 0) return null;
    const pass = userinfo.slice(colon + 1);
    return pass ? { value: pass, offset: raw.indexOf(userinfo) + colon + 1 } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  // NAME=value or name:value.
  const assign = /^[A-Za-z_][A-Za-z0-9_.-]*[=:]/.exec(raw);
  if (assign) return { value: raw.slice(assign[0].length), offset: assign[0].length };
  return { value: raw, offset: 0 };
}

/** Every candidate in `text`, in order. */
export function findSecretCandidates(text: string, opts: { credentialRequested?: boolean } = {}): SecretTokenCandidate[] {
  const found: SecretTokenCandidate[] = detectSecrets(text).map((c) => ({
    start: c.start,
    end: c.end,
    value: c.value,
    score: c.confidence === "known" ? 1 : 0.8,
    reason: c.confidence,
    provider: c.label,
    suggestedName: c.suggestedName,
  }));

  for (const match of text.matchAll(TOKEN)) {
    // A password may end in punctuation; anything else loses its sentence end.
    const passwordAhead = PASSWORD_WORDS.test(nearbyText(text, match.index ?? 0));
    const raw = passwordAhead ? match[0].replace(/[.]+$/, "") : match[0].replace(/[.!?:]+$/, "");
    const part = valuePart(raw);
    if (!part) continue;
    const value = part.value.replace(/^["']|["']$/g, "");
    if (!value || value.startsWith("secret://") || value.startsWith("op://") || value.startsWith("$")) continue;
    const start = (match.index ?? 0) + part.offset;
    const end = start + value.length;
    if (overlaps(found, start, end)) continue;

    const before = nearbyText(text, start);
    const publicNearby = PUBLIC_WORDS.test(before) && !/\b(?:private|secret|api[_ -]?key)\b/i.test(before);
    const after = text.slice(end, end + 40);
    const hasWord =
      (!publicNearby && (CREDENTIAL_WORDS.test(before) || CREDENTIAL_WORDS.test(after))) || opts.credentialRequested === true;
    const provider = providerNear(text, start, end);

    // Short passwords right after a password word.
    if (value.length >= 8 && value.length < 16) {
      if (PASSWORD_WORDS.test(before) && charClasses(value) >= 2) {
        found.push({ start, end, value, score: 0.7, reason: "password", ...(provider ? { provider } : {}) });
      }
      continue;
    }
    if (value.length < 16) continue;
    if (/^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-)/.test(value) || /^AAAA[A-Za-z0-9+/]{60,}/.test(value)) continue;
    if (isWordyPath(value)) continue;
    // A passphrase after "password is" may be words joined by dashes; keep it.
    if (!passwordAhead && isWordSegmented(value)) continue;
    if (/^[a-z]+(?:[-_][a-z]+)+$/.test(value)) continue; // kebab or snake words
    if (MEDIA_PREFIX.test(value) || DIGEST_OR_VERSION.test(raw)) continue;

    const entropy = shannonEntropy(value);
    const classes = charClasses(value);
    const kind = lookalike(value) ?? (SEGMENTED_ID.test(value) ? "segmented-id" : null);
    if (kind) {
      // Without context a look-alike stays below the composer's threshold;
      // the api's model stage may still judge it.
      const lookScore = hasWord || provider ? 0.6 : 0.2;
      found.push({ start, end, value, score: lookScore, reason: lookScore > 0.2 ? "context" : "shape", ...(provider ? { provider } : {}) });
      continue;
    }
    if (classes < 2 || entropy < 3.0) continue;
    const strongShape = value.length >= 20 && classes >= 3 && entropy >= 3.5 && /[0-9]/.test(value);
    const score = strongShape ? (hasWord || provider ? 0.9 : 0.6) : hasWord || provider ? 0.6 : 0.3;
    found.push({ start, end, value, score, reason: hasWord || provider ? "context" : "shape", ...(provider ? { provider } : {}) });
  }
  return found.sort((a, b) => a.start - b.start);
}
