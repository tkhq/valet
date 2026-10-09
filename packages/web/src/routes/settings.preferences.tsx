import { createFileRoute } from "@tanstack/react-router";
import { AppearancePage } from "./settings.appearance";
import { ThreadDefaultsPage } from "./settings.threads";

/** `/settings/preferences` — how Valet looks and the defaults for new
 * threads, on one page (settings-redesign spec, decision 2). */
export const Route = createFileRoute("/settings/preferences")({
  component: PreferencesPage,
});

export function PreferencesPage() {
  return (
    <div className="space-y-10">
      <AppearancePage />
      <ThreadDefaultsPage />
    </div>
  );
}
