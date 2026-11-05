import type { BrowserArtifact } from "@valet/shared";
import type { BrowserAnnotationMark } from "../wire/types.js";

export function validateAnnotationMarks(
  artifact: BrowserArtifact,
  marks: BrowserAnnotationMark[],
) {
  const scale = artifact.viewport?.deviceScaleFactor ?? 1;
  const width =
    artifact.clip?.width ??
    (artifact.width ? artifact.width / scale : artifact.viewport?.width);
  const height =
    artifact.clip?.height ??
    (artifact.height ? artifact.height / scale : artifact.viewport?.height);
  if (
    !width ||
    !height ||
    !["image/png", "image/jpeg", "image/webp"].includes(artifact.mimeType)
  ) {
    throw new Error(
      "This evidence has no supported screenshot geometry. Capture a viewport screenshot before adding annotations.",
    );
  }
  if (!marks.length || marks.length > 50)
    throw new Error("Annotation count is invalid. Add between 1 and 50 marks.");
  for (const mark of marks) {
    if (
      !Number.isFinite(mark.x) ||
      !Number.isFinite(mark.y) ||
      mark.x < 0 ||
      mark.y < 0 ||
      mark.x > width ||
      mark.y > height
    ) {
      throw new Error(
        "The annotation is outside the screenshot bounds. Select a point inside the captured image.",
      );
    }
    if (mark.label.length > 200)
      throw new Error(
        "The annotation label is too long. Enter at most 200 characters.",
      );
  }
  return { width, height };
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

export function renderBrowserAnnotation(
  artifact: BrowserArtifact,
  bytes: Uint8Array,
  marks: BrowserAnnotationMark[],
): string {
  const { width, height } = validateAnnotationMarks(artifact, marks);
  const image = Buffer.from(bytes).toString("base64");
  const overlay = marks
    .map(
      (mark, index) =>
        `<g><circle cx="${mark.x}" cy="${mark.y}" r="9" fill="#dc2626" stroke="white" stroke-width="2"/><text x="${mark.x}" y="${mark.y + 4}" text-anchor="middle" fill="white" font-size="11">${index + 1}</text><text x="${Math.min(mark.x + 14, width - 10)}" y="${Math.max(mark.y - 12, 14)}" fill="#dc2626" stroke="white" stroke-width="3" paint-order="stroke" font-size="14">${xml(mark.label)}</text></g>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Annotated browser screenshot</title><image width="${width}" height="${height}" href="data:${artifact.mimeType};base64,${image}"/>${overlay}</svg>`;
}
