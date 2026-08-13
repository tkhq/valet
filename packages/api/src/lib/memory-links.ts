/**
 * Memory cross-reference resolution — the one implementation of "does this
 * markdown link point at another memory file, and which one?".
 *
 * Two callers need the same answer and must never disagree: the derived
 * graph (`memory-graph.ts`, server-side) draws an edge for every resolvable
 * target, and the web document view routes a resolvable target through the
 * router instead of opening a new tab. A second copy in `packages/web`
 * would drift, so this module is published to the client through the
 * `@valet/api/memory-links` export subpath.
 *
 * KEEP THIS MODULE DEPENDENCY-FREE. It is bundled into the web client, so
 * it must not import Node built-ins, Drizzle, Hono, or anything else from
 * the server. Pure string work only.
 */

/**
 * Resolve a markdown link target to a bundle path, or null when the target
 * is not a cross-file reference (external URL, anchor, template garbage).
 */
export function resolveLinkTarget(fromPath: string, target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }

  if (/^[a-z][a-z0-9+\-.]*:/i.test(decoded)) return null; // any scheme (http:, mailto:)
  if (/[{}<>]/.test(decoded)) return null; // template placeholders like {url}

  const hashIdx = decoded.indexOf("#");
  if (hashIdx === 0) return null; // anchor-only
  const path = hashIdx > 0 ? decoded.slice(0, hashIdx) : decoded;
  if (path === "") return null;

  let absolute: string;
  if (path.startsWith("/")) {
    absolute = path.slice(1);
  } else {
    const lastSlash = fromPath.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fromPath.slice(0, lastSlash + 1) : "";
    absolute = dir + path;
  }

  const resolved: string[] = [];
  for (const seg of absolute.split("/")) {
    if (seg === "..") resolved.pop();
    else if (seg !== "." && seg !== "") resolved.push(seg);
  }
  const joined = resolved.join("/");
  return joined === "" ? null : joined;
}
