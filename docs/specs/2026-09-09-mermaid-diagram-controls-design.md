# Mermaid Diagram Controls Design

## Purpose

Markdown renders Mermaid fenced blocks in chat and memory documents. Large diagrams can occupy most of the transcript. Readers also need to inspect details without leaving the message.

## Design

`MermaidDiagram` keeps the existing Mermaid render and SVG data-image path. A rendered diagram appears in a compact card with a Mermaid header. The diagram is expanded by default. This preserves inline Mermaid rendering for existing Markdown users.

The header button collapses or expands the diagram. When expanded, the header shows zoom in, zoom out, and reset controls. The diagram viewport supports pointer drag to pan. The mouse wheel changes zoom. Zoom stays between 0.5x and 3x.

The viewport uses `max-h-96` (384 px) and hides overflow. This limit stops tall diagrams from dominating the transcript. The reader can pan and zoom to inspect clipped content. A non-passive native wheel listener prevents transcript scrolling while vertical wheel input zooms. Horizontal-only wheel input is unchanged. The listener is removed when the viewport unmounts.

The viewport uses `touch-none` so touch pointer drags pan the diagram instead of starting browser touch actions. Pointer cancellation clears the active drag. Keyboard users can focus the labeled viewport and use arrow keys to pan. Screen-reader instructions describe drag, wheel, and keyboard controls.

A new Mermaid source resets pan and zoom to the default view. A render failure continues to show the source and the existing corrective error message.

## Scope

This change applies to `packages/web/src/components/mermaid-diagram.tsx`. The Markdown renderer continues to route fenced `mermaid` blocks to this component. Artifact iframe rendering is out of scope because it uses its own runtime.

## Verification

Web component tests verify the default expanded state, collapse behavior, the maximum-height viewport contract, touch drag cancellation, keyboard panning, and wheel zoom behavior. The wheel tests verify scroll prevention for vertical input and no change for horizontal-only input. Existing Markdown tests verify source fallback and async source updates.
