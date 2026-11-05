import { useState } from "react";
import type { BrowserAnnotationMark } from "@valet/api/wire";
import type { BrowserArtifact } from "@valet/shared";
import {
  browserApi,
  useBrowserAnnotations,
  useSaveBrowserAnnotation,
} from "~/api/browser";
import { Button, Input } from "~/components/primitives";
import { browserPoint } from "./input";

export type AnnotatableEvidence = Pick<
  BrowserArtifact,
  | "id"
  | "sessionId"
  | "documentId"
  | "filename"
  | "mimeType"
  | "width"
  | "height"
  | "viewport"
  | "clip"
>;

export function screenshotSize(
  evidence: AnnotatableEvidence,
): { width: number; height: number } | null {
  const scale = evidence.viewport?.deviceScaleFactor ?? 1;
  const width =
    evidence.clip?.width ??
    (evidence.width ? evidence.width / scale : evidence.viewport?.width);
  const height =
    evidence.clip?.height ??
    (evidence.height ? evidence.height / scale : evidence.viewport?.height);
  return width &&
    height &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

export function EvidenceAnnotations({
  evidence,
}: {
  evidence: AnnotatableEvidence;
}) {
  const query = useBrowserAnnotations(evidence.sessionId, evidence.id);
  const save = useSaveBrowserAnnotation(evidence.sessionId, evidence.id);
  const [marks, setMarks] = useState<BrowserAnnotationMark[]>([]);
  const [label, setLabel] = useState("");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const size = screenshotSize(evidence);
  const selected = query.data?.annotations.find(
    (annotation) => annotation.id === selectedId,
  );
  const shown = selected?.marks ?? marks;

  function addMark(point: { x: number; y: number }) {
    if (!size || marks.length >= 50 || save.isPending) return;
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= size.width ||
      point.y >= size.height
    ) {
      setError(
        "The pin is outside this image. Select a point inside the image.",
      );
      return;
    }
    setError(null);
    setSelectedId(null);
    setMarks((previous) => [
      ...previous,
      {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
        label: label.trim().slice(0, 200),
      },
    ]);
    setLabel("");
  }
  async function saveMarks() {
    if (!evidence.documentId || !marks.length) return;
    setError(null);
    try {
      const result = await save.mutateAsync({
        documentId: evidence.documentId,
        marks,
      });
      setMarks([]);
      setSelectedId(result.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The annotations could not be saved. Retry after checking your connection.",
      );
    }
  }

  if (!size || !evidence.documentId)
    return (
      <p className="text-muted">
        This image has no page coordinates. Capture a new browser screenshot to
        add annotations.
      </p>
    );
  return (
    <section
      aria-label={`Annotations for ${evidence.filename}`}
      className="space-y-3 rounded border border-line p-3"
    >
      <p className="text-xs text-muted">
        Add an optional label, then select a point in the saved image.
      </p>
      <Input
        aria-label="Pin label"
        placeholder="Optional pin label"
        maxLength={200}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        disabled={save.isPending}
      />
      <button
        type="button"
        aria-label={`Place a pin on ${evidence.filename}`}
        className="relative block w-full overflow-hidden rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
        disabled={save.isPending || marks.length >= 50}
        onClick={(event) => {
          const point = browserPoint(
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
            size,
          );
          if (point) addMark(point);
        }}
      >
        <img
          src={browserApi.evidence(evidence.sessionId, evidence.id)}
          alt={evidence.filename}
          className="block h-auto w-full"
          draggable={false}
        />
        {shown.map((mark, index) => (
          <span
            key={index}
            title={mark.label}
            className="pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-moss text-xs font-semibold text-white shadow"
            style={{
              left: `${(mark.x / size.width) * 100}%`,
              top: `${(mark.y / size.height) * 100}%`,
            }}
          >
            {index + 1}
          </span>
        ))}
      </button>
      {selected?.stale ? (
        <p className="text-xs text-warning-fg">
          The browser page has changed since this image was captured. These pins
          belong to the saved image.
        </p>
      ) : null}
      {shown.length ? (
        <ol className="space-y-1 text-xs">
          {shown.map((mark, index) => (
            <li key={index} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-words">
                {index + 1}. {mark.label || "Unlabeled pin"} ({mark.x}, {mark.y}
                )
              </span>
              {!selected ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove pin ${index + 1}`}
                  disabled={save.isPending}
                  onClick={() =>
                    setMarks((previous) =>
                      previous.filter((_, position) => position !== index),
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Place a pin by position</summary>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addMark({ x: Number(x), y: Number(y) });
          }}
        >
          <Input
            aria-label="Pin X position"
            type="number"
            min={0}
            max={size.width - 1}
            value={x}
            onChange={(event) => setX(event.target.value)}
          />
          <Input
            aria-label="Pin Y position"
            type="number"
            min={0}
            max={size.height - 1}
            value={y}
            onChange={(event) => setY(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={save.isPending || marks.length >= 50}
          >
            Add pin
          </Button>
        </form>
      </details>
      {error || query.isError ? (
        <p role="alert" className="text-xs text-danger-600">
          {error ??
            "Saved annotations could not load. Close this panel and reopen it to retry."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!marks.length || save.isPending || Boolean(selected)}
          onClick={() => void saveMarks()}
        >
          {save.isPending ? "Saving…" : "Save annotations"}
        </Button>
        {selected ? (
          <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
            New annotations
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <p className="text-xs text-muted">Loading saved annotations…</p>
      ) : (
        query.data?.annotations.map((annotation) => (
          <div
            key={annotation.id}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedId(annotation.id)}
            >
              Show {annotation.marks.length} saved pins
            </Button>
            <a
              className="text-moss underline"
              download
              href={browserApi.annotationExport(
                evidence.sessionId,
                evidence.id,
                annotation.id,
              )}
            >
              Download annotated image
            </a>
          </div>
        ))
      )}
    </section>
  );
}
