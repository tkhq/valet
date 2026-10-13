import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomInt } from "node:crypto";
import type { PluginActionContext } from "@valet/engine";
import type { Octokit } from "octokit";

export interface CommentImage {
  path: string;
  alt?: string;
  caption?: string;
}

class CommentImageError extends Error {}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function imageExtension(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  throw new CommentImageError("Unsupported image content. Export the file as PNG, JPEG, GIF, or WebP and retry.");
}

// Alt text is parsed as Markdown. Encode punctuation, not letters or digits.
function inertAlt(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[!-/:-@\[-`{-~]/g, (char) => `&#${char.codePointAt(0)};`);
}

export function imageCommentBody(body: string | undefined, images: CommentImage[], urls: string[]): string {
  return [...images.map((image, i) => {
    const alt = inertAlt(image.alt ?? `Image ${i + 1}`);
    // HTML code content cannot open Markdown blocks, mentions, or autolinks.
    const caption = image.caption ? `\n\n<p><code>${image.caption.replace(/[\r\n]+/g, " ").replace(/[&<>]/g, (char) => `&#${char.codePointAt(0)};`)}</code></p>` : "";
    return `![${alt}](${urls[i]})${caption}`;
  }), body].filter(Boolean).join("\n\n");
}

/** Race the complete image operation, including Octokit's queued writes, against one deadline. */
export async function withImageDeadline<T>(ctx: PluginActionContext, work: (ctx: PluginActionContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const timeout = new CommentImageError("Image attachment exceeded 30 seconds. Check the PR for a completed comment. Retry after other uploads finish.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timeout); }, 30_000);
  });
  try { return await Promise.race([work({ ...ctx, signal }), expired]); }
  finally { clearTimeout(timer); }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status : undefined;
}

function githubMessage(err: unknown): string {
  return err instanceof Error ? err.message : "No GitHub error detail";
}

export function imageUploadError(err: unknown, stage: "storage" | "comment" | "PR lookup" = "storage"): string {
  if (err instanceof CommentImageError) return err.message;
  if (err instanceof Error && err.name === "AbortError") return "Image attachment was cancelled. Retry from an active session if the images are still needed.";
  const status = statusOf(err);
  const detail = `GitHub ${stage} failed (${status ?? "network error"}): ${githubMessage(err)}.`;
  if (status === 401) return `${detail} Reconnect GitHub in Settings and retry.`;
  if (stage === "PR lookup" && status === 404) return `${detail} Images work only on pull requests. Check the PR number and repository access. For a plain issue, omit images.`;
  if (stage === "storage" && /repository rule|ruleset|protected.*(?:branch|ref)|GH013/i.test(githubMessage(err))) return `${detail} Ask a repository admin to allow this assets ref under the reported repository rules.`;
  if (status === 403) return `${detail} Check the connected user's repository role or the App's repository permissions. Grant contents write, pull requests read, and issues write as needed.`;
  if (status === 404) return `${detail} Check owner and repo. Grant repository access in Settings.`;
  if (stage === "comment" && status === 422) return `${detail} Shorten the comment or correct the fields GitHub rejected, then retry.`;
  if (status === 409 || status === 422) return `${detail} Correct the fields GitHub rejected. If the ref namespace is unsupported, stop and report this error to the Valet maintainer.`;
  return `${detail} Check GitHub availability and rate limits, then retry.`;
}

/** Validate the complete batch before any GitHub write. Use the sandbox port, not host filesystem access. */
export async function storeCommentImages(
  octokit: Octokit,
  ctx: PluginActionContext,
  owner: string,
  repo: string,
  issueNumber: number,
  images: CommentImage[],
): Promise<{ imageUrls: string[]; assetsRef: string; assetsCommit: string }> {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new CommentImageError("Invalid pull request number. Supply a positive issueNumber and retry.");
  }
  if (images.length < 1 || images.length > 10) {
    throw new CommentImageError("Invalid image count. Supply between 1 and 10 sandbox image files.");
  }
  const request = { signal: ctx.signal };
  const files: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  for (const image of images) {
    let bytes: Uint8Array;
    try {
      const stat = await ctx.sandbox.stat(image.path);
      if (!stat.isFile) throw new CommentImageError("not a file");
      if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
        throw new CommentImageError("size limit");
      }
      bytes = await ctx.sandbox.readBinary(image.path);
    } catch (err) {
      if (err instanceof Error && err.message === "sandbox unavailable in workflow action invocation") {
        throw new CommentImageError("Images need a session sandbox. Run create_comment from a session with these files, not a standalone workflow action.");
      }
      throw new CommentImageError(`Cannot read image ${image.path}. Choose a readable sandbox file of 1 byte to 10 MiB. Keep the batch below 20 MiB.`);
    }
    total += bytes.byteLength;
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new CommentImageError("Image size limit exceeded. Reduce each image to 10 MiB or less and the batch to 20 MiB or less.");
    }
    const ext = imageExtension(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    files.push({ path: `pr-${issueNumber}/${hash}.${ext}`, bytes });
  }

  const { data: pull } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner, repo, pull_number: issueNumber, request,
  }).catch((err: unknown) => { throw new CommentImageError(imageUploadError(err, "PR lookup")); });
  const assetsRef = `refs/valet/pr-assets/${issueNumber}`;
  const marker = `Valet-Assets: pr-${issueNumber}`;
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  // Identical bytes share a blob and a tree entry, but keep their individual captions.
  for (const file of new Map(files.map((file) => [file.path, file])).values()) {
    const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
      owner, repo, content: Buffer.from(file.bytes).toString("base64"), encoding: "base64", request,
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  // No base_tree: each commit contains only this batch. Prior batches remain in parent history.
  const { data: snapshot } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, tree, request });
  async function assetHead(): Promise<string | undefined> {
    try {
      const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner, repo, ref: assetsRef.slice(5), request,
      });
      return ref.object.sha;
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      return undefined;
    }
  }
  for (let attempt = 0; ; attempt++) {
    ctx.signal.throwIfAborted();
    const parent = await assetHead();
    if (parent) {
      const { data: previous } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner, repo, commit_sha: parent, request,
      });
      if (!previous.message.split(/\r?\n/).includes(marker)) {
        throw new CommentImageError("The assets ref contains unrelated commits. Ask a repository admin to move it before attaching images.");
      }
    }
    const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner, repo, tree: snapshot.sha, parents: parent ? [parent] : [], request,
      message: `Attach images for PR #${issueNumber}\n\n${marker}`,
    });
    try {
      if (parent) {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner, repo, ref: assetsRef.slice(5), request, sha: commit.sha, force: false,
        });
      } else {
        await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          owner, repo, ref: assetsRef, sha: commit.sha, request,
        });
      }
      return {
        assetsRef, assetsCommit: commit.sha,
        imageUrls: files.map((file) => `${pull.base.repo.html_url}/blob/${commit.sha}/${file.path}?raw=true`),
      };
    } catch (err) {
      if (![409, 422].includes(statusOf(err) ?? 0)) throw err;
      // Retry only if another writer actually changed the ref. Rules failures keep GitHub's message.
      const currentSha = await assetHead().catch(() => { throw err; });
      const deleted = parent !== undefined && currentSha === undefined && /reference does not exist/i.test(githubMessage(err));
      if (!deleted && (!currentSha || currentSha === parent)) throw err;
      if (attempt === 11) {
        throw new CommentImageError(`Concurrent image uploads kept advancing the assets ref: ${githubMessage(err)}. Retry after other uploads finish.`);
      }
      await delay(randomInt(25, Math.min(1000, 100 * 2 ** attempt)), undefined, { signal: ctx.signal });
    }
  }
}
