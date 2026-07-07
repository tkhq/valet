/**
 * Pure helper functions for OKF memory operations.
 *
 * normalizeResource  — canonical URI form for the `resource` column.
 * extractLinks       — outgoing link extraction from a markdown body.
 * renderIndex        — virtual OKF index.md generation.
 * deriveFtsDescription — FTS description field derivation.
 * tagsToFtsText      — JSON tag array → space-joined FTS text.
 */

import { normalizePath } from './db/memory-path.js';

// ---------------------------------------------------------------------------
// Resource normalization
// ---------------------------------------------------------------------------

/**
 * Closed list of tracking query params to remove (plus utm_* prefix).
 * Changing this list requires a re-normalization migration over stored values.
 */
export const TRACKED_PARAMS = ['fbclid', 'gclid', 'ref', 'si'] as const;

/**
 * Normalize a resource URI for storage and deduplication.
 *
 * - Lowercases scheme and host (URL() does this automatically).
 * - Upgrades http → https.
 * - Drops default ports (443 for https, 80 for http — both after upgrade).
 * - Strips trailing slash from pathname (but not the root `/`).
 * - Strips `.git` suffix from pathname.
 * - Removes tracking params: all `utm_*`-prefixed params plus the TRACKED_PARAMS list.
 * - Non-URL input is returned trimmed as-is.
 */
export function normalizeResource(uri: string): string {
  const trimmed = uri.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // Upgrade http → https
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }

  // Drop default ports (check after potential upgrade to https)
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'https:' && url.port === '80') ||  // was http:80, now https
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  // Strip trailing slash from pathname first, then .git
  let pathname = url.pathname;
  if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname.endsWith('.git')) pathname = pathname.slice(0, -4);

  // Remove tracking params
  const keysToDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (key.startsWith('utm_') || (TRACKED_PARAMS as readonly string[]).includes(key)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }

  // Build result manually to avoid URL serializer always appending '/' for root paths
  const port = url.port ? `:${url.port}` : '';
  // Use pathname only when it's non-empty (non-root)
  const path = pathname.length > 0 ? pathname : '';
  const search = url.search;      // '' or '?...' — URL normalizes this
  const hash = url.hash;
  let result = `${url.protocol}//${url.hostname}${port}${path}${search}${hash}`;
  // Strip trailing '?' just in case
  if (result.endsWith('?')) result = result.slice(0, -1);
  return result;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Resolve a link target against a fromPath directory.
 * Bundle-relative paths (starting with '/') are resolved from the root.
 * Relative paths are resolved against the directory of fromPath.
 * Returns the normalized path (via normalizePath), or null if resolution fails.
 * Exported for the import link-rewriter, which needs the identical resolution rules.
 */
export function resolveLinkTarget(fromPath: string, target: string): string | null {
  // Percent-decode the target before any path operations
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }

  // External URL — skip
  if (/^https?:\/\//i.test(decoded) || /^[a-z][a-z0-9+\-.]*:\/\//i.test(decoded)) {
    return null;
  }

  // Strip fragment (anchor), and exclude anchor-only links
  const hashIdx = decoded.indexOf('#');
  if (hashIdx === 0) return null;          // anchor-only — not a cross-file link
  const path = hashIdx > 0 ? decoded.slice(0, hashIdx) : decoded;

  let absolute: string;
  if (path.startsWith('/')) {
    // Bundle-relative: strip leading slash, treat as from-root
    absolute = path.slice(1);
  } else {
    // Relative: resolve against fromPath's directory
    const lastSlash = fromPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? fromPath.slice(0, lastSlash + 1) : '';
    absolute = dir + path;
  }

  // Resolve . and .. segments manually (no URL object — pure path math)
  const segments = absolute.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop();
    } else if (seg !== '.' && seg !== '') {
      resolved.push(seg);
    }
  }

  const joined = resolved.join('/');
  return normalizePath(joined);
}

