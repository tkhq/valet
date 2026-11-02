import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HomeScreen, type HomeView } from "~/components/home/home-screen";
import { useMobileLayout } from "~/hooks/use-mobile-layout";
import { usePageTitle } from "~/lib/page-title";

/** Home is the person's one conversation with Valet across every workspace,
 * with Tasks and Make: `?view=tasks` or `?view=make` opens that tab. A phone
 * switches between them; a wider screen keeps the conversation in view with
 * Tasks or Make beside it. The workspace dashboard is at `/overview`. */
export const Route = createFileRoute("/")({
  validateSearch: (raw: Record<string, unknown>): { view?: "tasks" | "make" } =>
    (raw.view === "tasks" || raw.view === "make" ? { view: raw.view } : {}),
  component: Home,
});

export function Home() {
  const wide = !useMobileLayout();
  const { view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  usePageTitle("Valet");
  return <HomeScreen view={view ?? "chat"} wide={wide}
    onViewChange={(next: HomeView) => void navigate({ search: next === "chat" ? {} : { view: next }, replace: true })} />;
}
