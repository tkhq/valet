import { isValidElement, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveLinkTarget } from "@valet/api/memory-links";
import { cn } from "~/lib/cn";
import { usePublicOrigin } from "~/lib/public-origin";
import { CodeBlock } from "./code-block";
import { MermaidDiagram } from "./mermaid-diagram";

/** react-markdown wraps a fenced block's highlighted `code` in `pre`, with
 * the language on the inner element's `className` as `language-xxx`
 * (remark's standard convention) — pull both out to hand off to
 * `CodeBlock`. Inline code (no fence) never reaches this override; it stays
 * a bare `<code>`, styled by the `[&_:not(pre)>code]` rules below. */
function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(codeText).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) return codeText(children.props.children);
  return "";
}

/** A cell with this much text or less holds a value: a name, a date, a
 * status. More than `PROSE_CELL_CHARS` is a sentence. */
const VALUE_CELL_CHARS = 12;
const PROSE_CELL_CHARS = 24;

/** Width rules for one table cell. A value stays on one line, so a name
 * like `member-1` does not break at its hyphen. A sentence keeps at least
 * 10rem, or 35% of a phone screen: without the floor, a table too wide to
 * fit squeezes each column to its longest word, and the sentence stacks one
 * word per line. Exported for tests. */
export function tableCellClass(children: ReactNode): string | undefined {
  const length = codeText(children).length;
  if (length <= VALUE_CELL_CHARS) return "whitespace-nowrap";
  if (length > PROSE_CELL_CHARS) return "min-w-[min(10rem,35vw)]";
  return undefined;
}

function languageFromClassName(className: unknown): string | undefined {
  if (typeof className !== "string") return undefined;
  return /language-(\S+)/.exec(className)?.[1];
}

/**
 * Opt-in memory cross-reference handling for `Markdown`.
 *
 * A memory document links to its siblings with relative paths
 * (`../people/alice.md`). Those are not web URLs, so the default
 * `target="_blank"` treatment sends the reader to a dead tab. Give the path
 * of the document being rendered and a navigate callback, and every link
 * that resolves to a memory path navigates in place instead.
 *
 * This is a prop rather than a change to the default because `Markdown`
 * also renders the chat transcript, where a relative-looking href is just a
 * link the model wrote and has no memory file behind it. Opting in per call
 * site keeps chat link behavior exactly as it was.
 *
 * `onNavigate` is a callback, not a router import, so `Markdown` and its
 * callers still render in tests without a `RouterProvider` — the same
 * convention `MemoryDoc` uses for `onNavigateToChat`/`onDeleted`.
 */
export interface MemoryLinkHandling {
  /** Path of the memory document that `children` came from. Relative link
   * targets resolve against its directory. */
  fromPath: string;
  onNavigate: (path: string) => void;
}

/** In-app path for a memory file. Segments are encoded one at a time so the
 * separators survive — the router's splat param holds the whole path.
 * Exported so other memory-link builders (the viewer dialog's "Open in
 * Memory") can't drift from the cross-reference links rendered here. */
