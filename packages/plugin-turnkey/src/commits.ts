/**
 * Rewriting a chain of git commits so each one carries an SSH signature
 * (passkey signing, `docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * A commit object names its parents by hash, and adding a signature changes
 * a commit's hash. So commit N+1 can only be built, and its signing payload
 * computed, after commit N is signed. `planCommitChain` takes the original
 * objects (oldest first) and the signatures collected so far, and returns
 * the signed objects plus the payload for the next commit. The api calls it
 * between passkey steps; the action calls it once more to write the objects.
 *
 * Only SHA-1 repositories: `gitObjectId` hashes with SHA-1.
 */
import { createHash } from "node:crypto";
import { armorSshSignature, sshsigSignedData, verifyEd25519 } from "./ssh.js";

export interface SourceCommit {
  sha: string;
  /** `git cat-file commit <sha>` output. */
  object: string;
}

export interface RewrittenCommit {
  oldSha: string;
  newSha: string;
  /** The signed object, as `git hash-object -t commit -w --stdin` takes it. */
  object: string;
}

export interface CommitChainPlan {
  rewritten: RewrittenCommit[];
  /** The signed-data bytes for the next unsigned commit; absent when every commit is signed. */
  nextPayload?: Buffer;
  /** The subject line of the next unsigned commit. */
  nextSubject?: string;
}

/** The SHA-1 git object id of a commit object. */
export function gitObjectId(object: string): string {
  const body = Buffer.from(object, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`commit ${body.length}\0`, "utf8"), body])).digest("hex");
}

interface ParsedCommit {
  /** Header lines, each with its continuation lines joined by `\n`. */
  headers: string[];
  /** Everything after the blank line, unchanged. */
  message: string;
}

function parseCommit(object: string): ParsedCommit {
  const split = object.indexOf("\n\n");
  const head = split === -1 ? object.replace(/\n$/, "") : object.slice(0, split);
  const message = split === -1 ? "" : object.slice(split + 2);
  const headers: string[] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length > 0) headers[headers.length - 1] += `\n${line}`;
    else headers.push(line);
  }
  return { headers, message };
}

/** First line of the message, for labels. */
export function commitSubject(object: string): string {
  return parseCommit(object).message.split("\n", 1)[0]?.trim() ?? "";
}

/** `Name <email>` from the author header. */
export function commitAuthor(object: string): string {
  const author = parseCommit(object).headers.find((h) => h.startsWith("author "));
  const match = author ? /^author (.*>) \d+ [+-]\d{4}$/.exec(author) : null;
  return match?.[1] ?? "";
}

/**
 * The commit with parents remapped, existing signatures removed, and the
 * committer email replaced. Name and time stay: GitHub matches the email,
 * and the time is part of what the person approved.
 */
export function unsignedRewrite(object: string, parentMap: ReadonlyMap<string, string>, committerEmail: string): string {
  const { headers, message } = parseCommit(object);
  const kept = headers
    .filter((h) => !h.startsWith("gpgsig ") && !h.startsWith("gpgsig-sha256 "))
    .map((h) => {
      if (h.startsWith("parent ")) {
        const sha = h.slice("parent ".length).trim();
        return `parent ${parentMap.get(sha) ?? sha}`;
      }
      if (h.startsWith("committer ")) return h.replace(/^(committer [^<]*<)[^>]*(>.*)$/, `$1${committerEmail}$2`);
      return h;
    });
  return `${kept.join("\n")}\n\n${message}`;
}

/** Inserts the armored signature as the last header, the way git does. */
export function withSignature(unsigned: string, armored: string): string {
  const split = unsigned.indexOf("\n\n");
  const head = unsigned.slice(0, split);
  const rest = unsigned.slice(split);
  const continued = armored.replace(/\n$/, "").split("\n").join("\n ");
  return `${head}\ngpgsig ${continued}${rest}`;
}

export function planCommitChain(input: {
  commits: SourceCommit[];
  committerEmail: string;
  signatures: Uint8Array[];
  publicKeyHex: string;
}): CommitChainPlan {
  if (input.signatures.length > input.commits.length) throw new Error("more signatures than commits");
  const parentMap = new Map<string, string>();
  const rewritten: RewrittenCommit[] = [];
  for (const [i, commit] of input.commits.entries()) {
    const unsigned = unsignedRewrite(commit.object, parentMap, input.committerEmail);
    const signature = input.signatures[i];
    if (!signature) {
      return { rewritten, nextPayload: sshsigSignedData(Buffer.from(unsigned, "utf8")), nextSubject: commitSubject(unsigned) };
    }
    const signed = withSignature(unsigned, armorSshSignature(input.publicKeyHex, signature));
    const newSha = gitObjectId(signed);
    parentMap.set(commit.sha, newSha);
    rewritten.push({ oldSha: commit.sha, newSha, object: signed });
  }
  return { rewritten };
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
const IDENT = /^(author|committer) [^<>\n]*<[^<>\n]*> \d+ [+-]\d{4}$/;
/** Headers git writes after `committer`. Anything else is refused rather than signed. */
const TRAILING_HEADERS = ["encoding ", "gpgsig ", "gpgsig-sha256 ", "mergetag "];

/**
 * Why `object` is not a well-formed git commit object, or null when it is.
 * The sandbox supplies the bytes, so a compromised sandbox could hand over a
 * tag object or other git data and get a signature that git accepts for it.
 * Only a commit in git's own header order is signed: `tree`, any `parent`
 * lines, `author`, `committer`, then optional `encoding`, `gpgsig`, and
 * `mergetag`, then a blank line and the message.
 */
export function commitObjectRefusal(object: string): string | null {
  if (!object.includes("\n\n")) return "it has no blank line before the message";
  const { headers } = parseCommit(object);
  let i = 0;
  const tree = headers[i++] ?? "";
  if (!tree.startsWith("tree ") || !OBJECT_ID.test(tree.slice(5))) return "it does not start with a tree line";
  while (headers[i]?.startsWith("parent ")) {
    if (!OBJECT_ID.test(headers[i]!.slice(7))) return "a parent line is not an object id";
    i += 1;
  }
  if (!headers[i]?.startsWith("author ") || !IDENT.test(headers[i]!)) return "the author line is missing or malformed";
  i += 1;
  if (!headers[i]?.startsWith("committer ") || !IDENT.test(headers[i]!)) return "the committer line is missing or malformed";
  i += 1;
  for (; i < headers.length; i += 1) {
    if (!TRAILING_HEADERS.some((h) => headers[i]!.startsWith(h))) return `it has an unexpected header: ${headers[i]!.split(" ", 1)[0]}`;
  }
  return null;
}

/**
 * How many of `signatures`, from the first, are valid signatures by the key
 * over the chain's payloads. The action writes commits only when every one
 * verifies: the stored signatures are not trusted because the api wrote them.
 */
export function verifiedSignatureCount(input: {
  commits: SourceCommit[];
  committerEmail: string;
  signatures: Uint8Array[];
  publicKeyHex: string;
}): number {
  for (let i = 0; i < input.signatures.length; i += 1) {
    const plan = planCommitChain({ ...input, signatures: input.signatures.slice(0, i) });
    if (!plan.nextPayload || !verifyEd25519(input.publicKeyHex, plan.nextPayload, input.signatures[i]!)) return i;
  }
  return input.signatures.length;
}
