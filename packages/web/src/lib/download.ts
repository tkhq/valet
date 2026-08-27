/** Trigger a browser download of `text` as a file named `filename`. */
export function downloadTextFile(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Firefox only honours `download` on an anchor that is in the DOM, and
  // a synchronous revoke races the download fetch — defer it a tick.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Pure: memory path → download filename (basename; `.md` when there is no
 * extension). */
export function memoryDownloadName(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "memory";
  return base.includes(".") ? base : `${base}.md`;
}

/** Pure: artifact title → `.md` download filename. Titles are free text, so
 * everything outside [a-z0-9] collapses to a hyphen. */
export function artifactDownloadName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "artifact"}.md`;
}
