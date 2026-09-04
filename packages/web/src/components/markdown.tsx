import { isValidElement, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveLinkTarget } from "@valet/api/memory-links";
import { cn } from "~/lib/cn";
import { CodeBlock } from "./code-block";

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
}: {
  children: string;
  className?: string;
  memoryLinks?: MemoryLinkHandling;
}) {
  return (
    <div
      className={cn(
        // Base prose styles + dark mode invert. `max-w-none` so chat text
        // can use the full message column.
        "prose prose-sm prose-neutral dark:prose-invert max-w-none",
        // First/last whitespace tidy.
        "prose-p:leading-relaxed prose-p:my-2 first:prose-p:mt-0 last:prose-p:mb-0",
        // Headings — small bumps; chat shouldn't have giant h1s.
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-base prose-h2:text-base prose-h3:text-sm",
        // Inline code — pill style, no surrounding backticks. Scoped so
        // the pill styles don't also apply to `<code>` inside fenced blocks
        // (the inner code element there should be transparent + inherit).
        "[&_:not(pre)>code]:bg-neutral-100 dark:[&_:not(pre)>code]:bg-neutral-800",
        "[&_:not(pre)>code]:text-ink",
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
              <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
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
            return (
              <CodeBlock
                code={codeText(codeEl?.props.children ?? children)}
                language={languageFromClassName(codeEl?.props.className)}
              />
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
