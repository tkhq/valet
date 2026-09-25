import { useState } from "react";
import { Globe } from "lucide-react";
import { browserApi } from "~/api/browser";
import { Button } from "~/components/primitives";
import {
  EvidenceAnnotations,
  screenshotSize,
  type AnnotatableEvidence,
} from "../browser/evidence-annotations";
import { ToolBody, TruncatedText } from "./tool-shell";
import {
  resultText,
  structuredResult,
  type ToolRenderer,
  type ToolRendererProps,
} from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function params(args: unknown): Record<string, unknown> {
  if (!record(args)) return {};
  return record(args.params) ? args.params : args;
}

function resultData(result: unknown): Record<string, unknown> {
  if (record(result) && record(result.data)) return result.data;
  const parsed = structuredResult(result);
  return record(parsed) ? parsed : record(result) ? result : {};
}

function images(result: unknown): string[] {
  if (!record(result) || !Array.isArray(result.content)) return [];
  return result.content
    .flatMap((block: unknown) => {
      if (
        !record(block) ||
        block.type !== "image" ||
        typeof block.data !== "string" ||
        typeof block.mimeType !== "string"
      )
        return [];
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(block.mimeType) ||
        !block.data ||
        block.data.length > 8 * 1024 * 1024
      )
        return [];
      return [`data:${block.mimeType};base64,${block.data}`];
    })
    .slice(0, 8);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function annotatableEvidence(
  artifact: Record<string, unknown>,
): AnnotatableEvidence | null {
  const { id, sessionId, documentId, filename, mimeType, viewport, clip } =
    artifact;
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof documentId !== "string" ||
    !documentId ||
    typeof filename !== "string" ||
    typeof mimeType !== "string" ||
    !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
  )
    return null;
  const evidence: AnnotatableEvidence = {
    id,
    sessionId,
    documentId,
    filename,
    mimeType,
    width:
      finite(artifact.width) && artifact.width > 0 ? artifact.width : undefined,
    height:
      finite(artifact.height) && artifact.height > 0
        ? artifact.height
        : undefined,
  };
  if (
    record(viewport) &&
    finite(viewport.width) &&
    viewport.width > 0 &&
    finite(viewport.height) &&
    viewport.height > 0 &&
    finite(viewport.deviceScaleFactor) &&
    viewport.deviceScaleFactor > 0 &&
    finite(viewport.scrollX) &&
    finite(viewport.scrollY)
  ) {
    evidence.viewport = {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
    };
  }
  if (
    record(clip) &&
    finite(clip.x) &&
    finite(clip.y) &&
    finite(clip.width) &&
    clip.width > 0 &&
    finite(clip.height) &&
    clip.height > 0
  ) {
    evidence.clip = {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
    };
  }
  return screenshotSize(evidence) ? evidence : null;
}

function SavedArtifact({
  artifact,
  index,
}: {
  artifact: Record<string, unknown>;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  if (typeof artifact.id !== "string" || typeof artifact.sessionId !== "string")
    return null;
  const filename =
    typeof artifact.filename === "string"
      ? artifact.filename
      : `Saved evidence ${index + 1}`;
  const evidence = annotatableEvidence(artifact);
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={browserApi.evidence(artifact.sessionId, artifact.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-moss underline"
        >
          {filename}
        </a>
        {evidence ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${open ? "Close annotations for" : "Annotate"} ${filename}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Close annotations" : "Annotate…"}
          </Button>
        ) : null}
      </div>
      {open && evidence ? (
        <EvidenceAnnotations
          key={`${evidence.sessionId}:${evidence.id}`}
          evidence={evidence}
        />
      ) : null}
    </li>
  );
}

function Body({ args, result, status, error }: ToolRendererProps) {
  const data = resultData(result);
  const artifacts = Array.isArray(data.artifacts)
    ? data.artifacts.filter(record)
    : [];
  const sessionId =
    typeof data.sessionId === "string"
      ? data.sessionId
      : artifacts.find((artifact) => typeof artifact.sessionId === "string")
          ?.sessionId;
  const text =
    error ?? (typeof data.text === "string" ? data.text : resultText(result));
  const pictures = images(result);
  const code = params(args).code;
  return (
    <ToolBody className="space-y-3">
      {status === "running" || status === "streaming" ? (
        <p>Browser action in progress…</p>
      ) : null}
      {typeof sessionId === "string" ? (
        <a
          href={`/sessions/${encodeURIComponent(sessionId)}?tab=browser`}
          className="inline-flex items-center gap-1 text-moss underline"
        >
          <Globe aria-hidden className="h-3.5 w-3.5" />
          Open browser
        </a>
      ) : null}
      {text ? <TruncatedText text={text} /> : null}
      {pictures.map((url, index) => (
        <img
          key={index}
          src={url}
          alt={`Browser evidence ${index + 1}`}
          loading="lazy"
          className="max-h-96 max-w-full rounded border border-line object-contain"
        />
      ))}
      {artifacts.length ? (
        <ul className="space-y-1">
          {artifacts.map((artifact, index) => (
            <SavedArtifact
              key={typeof artifact.id === "string" ? artifact.id : index}
              artifact={artifact}
              index={index}
            />
          ))}
        </ul>
      ) : null}
      {typeof code === "string" && code ? (
        <details>
          <summary className="cursor-pointer text-muted">Browser code</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">
            {code}
          </pre>
        </details>
      ) : null}
    </ToolBody>
  );
}

export const browserRenderer: ToolRenderer = {
  matches: (toolName, args) =>
    /^(?:tool_)?browser[._]/.test(toolName) ||
    (toolName === "call_tool" &&
      record(args) &&
      typeof args.tool_id === "string" &&
      args.tool_id.startsWith("browser.")),
  category: "generic",
  Icon: Globe,
  formatTarget: (args) => {
    const values = params(args);
    return typeof values.title === "string"
      ? values.title
      : typeof values.topic === "string"
        ? values.topic
        : undefined;
  },
  formatSummary: (_args, result) => {
    const cell = resultData(result).cell;
    return record(cell) && typeof cell.status === "string"
      ? cell.status.replaceAll("_", " ")
      : undefined;
  },
  Body,
};
