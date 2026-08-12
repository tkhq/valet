import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
 * Markdown rendering for chat message text. Wraps `react-markdown` + GFM
 * (tables, strikethrough, task lists, autolinks) with our token-aware
 * styling. Code blocks/pre/inline-code/links are themed against `--bg`,
 * `--fg`, accent — not raw color values, so light/dark Just Works.
 *
 * No raw HTML is allowed (react-markdown's default), so this is safe to
 * render arbitrary assistant or user text.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
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
          // Force external links to open in a new tab and not leak referrer.
          a: ({ children, href, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
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
