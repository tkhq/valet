import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, ExternalLink, FileText } from "lucide-react";
import type { MessagePart } from "@valet/api/wire";
import { readSources, type SourceRecord } from "@valet/shared";
import { ServiceGlyph } from "~/components/service-icon";
import { FOCUS_RING, Popover, PopoverContent, PopoverTrigger, textLinkClass, TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { NO_LINK_TEXT, sourcePresentation } from "./source-presentation";

interface ThreadSource {
  source: SourceRecord;
  callId: string;
}
interface RevealRequest { callId: string; sourceId: string; key: number }
interface SourceContextValue {
  sources: ReadonlyMap<string, ThreadSource>;
  reveal?: RevealRequest;
  showStep: (callId: string, sourceId: string) => void;
  focusStep: (element: HTMLElement, request: RevealRequest) => void;
}
const SourceContext = createContext<SourceContextValue>({ sources: new Map(), showStep: () => {}, focusStep: () => {} });

export function useThreadSources() { return useContext(SourceContext); }

/** A thread owns its source ids. Other threads in the session never enter this index. */
export function ThreadSourcesProvider({ threadId, messages, children }: {
  threadId?: string;
  messages: readonly { threadId?: string | null; role: string; parts: readonly MessagePart[] }[];
  children: ReactNode;
}) {
  const previous = useRef<{ threadId?: string; sources: Map<string, ThreadSource> }>({ sources: new Map() });
  const sources = useMemo(() => {
    const index = new Map<string, ThreadSource>();
    for (const message of messages) {
      if (!threadId || message.threadId !== threadId || message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.kind !== "tool_call") continue;
        for (const source of readSources(part.result)) index.set(source.id, { source, callId: part.callId });
      }
    }
    const cached = previous.current;
    const unchanged = cached.threadId === threadId && cached.sources.size === index.size && [...index].every(([id, entry]) => {
      const old = cached.sources.get(id);
      return old?.callId === entry.callId && old.source.service === entry.source.service && old.source.title === entry.source.title &&
        old.source.url === entry.source.url && old.source.snippet === entry.source.snippet && old.source.location === entry.source.location;
    });
    // A text delta keeps source context stable, so existing citation controls do not rerender.
    if (unchanged) return cached.sources;
    previous.current = { threadId, sources: index };
    return index;
  }, [threadId, messages]);
  // Keeping the thread on the request also clears navigation on an unkeyed thread switch.
  const [request, setRequest] = useState<{ threadId?: string; reveal: RevealRequest }>();
  const nextKey = useRef(0);
  const focusedKey = useRef(0);
  const showStep = useCallback((callId: string, sourceId: string) => {
    setRequest({ threadId, reveal: { callId, sourceId, key: ++nextKey.current } });
  }, [threadId]);
  const focusStep = useCallback((element: HTMLElement, reveal: RevealRequest) => {
    // A call can show in the transcript and the task card. Focus its first mounted copy once.
    if (focusedKey.current === reveal.key) return;
    focusedKey.current = reveal.key;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center", behavior: "instant" });
  }, []);
  const reveal = request?.threadId === threadId ? request?.reveal : undefined;
  const value = useMemo(() => ({ sources, reveal, showStep, focusStep }), [sources, reveal, showStep, focusStep]);
  return <SourceContext.Provider value={value}><TooltipProvider>{children}</TooltipProvider></SourceContext.Provider>;
}

function SourcePreview({ source, excerpt = false }: { source: SourceRecord; excerpt?: boolean }) {
  const display = sourcePresentation(source);
  return <span className="block space-y-1 [overflow-wrap:anywhere]">
    <span className="line-clamp-2 font-medium text-ink" title={display.title}>{display.title}</span>
    <span className="line-clamp-2 text-xs text-muted">{[display.service, display.location].filter(Boolean).join(" · ")}</span>
    {excerpt && display.excerpt && <span className="line-clamp-3 text-xs leading-5 text-muted">{display.excerpt}</span>}
  </span>;
}

