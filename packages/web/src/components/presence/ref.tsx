/**
 * A reference token: a thing a sentence names, such as a place, a thread, a
 * workflow, a person, or a line of presence. The token sits in the line of text at the text's
 * size, on a hairline wash, with a 12px mark that says what kind of thing it
 * is. It is a link when the thing has a page.
 */
import { Link } from "@tanstack/react-router";
import type { AppPath } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { ServiceGlyph, glyphColor, type MarkService } from "./service-mark";

export type RefKind = "place" | "thread" | "workflow" | "person" | "line";

const GLYPH = 12;

function KindGlyph({ kind }: { kind: Exclude<RefKind, "place"> }) {
  const common = {
    viewBox: "0 0 24 24",
    width: GLYPH,
    height: GLYPH,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  if (kind === "thread") {
    return <svg {...common}><path d="M4 5h16v10H9l-5 4z" /></svg>;
  }
  if (kind === "workflow") {
    return <svg {...common}><path d="M5 6h5v5H5zM14 13h5v5h-5zM10 8.5h4v7" /></svg>;
  }
  if (kind === "line") {
    return <svg {...common}><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>;
}

/** The pill's side padding, in em so it scales with the sentence's size. `Sentence` pulls closing punctuation back by the same amount. */
export const TOKEN_PAD_X = "px-[0.4em]";
const TOKEN = `inline-flex items-center gap-1 rounded-[5px] bg-ink-wash ${TOKEN_PAD_X} font-medium text-ink whitespace-nowrap align-baseline`;
const LINK = "no-underline hover:bg-moss-wash hover:text-accent-600";

export function Ref({
  kind,
  text,
  service,
  to,
  params,
  search,
  className,
}: {
  kind: RefKind;
  text: string;
  /** A place's service, for its mark. */
  service?: Exclude<MarkService, "schedule">;
  to?: AppPath;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  className?: string;
}) {
  const color = kind === "place" && service !== undefined ? glyphColor(service) : undefined;
  const mark = (
    <span
      data-ref-mark={kind}
      aria-hidden="true"
      className={cn("inline-grid h-3 w-3 flex-none place-items-center", color === undefined && (kind === "place" ? "text-ink" : "text-muted"))}
      style={color !== undefined ? { color } : undefined}
    >
      {kind === "place"
        ? (service !== undefined ? <ServiceGlyph service={service} size={GLYPH} /> : null)
        : <KindGlyph kind={kind} />}
    </span>
  );
  if (to !== undefined) {
    return (
      <Link to={to} params={params} search={search} data-ref={kind} className={cn(TOKEN, LINK, className)}>
        {mark}
        {text}
      </Link>
    );
  }
  return (
    <span data-ref={kind} className={cn(TOKEN, className)}>
      {mark}
      {text}
    </span>
  );
}