export function memoryHref(path: string): string {
  return `/memory/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A download that `file_attach` created (`services/generated-files.ts`). */
const GENERATED_FILE_PATH = /^\/api\/sessions\/[^/]+\/threads\/[^/]+\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A generated download on this deployment's public origin, moved to the
 * hostname of this page. A deployment can serve the app on more than one
 * hostname, and `file_attach` links the public one. A sign-in belongs to one
 * hostname, so a person signed in on another one got a 401 from the link.
 * A link on any other origin keeps its href. Exported for tests. */
export function localDownloadHref(href: string | undefined, publicOrigin: string | null, origin = window.location.origin): string | undefined {
  if (!href || !publicOrigin || publicOrigin === origin) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.origin !== publicOrigin || url.search || url.hash) return href;
  return GENERATED_FILE_PATH.test(url.pathname) ? url.pathname : href;
}

/** True for a click the browser would handle as a plain same-tab
 * navigation. A modified click (new tab, new window, download) keeps the
 * browser's own behavior, which the real `href` on the anchor supports. */
function isPlainLeftClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * Markdown rendering for chat message text. Wraps `react-markdown` + GFM
 * (tables, strikethrough, task lists, autolinks) with our token-aware
 * styling. Code blocks/pre/inline-code/links are themed against `--bg`,
 * `--fg`, accent — not raw color values, so light/dark Just Works.
 *
 * No raw HTML is allowed (react-markdown's default), so this is safe to
 * render arbitrary assistant or user text.
 *
 * Pass `memoryLinks` to make cross-references between memory documents
 * navigate in place — see `MemoryLinkHandling`.
 */
export function Markdown({
  children,
  className,
  memoryLinks,
  wideTables = false,
}: {
  children: string;
  className?: string;
  memoryLinks?: MemoryLinkHandling;
  /** Let a table that needs more room grow past the text column, centered
   * on it, up to the width of the nearest `@container` box or 64rem. The
   * caller must give that container room on both sides of a centered
   * column; without a container, `cqw` falls back to the viewport. */
  wideTables?: boolean;
}) {
  const publicOrigin = usePublicOrigin();
  return (
    <div
      className={cn(
        // Base prose styles + dark mode invert. `max-w-none` so chat text
        // can use the full message column.
        "prose prose-sm prose-neutral dark:prose-invert min-w-0 max-w-none [overflow-wrap:anywhere] max-sm:text-base",
        // First/last whitespace tidy.
        "prose-p:leading-relaxed prose-p:my-2 first:prose-p:mt-0 last:prose-p:mb-0",
        // Headings — small bumps; chat shouldn't have giant h1s.
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-base prose-h2:text-base prose-h3:text-sm",
        // Inline code — pill style, no surrounding backticks. Scoped so
        // the pill styles don't also apply to `<code>` inside fenced blocks
        // (the inner code element there should be transparent + inherit).
        "[&_:not(pre)>code]:bg-neutral-100 dark:[&_:not(pre)>code]:bg-neutral-800",
        // Code inside a table cell keeps whole tokens (see the table below).
        "[&_:not(pre)>code]:text-ink [&_:not(pre)>code]:whitespace-pre-wrap [&_:not(pre):not(td):not(th)>code]:[overflow-wrap:anywhere]",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5",
        "[&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-normal",
        "prose-code:before:content-none prose-code:after:content-none",
        // Fenced code blocks render through `CodeBlock` (see the `pre`
        // component override below), which owns its own styling in
        // `styles/code-block.css` — no `prose-pre:*` utilities needed here.
        "[&_.code-block]:my-2",
        // Links — accent color; underline only on hover. Open in new tab.
        "prose-a:text-accent-600 dark:prose-a:text-accent-100",
        "prose-a:no-underline hover:prose-a:underline",
        // Lists — tighter than prose default for chat density.
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        // Tables — borderless prose default looks bad; border + zebra.
        "prose-table:my-2 prose-th:font-semibold",
        "prose-td:border-t prose-td:border-[--border] prose-td:py-1",
        // Blockquote — accent left bar.
        "prose-blockquote:border-l-2 prose-blockquote:border-neutral-300",
        "dark:prose-blockquote:border-neutral-700",
        "prose-blockquote:not-italic prose-blockquote:font-normal",
        "prose-blockquote:text-muted prose-blockquote:my-2",
        // hr — subtle separator.
        "prose-hr:border-[--border] prose-hr:my-3",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Columns size to their content and wrap at spaces: a column is
          // never narrower than its longest word, and only a word too long
          // for the width breaks. The box is as wide as the table wants,
          // from the text column up to its limit. A centering flex parent
          // spreads extra width equally to both sides. The box scrolls
          // only when the longest words of all columns do not fit.
          table: ({ children }) => (
            <div className="flex justify-center">
              <div
                className={cn(
                  "w-max min-w-full max-w-full shrink-0 overflow-x-auto overscroll-x-contain",
                  wideTables && "max-w-[min(100cqw,64rem)]",
                )}
                tabIndex={0}
                role="region"
                aria-label="Table"
              >
                <table className="w-full [overflow-wrap:break-word]">{children}</table>
              </div>
            </div>
          ),
          th: ({ node: _node, children, className, ...rest }) => (
            <th className={cn(className, tableCellClass(children))} {...rest}>{children}</th>
          ),
          td: ({ node: _node, children, className, ...rest }) => (
            <td className={cn(className, tableCellClass(children))} {...rest}>{children}</td>
          ),
          // External links open in a new tab and do not leak referrer.
          // Inside a memory document, a cross-reference to another memory
          // file navigates in place instead, and an in-page anchor stays in
          // this tab. The anchor keeps a real `href` in both cases, so
          // cmd-click, middle-click and the status bar all still work.
          a: ({ children, href, ...rest }) => {
            const target = memoryLinks && href ? resolveLinkTarget(memoryLinks.fromPath, href) : null;
            if (memoryLinks && target !== null) {
              const navigate = memoryLinks.onNavigate;
              return (
                <a
                  href={memoryHref(target)}
                  onClick={(e) => {
                    if (!isPlainLeftClick(e)) return;
                    e.preventDefault();
                    navigate(target);
                  }}
                  {...rest}
                >
                  {children}
                </a>
              );
            }
            if (memoryLinks && href?.startsWith("#")) {
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            }
            return (
              <a href={localDownloadHref(href, publicOrigin)} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          },
          // A fenced block always arrives as `pre > code`; `children` here
          // is that inner `code` element (react-markdown's default code
          // renderer output — not separately overridden), carrying the
          // fence's language on its className and the source as its text.
          pre: ({ children }) => {
            const codeEl = isValidElement<{ className?: string; children?: ReactNode }>(children)
              ? children
              : null;
            const source = codeText(codeEl?.props.children ?? children);
            const language = languageFromClassName(codeEl?.props.className);
            if (language?.toLowerCase() === "mermaid") {
              return <MermaidDiagram source={source.replace(/\n$/, "")} />;
            }
            return <CodeBlock code={source} language={language} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