/** A citation keeps the original and the tool step available to mouse, keyboard, and touch. */
export function Citation({ id }: { id: string }) {
  const { sources, showStep } = useThreadSources();
  const entry = sources.get(id);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const showingStep = useRef(false);
  if (!entry) return <>{`[${id}]`}</>;
  const { source, callId } = entry;
  const display = sourcePresentation(source);
  return <Popover open={open} onOpenChange={setOpen}>
    <TooltipRoot delayDuration={200} open={!open && hovered} onOpenChange={setHovered}>
      <span className="not-prose relative mx-0.5 inline-block h-4 w-6 align-middle">
        <TooltipTrigger asChild><PopoverTrigger asChild>
          <button type="button" aria-label={`Source ${id}: ${display.title}`}
            className={cn("absolute left-1/2 top-1/2 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 touch-manipulation items-center justify-center rounded text-muted hover:text-ink", FOCUS_RING)}>
            <span aria-hidden className="inline-flex h-3.5 w-3.5 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"><ServiceGlyph service={source.service} fallback={<FileText />} /></span>
          </button>
        </PopoverTrigger></TooltipTrigger>
      </span>
      <TooltipContent align="start" className="not-prose w-64 p-2.5"><SourcePreview source={source} /></TooltipContent>
    </TooltipRoot>
    <PopoverContent aria-label={`Source ${id}`} align="start" className="not-prose w-72 text-sm"
      onCloseAutoFocus={event => { if (showingStep.current) { event.preventDefault(); showingStep.current = false; } }}>
      <SourcePreview source={source} excerpt />
      <div className="mt-2 flex items-center gap-4 text-xs">
        {!source.url && <span className="text-muted">{NO_LINK_TEXT}</span>}
        {source.url && <a href={source.url} {...(source.url.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
          className={cn(textLinkClass, FOCUS_RING, "min-h-6 rounded [@media(pointer:coarse)]:min-h-11")}>
          Open original<ExternalLink aria-hidden className="h-3 w-3" />
        </a>}
        <button type="button" className={cn(FOCUS_RING, "inline-flex min-h-6 items-center gap-1 rounded text-muted hover:text-ink hover:underline [@media(pointer:coarse)]:min-h-11")}
          onClick={() => { showingStep.current = true; setOpen(false); showStep(callId, id); }}>
          Show step<CornerDownLeft aria-hidden className="h-3 w-3" />
        </button>
      </div>
    </PopoverContent>
  </Popover>;
}

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, string> };
}

/** Convert only prose text. Markdown code, links, images, and HTML remain literal. */
export function remarkSourceCitations() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : undefined;
    const maxGroupTextLength = 12;
    function textLength(node: MarkdownNode): number {
      return node.value?.length ?? node.children?.reduce((sum, child) => sum + textLength(child), 0) ?? 0;
    }
    function appendCitation(nodes: MarkdownNode[], prefix: string, citation: MarkdownNode) {
      const group = (children: MarkdownNode[]): MarkdownNode => ({
        type: "sourceCitationGroup", data: { hName: "span", hProperties: { className: "inline-flex items-center whitespace-nowrap" } }, children,
      });
      const previous = nodes.at(-1);
      const between: MarkdownNode[] = prefix ? [{ type: "text", value: prefix }] : [];
      if (/^[\s.,;:!?]*$/.test(prefix) && prefix.trim().length <= 3 && previous &&
        ["inlineCode", "strong", "emphasis", "delete"].includes(previous.type) && textLength(previous) <= maxGroupTextLength) {
        nodes.pop();
        nodes.push(group([previous, ...between, citation]));
        return;
      }
      const lastWord = prefix.match(/\S+\s*$/)?.[0];
      if (lastWord) {
        if (lastWord.trimEnd().length <= maxGroupTextLength) {
          const before = prefix.slice(0, -lastWord.length);
          if (before) nodes.push({ type: "text", value: before });
          nodes.push(group([{ type: "text", value: lastWord }, citation]));
        } else nodes.push({ type: "text", value: prefix }, citation);
        return;
      }
      if (previous?.type === "sourceCitationGroup" && (previous.children?.filter(child => child.type === "sourceCitation").length ?? 0) < 3) {
        previous.children?.push(...between, citation);
      } else nodes.push(...between, citation);
    }
    function visit(node: MarkdownNode) {
      if (["code", "inlineCode", "link", "linkReference", "image", "imageReference", "html"].includes(node.type) || !node.children) return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) { visit(child); children.push(child); continue; }
        const matches = [...child.value.matchAll(/\[(s\d+)\]/g)];
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const raw = source !== undefined && start !== undefined && end !== undefined ? source.slice(start, end) : undefined;
        const originals = raw === undefined ? undefined : [...raw.matchAll(/\[(s\d+)\]/g)];
        // Entity-encoded brackets are text. Source positions also preserve an escaped opening bracket.
        if (originals && (originals.length !== matches.length || originals.some((match, i) => match[1] !== matches[i]?.[1]))) {
          children.push(child);
          continue;
        }
        let offset = 0;
        for (const [i, match] of matches.entries()) {
          const original = originals?.[i];
          if (original && raw !== undefined) {
            let slash = original.index - 1;
            while (slash >= 0 && raw[slash] === "\\") slash--;
            if ((original.index - 1 - slash) % 2 === 1) continue;
          }
          const id = match[1];
          if (!id) continue;
          const index = match.index;
          appendCitation(children, child.value.slice(offset, index), {
            type: "sourceCitation", data: { hName: "cite", hProperties: { "data-source-id": id } }, children: [{ type: "text", value: match[0] }],
          });
          offset = index + match[0].length;
        }
        if (offset === 0) children.push(child);
        else if (offset < child.value.length) children.push({ type: "text", value: child.value.slice(offset) });
      }
      node.children = children;
    }
    visit(tree);
  };
}
