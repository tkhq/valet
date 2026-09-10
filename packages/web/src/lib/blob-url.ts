/** GitHub file link at a ref. Missing files or refs have no link. */
export function blobUrl(
  engagement: { repoFullName: string; repoRef: string },
  file: string | null,
  line: number | null,
): string | null {
  if (!file || engagement.repoRef === "") return null;
  const path = file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const repo = engagement.repoFullName.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${encodeURIComponent(engagement.repoRef)}/${path}${
    line !== null ? `#L${line}` : ""
  }`;
}
