import { createFileRoute } from "@tanstack/react-router";
import {
  ActionLogSection,
  parseActionLogSearch,
  type ActionLogSearch,
} from "~/components/settings/action-log-section";

/**
 * `/settings/organization/action-log` — Organization · Action log
 * (action-policies plan, Task 5). Renders inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-page admin re-check.
 *
 * The filters live in the search params, so a filtered view survives a
 * reload and can be sent to another admin. The pager keeps its cursors in
 * memory: they are opaque keyset cursors and the pager is forward-only, so a
 * shared link always opens at page one of the filtered set.
 */
export const Route = createFileRoute("/settings/organization/action-log")({
  validateSearch: (search: Record<string, unknown>): ActionLogSearch =>
    parseActionLogSearch(search),
  component: OrganizationActionLogPage,
});

export function OrganizationActionLogPage() {
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ActionLogSection
      filters={filters}
      onFiltersChange={(next) => void navigate({ search: () => next })}
    />
  );
}
