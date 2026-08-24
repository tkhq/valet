/**
 * Element-targeted patching for design_edit's `kind='patch'` mode. The
 * fragment holds one or more top-level elements, each carrying the
 * `data-vdid` of the element it replaces. Replacement is by vdid, never by
 * position, so a patch written against one revision still lands after
 * unrelated edits.
 */
import { parse, type HTMLElement } from "node-html-parser";

export interface PatchResult {
  html: string;
  /** Target vdids that were replaced, in fragment order (deduped). */
  replaced: string[];
}

export function applyElementPatches(html: string, fragment: string): PatchResult {
  const root = parse(html, { comment: true });
  const patch = parse(fragment, { comment: true });

  const patchElements = patch.childNodes.filter(
    (n): n is HTMLElement => Boolean((n as HTMLElement).tagName),
  );
  if (patchElements.length === 0) {
    throw new Error(
      "The patch contains no elements. Send the full outer HTML of each element to replace, each with the data-vdid of its target.",
    );
  }

  // Group consecutive fragment elements by target vdid. Elements sharing a
  // vdid replace that ONE target as a group, in order — the natural way to
  // split an element or insert siblings beside it. Without grouping, the
  // second element found the first's just-inserted replacement (same vdid)
  // and silently clobbered it; the tool reported success while the edit
  // half-vanished (live-verified footgun).
  const groups = new Map<string, HTMLElement[]>();
  for (const el of patchElements) {
    const vdid = el.getAttribute("data-vdid");
    if (!vdid) {
      throw new Error(
        `Patch element <${el.tagName.toLowerCase()}> has no data-vdid. Copy the target element's data-vdid onto the replacement (elements sharing one data-vdid replace that target together, in order).`,
      );
    }
    const group = groups.get(vdid);
    if (group) group.push(el);
    else groups.set(vdid, [el]);
  }

  const replaced: string[] = [];
  for (const [vdid, group] of groups) {
    const target = root.querySelector(`[data-vdid="${vdid}"]`);
    if (!target) {
      throw new Error(
        `No element with data-vdid="${vdid}" exists in the artifact. Re-read the artifact — the element may have been rewritten.`,
      );
    }
    // Insert the group after the target, in order, then drop the target.
    let anchor: HTMLElement = target;
    for (const el of group) {
      anchor.after(el);
      anchor = el;
    }
    target.remove();
    replaced.push(vdid);
  }

  return { html: root.toString(), replaced };
}