/**
 * Extract outgoing links from a markdown body.
 *
 * Rules:
 * - Links inside fenced code blocks (``` or ~~~) are ignored.
 * - Links inside inline code (`...`) are ignored.
 * - External URLs (http://, https://, or any scheme://) are never returned.
 * - context = the containing line, trimmed, ≤200 chars.
 * - Duplicate targets: first context wins.
 * - Relative paths are resolved against fromPath's directory.
 * - Bundle-relative paths (starting with /) are resolved from the root.
 * - Percent-encoding in the link URL is decoded before normalization.
 */
export function extractLinks(
  fromPath: string,
  body: string,
): Array<{ toPath: string; context: string }> {
  const seen = new Map<string, string>(); // toPath → context (first wins)
  const lines = body.split('\n');
  let inFence = false;

  for (const rawLine of lines) {
    // Fenced code block tracking
    if (rawLine.startsWith('```') || rawLine.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Strip inline code segments before scanning for links
    const lineForLinks = rawLine.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));

    LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(lineForLinks)) !== null) {
      const target = match[2];
      const toPath = resolveLinkTarget(fromPath, target);
      if (toPath === null || toPath === '') continue;

      if (!seen.has(toPath)) {
        const context = rawLine.trim().slice(0, 200);
        seen.set(toPath, context);
      }
    }
  }

  return Array.from(seen.entries()).map(([toPath, context]) => ({ toPath, context }));
}

// ---------------------------------------------------------------------------
// Virtual index rendering
// ---------------------------------------------------------------------------

/**
 * Render a virtual OKF index.md for a directory.
 *
 * - Root index (`isRoot: true`) carries `okf_version: "0.1"` frontmatter.
 * - Non-root has no frontmatter.
 * - Subdirs are given as FULL bundle-relative paths (e.g. `projects/valet`);
 *   the entry displays the basename but links the full path:
 *   `* [valet](/projects/valet/)`.
 * - Files rendered as `* [Title](/path) - description` (suffix omitted when description is empty).
 * - All entries in path-lexicographic order.
 */
export function renderIndex(
  _dirPath: string,
  subdirs: string[],
  files: Array<{ path: string; title: string; description: string }>,
  isRoot: boolean,
): string {
  const lines: string[] = [];

  if (isRoot) {
    lines.push('---', 'okf_version: "0.1"', '---');
  }

  const sortedSubdirs = [...subdirs].sort();
  for (const subdir of sortedSubdirs) {
    // Normalize: strip trailing slash. Display the basename, link the full path.
    const fullPath = subdir.replace(/\/$/, '');
    const name = fullPath.split('/').pop() ?? fullPath;
    lines.push(`* [${name}](/${fullPath}/)`);
  }

  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) {
    const desc = file.description ? ` - ${file.description}` : '';
    lines.push(`* [${file.title}](/${file.path})${desc}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// FTS helpers
// ---------------------------------------------------------------------------

/**
 * Derive the FTS description field.
 *
 * Returns `authored` when non-empty. Otherwise extracts the first non-heading
 * paragraph from `body` (up to 200 chars).
 */
export function deriveFtsDescription(authored: string, body: string): string {
  if (authored) return authored;

  // Walk the body lines to find the first non-blank, non-heading paragraph
  const lines = body.split('\n');
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inParagraph) {
      if (trimmed === '' || trimmed.startsWith('#')) {
        // Skip headings and blank lines between blocks
        continue;
      }
      // Start of a paragraph
      inParagraph = true;
      paragraphLines.push(trimmed);
    } else {
      if (trimmed === '') {
        // End of paragraph
        break;
      }
      paragraphLines.push(trimmed);
    }
  }

  const text = paragraphLines.join(' ');
  return text.slice(0, 200);
}

/**
 * Convert a JSON-encoded string array of tags to a space-joined FTS string.
 * Invalid JSON or non-array values produce an empty string.
 */
export function tagsToFtsText(tagsJson: string): string {
  try {
    const parsed = JSON.parse(tagsJson);
    if (!Array.isArray(parsed)) return '';
    return parsed.map(String).join(' ');
  } catch {
    return '';
  }
}
