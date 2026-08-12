import { memo } from "react";
import PrismLight, { type PrismGrammar } from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { CopyButton } from "./session/tool-renderers/tool-shell";

/**
 * The one shared syntax-highlighted code display. Consolidates what used to
 * be four independent ad-hoc `<pre>` treatments (markdown fences, `bash.tsx`
 * command lines, `fallback.tsx` JSON dumps, `tool-shell.tsx`'s
 * `TruncatedText`) so a code block reads identically wherever it appears.
 *
 * Registers only the languages this product actually renders (shell
 * commands, TS/JS/TSX/JSX, JSON, diffs, YAML, SQL, Markdown, Python) rather
 * than `react-syntax-highlighter`'s full ~290-language bundle — keeps the
 * chunk this adds to a few KB instead of several hundred.
 *
 * No prebuilt Prism theme: those ship fixed hex colors that ignore
 * light/dark and the app's own token system. Token coloring instead lives
 * in `styles/code-block.css` as CSS custom properties alongside every other
 * themed color in the app (see `theme.css`) — same discipline, one place
 * light/dark both resolve from.
 */
const LANGUAGES: Record<string, PrismGrammar> = {
  bash,
  sh: bash,
  shell: bash,
  javascript,
  js: javascript,
  jsx,
  typescript,
  ts: typescript,
  tsx,
  json,
  diff,
  yaml,
  yml: yaml,
  sql,
  markdown,
  md: markdown,
  python,
  py: python,
};
for (const [name, def] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, def);
}

export interface CodeBlockProps {
  code: string;
  /** Prism language id (e.g. "typescript", "bash"). Falls back to plain
   * (unhighlighted, still monospaced) text for an unregistered language. */
  language?: string;
  className?: string;
}

export const CodeBlock = memo(function CodeBlock({ code, language, className }: CodeBlockProps) {
  const text = code.replace(/\n$/, "");
  const known = language !== undefined && language in LANGUAGES;

  return (
    <div className={`code-block group/code relative ${className ?? ""}`}>
      <CopyButton
        getText={() => text}
        label="Copy code"
        className="absolute right-1.5 top-1.5 z-10 bg-[--bg] opacity-0 group-hover/code:opacity-100"
      />
      {known ? (
        // No `style` map — token coloring comes from `styles/code-block.css`
        // targeting the `.token.*` classNames Prism emits, not inline
        // per-token styles (which is what `style` would otherwise drive).
        <PrismLight language={language} style={{}} useInlineStyles={false} PreTag="pre" CodeTag="code">
          {text}
        </PrismLight>
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
});
