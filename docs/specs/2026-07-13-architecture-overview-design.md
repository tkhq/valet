# Architecture Overview Page Design

## Goal

Make the published Engineering > System internals > Architecture page a clear system overview rather than a collection of implementation-level diagrams and duplicated subsystem reference material.

## Problem

`docs/architecture.mdx` is the first page in the Engineering navigation, but it previously began with a second, redundant "Architecture Deep Dive" heading and a detailed request sequence. The page then repeated material that is already covered by focused engineering pages for session lifecycle, sandbox lifecycle, runtime streaming, Runner/OpenCode, workflow execution, orchestration, plugins, policy, and auth.

This makes it difficult to understand Valet's major components, responsibility boundaries, and end-to-end flow before encountering low-level diagrams and data schemas.

## Design

Replace the current deep-dive reference with an overview that answers four questions in order:

1. What is Valet's system shape?
2. How does a message become agent work and return to a user?
3. Which layer owns each responsibility and state category?
4. Where should an engineer go for subsystem detail?

### System overview map

Replace the Mermaid topology with a responsive MDX system map immediately after the introduction. It presents the reader's path as three clear stages:

1. **Start work:** web app, Slack, Telegram, and workflows originate a request.
2. **Coordinate:** the Worker and per-session `SessionAgentDO` authenticate, route, queue, coordinate live state, and sync durable records.
3. **Execute:** the Modal sandbox runs Runner, OpenCode, and local developer tools.

A return band makes the final handoff explicit: structured messages, progress, approvals, and artifacts stream back through the session coordinator to the source of the work. The map intentionally omits the full component topology; its job is to give a new Engineering reader a reliable mental model before they choose a detailed reference.

### Page sections

The rewritten page will contain:

1. A concise introduction defining Valet as a control plane for isolated agent workspaces.
2. **System overview** with the MDX system map and a brief reading guide.
3. **Follow the concern you are changing** with the three most common next references: session lifecycle, sandbox lifecycle, and real-time streaming.
4. **Boundaries that keep the system legible** using focused cards for live coordination, durable state and access, sandboxed execution, and controlled extension.
5. **Continue by question** using wayfinding cards for workflows, orchestration, plugins, integration policy, and auth.

### Content removed from the overview

Remove the redundant detailed sequence diagrams, session state-machine and lifecycle descriptions, SessionAgent SQLite/message/protocol reference, sandbox port table, D1 entity relationship diagram and table inventory, and database design-pattern list. Those are more accurately documented in the focused pages alongside this page. Do not replace them with another dense topology diagram; use links and progressive disclosure instead.

## Links and navigation

Keep `architecture` as the first page in `docs/docs.json`; no navigation changes are required. The page will explicitly link to all sibling Engineering system-internals pages, preserving discoverability after removing duplicated detail.

## Error handling and maintenance

The overview must avoid making undocumented precision claims such as exhaustive event-type counts, port lists, or table inventories. It should instead link readers to the subsystem page that owns each evolving contract. This reduces documentation drift and keeps the page stable as internal details change.

## Verification

- Run Mintlify's documentation validation if available in the repository.
- Confirm internal links point to pages listed in `docs/docs.json`.
- Build or preview the docs site when the local tooling supports it, confirming the responsive MDX system map is readable on desktop and narrow layouts.
- Run the repository's relevant static checks after the Markdown change.
