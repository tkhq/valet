import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/security` layout shell. Thin — just an `<Outlet/>` boundary so the hub
 * (`security.index.tsx`) and any later child pages nest under one path
 * without the hub doubling as their parent (mirrors `workflows.tsx`).
 */
export const Route = createFileRoute("/security")({
  component: () => <Outlet />,
});
