import { createHash } from "node:crypto";
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

function plainMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*{}\[\]()<>!_#|]/g, "\\$&");
}

export function imageCommentBody(body: string | undefined, images: CommentImage[], urls: string[]): string {
  return [body, ...images.map((image, i) => {
    const alt = plainMarkdown(image.alt ?? image.caption ?? `Image ${i + 1}`);
    const caption = image.caption ? `\n\n${plainMarkdown(image.caption)}` : "";
    return `![${alt}](${urls[i]})${caption}`;
  })].filter(Boolean).join("\n\n");
}

/** Only HTTP status codes cross this boundary. Remote error bodies can contain secrets. */
function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status : undefined;
}

export function imageUploadError(err: unknown): string {
  const status = statusOf(err);
  if (status === undefined && err instanceof CommentImageError) return err.message;
  if (status === 401) return "GitHub rejected the credential. Reconnect GitHub in Settings and retry.";
  if (status === 403) return "GitHub denied image storage or commenting. Grant contents:write, pull_requests:read, and issues:write to the App. Check branch rules and rate limits.";
  if (status === 404) return "GitHub could not access the repository or pull request. Check owner and issueNumber. Grant repository access in Settings.";
  return `GitHub image attachment failed (${status ?? "network error"}). Check repository branch rules and GitHub availability, then retry.`;
}

/** Validate the complete batch before any GitHub write. Use the sandbox port, not host filesystem access. */
export async function storeCommentImages(
  octokit: Octokit,
  ctx: PluginActionContext,
  owner: string,
  repo: string,
  issueNumber: number,
  images: CommentImage[],
): Promise<{ imageUrls: string[]; assetsBranch: string; assetsCommit: string }> {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new CommentImageError("Invalid pull request number. Supply a positive issueNumber and retry.");
  }
  if (images.length < 1 || images.length > 10) {
    throw new CommentImageError("Invalid image count. Supply between 1 and 10 sandbox image files.");
  }
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
    } catch {
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
    owner, repo, pull_number: issueNumber,
  });
  const assetsBranch = `valet-pr-assets-${issueNumber}`;
  if ([pull.head.ref, pull.base.ref, pull.base.repo.default_branch].includes(assetsBranch)) {
    throw new CommentImageError("The assets branch is a PR or default branch. Rename that branch before attaching images.");
  }
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  // Identical bytes share a blob and a tree entry, but keep their individual captions.
  for (const file of new Map(files.map((file) => [file.path, file])).values()) {
    const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
      owner, repo, content: Buffer.from(file.bytes).toString("base64"), encoding: "base64",
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  // No base_tree: each commit contains only this batch. Prior batches remain in parent history.
  const { data: snapshot } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, tree });
  for (let attempt = 0; attempt < 3; attempt++) {
    let parent: string | undefined;
    try {
      const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner, repo, ref: `heads/${assetsBranch}`,
      });
      parent = ref.object.sha;
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    if (parent) {
      const { data: previous } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner, repo, commit_sha: parent,
      });
      if (!previous.message.includes(`Attach images for PR #${issueNumber}\n\nChangelog: Attach PR comment images with Valet.`)) {
        throw new CommentImageError("The assets branch contains unrelated commits. Rename that branch before attaching images.");
      }
    }
    const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner, repo, tree: snapshot.sha, parents: parent ? [parent] : [],
      message: `Attach images for PR #${issueNumber}\n\nChangelog: Attach PR comment images with Valet.`,
    });
    try {
      if (parent) {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner, repo, ref: `heads/${assetsBranch}`, sha: commit.sha, force: false,
        });
      } else {
        await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          owner, repo, ref: `refs/heads/${assetsBranch}`, sha: commit.sha,
        });
      }
      const base = pull.base.repo.html_url;
      return {
        assetsBranch, assetsCommit: commit.sha,
        imageUrls: files.map((file) => `${base}/blob/${commit.sha}/${file.path}?raw=true`),
      };
    } catch (err) {
      // A normal concurrent upload can win ref creation or advancement. Never force-push over it.
      if (![409, 422].includes(statusOf(err) ?? 0)) throw err;
      if (attempt === 2) throw new CommentImageError("GitHub refused the assets branch update. Check branch rules, then retry after other uploads finish.");
    }
  }
  throw new CommentImageError("Image storage did not finish. Retry after other uploads finish.");
}
