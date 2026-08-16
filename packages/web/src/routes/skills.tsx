import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/skills` layout shell. Thin — just an `<Outlet/>` boundary so `/skills`
 * (the catalog, `skills.index.tsx`) and `/skills/$skillName` (one skill's
 * body, `skills.$skillName.tsx`) both nest under it without either page
 * doubling as the other's parent (mirrors
 * `workflows.tsx`/`workflows.index.tsx`).
 */
export const Route = createFileRoute("/skills")({
  component: () => <Outlet />,
});
