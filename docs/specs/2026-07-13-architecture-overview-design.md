# Architecture Overview Page Design

## Goal

Make the published Engineering > System internals > Architecture page a clear system overview rather than a collection of implementation-level diagrams and duplicated subsystem reference material.

## Problem

`docs/architecture.md` is the first page in the Engineering navigation, but it begins with a second, redundant "Architecture Deep Dive" heading and a detailed request sequence. The page then repeats material that is already covered by focused engineering pages for session lifecycle, sandbox lifecycle, runtime streaming, Runner/OpenCode, workflow execution, orchestration, plugins, policy, and auth.

This makes it difficult to understand Valet's major components, responsibility boundaries, and end-to-end flow before encountering low-level diagrams and data schemas.

## Design

Replace the current deep-dive reference with an overview that answers four questions in order:

1. What is Valet's system shape?
2. How does a message become agent work and return to a user?
3. Which layer owns each responsibility and state category?
4. Where should an engineer go for subsystem detail?

### System overview diagram

Add one Mermaid flowchart immediately after the introduction. It groups components into four boundaries:

- **Client surfaces:** the web app and channel integrations, such as Slack and Telegram.
- **Control plane:** Cloudflare Worker, the per-session SessionAgent Durable Object, EventBus, D1, and R2.
- **Execution plane:** the Modal backend and each isolated sandbox, including Runner, OpenCode, and workspace services.
- **Extension plane:** plugins and integrations invoked by the Worker, Runner, and workflows.

The diagram shows the principal paths only: inbound interaction to the Worker, session coordination through the SessionAgent, sandbox provisioning through Modal, the Runner's WebSocket bridge to OpenCode, streamed updates back to clients, and durable artifacts/state in D1 and R2. It does not attempt to enumerate every protocol, port, table, or plugin implementation.

### Page sections

The rewritten page will contain:

1. A concise introduction defining Valet as a control plane for isolated agent workspaces.
2. **System overview** with the component diagram and a brief reading guide.
3. **How work moves through Valet** with four numbered steps: receive, coordinate, execute, and stream/persist.
4. **Responsibility boundaries** with a table that assigns each layer its primary ownership.
5. **State and security boundaries** explaining durable state versus live session state, credential/token handling, and authenticated workspace access at a high level.
6. **Engineering deep dives** linking each existing subsystem page and explaining what it covers.

### Content removed from the overview

Remove the redundant detailed sequence diagrams, session state-machine and lifecycle descriptions, SessionAgent SQLite/message/protocol reference, sandbox port table, D1 entity relationship diagram and table inventory, and database design-pattern list. Those are more accurately documented in the focused pages alongside this page.

## Links and navigation

Keep `architecture` as the first page in `docs/docs.json`; no navigation changes are required. The page will explicitly link to all sibling Engineering system-internals pages, preserving discoverability after removing duplicated detail.

## Error handling and maintenance

The overview must avoid making undocumented precision claims such as exhaustive event-type counts, port lists, or table inventories. It should instead link readers to the subsystem page that owns each evolving contract. This reduces documentation drift and keeps the page stable as internal details change.

## Verification

- Run Mintlify's documentation validation if available in the repository.
- Confirm internal links point to pages listed in `docs/docs.json`.
- Build or preview the docs site when the local tooling supports it, confirming the Mermaid diagram renders without clipping or syntax errors.
- Run the repository's relevant static checks after the Markdown change.
