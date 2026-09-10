# Tool-card text wrapping

Date: 2026-09-10
Status: implemented
Packages: `web` (`packages/web/src/components/session/tool-renderers/`)

## Why

Text-file tool cards showed each file line with `white-space: pre` and a
horizontal scroll container. Long prose and unbroken text extended past the
visible card. A user had to scroll horizontally to read the output.

## Contract

The text-file renderers use `white-space: pre-wrap` and `overflow-wrap:
break-word` through Tailwind's `whitespace-pre-wrap` and `break-words`
utilities.

- Newline and repeated whitespace stay visible.
- Ordinary prose wraps at normal word boundaries.
- A long unbroken token, such as a URL, wraps when it reaches the card edge.
- Read line numbers and add, remove, and context diff indicators stay fixed at
  the start of their source line.
- Text-file output does not add a horizontal scroll container.

## Scope

The contract applies to the shared paths for file output:

- `TruncatedText` with `wrap` for `read` output.
- `DiffAdditions` for `write` output.
- `DiffView` and `DiffLine` for `edit` output and related text diffs.

`TruncatedText` keeps `whitespace-pre overflow-x-auto` by default. Shell,
security, media, and markdown-source renderers use that default and are not
part of this contract.
