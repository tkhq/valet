# @valet/web

The Valet web client. Vite + React 19 + Tailwind 3 + TanStack
Router/Query + Radix primitives.

This is **not** the legacy `packages/client` — that stays frozen for the
production Cloudflare deploy. This package targets `packages/api` and is
served by it in production (bundled into the single binary and the k8s
api image).

## Run it

```bash
make dev-local         # starts API + web together
# or just web (with the API already running):
pnpm --filter @valet/web dev
```

Open `http://localhost:5173`. Vite proxies `/api` (HTTP and WebSocket) to
the API on `:8788`. If your API is somewhere else:

```bash
VITE_API_URL=http://localhost:9000 pnpm --filter @valet/web dev
```

## Stack

- **Vite 6** for dev/build. The `@tanstack/router-plugin` generates
  `src/routeTree.gen.ts` from the file-based routes.
- **React 19**, **TanStack Router** (file-based), **TanStack Query** for
  REST.
- **Tailwind 3** with our own design tokens in `tailwind.config.ts` and
  CSS vars in `src/styles/globals.css`. Light/dark follows
  `prefers-color-scheme`.
- **Zustand** holds live per-session event state (`src/stores/stream.ts`).
- **Radix UI** primitives, wrapped intentionally in
  `src/components/primitives/` with our own variant/size APIs — *not*
  shadcn.
- **Lucide** icons.

## Layout

```
src/
├── routes/                # file-based: chat, sessions.$sessionId, memory,
│                          #   workflows, integrations, settings.*, login/signup
├── components/
│   ├── primitives/        # Button, Input, Dialog, … over Radix
│   ├── layout/            # app shell, nav, sidebar
│   ├── session/           # message list, composer, tool renderers (registry)
│   ├── settings/          # settings sections (models, providers, org, …)
│   ├── workflows/         # workflow editor + run views
│   ├── assistant/         # assistant identity
│   ├── integrations/      # integrations page
│   └── memory/            # memory tree browser
├── api/                   # typed fetch client (@valet/api/wire), query hooks, ws
├── stores/                # Zustand stores (stream, composer prefill)
└── lib/                   # helpers (cn, …)
```

Session **tool renderers** are a registry
(`src/components/session/tool-renderers/`): add a renderer file and list
it before the fallback in `index.ts`. The shell, status semantics, and
category color come from `ToolShell`.

## Wire types

Imported directly from the workspace:

```ts
import type { Message, WireEvent, SessionDetail } from "@valet/api/wire";
```

No build step — Vite resolves the source TypeScript through the workspace
package's `./wire` export.

## Design tokens

The single source of truth is `tailwind.config.ts`. Component code never
hard-codes hex values or magic spacing. It uses Tailwind class names that
map to the tokens: `colors.neutral.{50..950}` (OKLCH-tuned),
`colors.accent.*`, `colors.danger.*`, `colors.success.*`, the
`borderRadius` scale, and the `sans`/`mono` font stacks. CSS vars in
`globals.css` (`--bg`, `--fg`, `--border`, `--muted`) flip with the color
scheme so primitives theme without prop drilling.

## Showcase route

`/primitives` renders all primitives in isolation. Use it when you
iterate on tokens or component variants.
