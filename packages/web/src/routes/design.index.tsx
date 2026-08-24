import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Contact,
  File,
  FileText,
  LayoutTemplate,
  Mail,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import type { SessionSummary } from "@valet/api/wire";
import { useCreateSession } from "~/api/queries";
import { useDesignSessions } from "~/api/design";
import { useListOwner } from "~/lib/use-list-owner";
import { Button, EmptyRow, ErrorRow, Input, LoadingRow } from "~/components/primitives";
import { DEFAULT_WORKSPACE } from "~/components/new-session-dialog";
import { WorkspaceClause } from "~/components/workspace-clause";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * `/design` — the project hub (Valet Design spec §Web Surfaces): prompt
 * input, template gallery, recent designs. Creating from here mints a
 * `kind="design"` session (the server seeds revision r-001 from the
 * template starter) and lands on the canvas.
 */
export const Route = createFileRoute("/design/")({
  component: DesignHubPage,
});

interface TemplateCard {
  id: string;
  name: string;
  Icon: LucideIcon;
  description: string;
}

/** The six v1 templates (spec Decision 7). Ids match the server's list. */
const TEMPLATES: TemplateCard[] = [
  { id: "blank", name: "Blank", Icon: File, description: "An empty page. Start from nothing." },
  { id: "document", name: "Document", Icon: FileText, description: "A one-page document or landing page." },
  { id: "slides", name: "Slides", Icon: Presentation, description: "A slide deck with speaker notes." },
  { id: "wireframe", name: "Wireframe", Icon: LayoutTemplate, description: "Low-fidelity screens and layout blocks." },
  { id: "resume", name: "Résumé", Icon: Contact, description: "A structured one-page résumé." },
  { id: "html-email", name: "HTML email", Icon: Mail, description: "An email layout that renders in mail clients." },
];

function DesignHubPage() {
  const navigate = useNavigate();
  const create = useCreateSession();
  const scope = useWorkspaceScope();
  const owner = useListOwner();
  const recentQ = useDesignSessions(owner);
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string>("document");

  const recents = [...(recentQ.data?.sessions ?? [])].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );

  async function createDesign(template: string) {
    if (create.isPending) return;
    // A prompt is required: a session created without one starts an agent
    // with no brief, and the seeded template alone is not a design.
    const trimmed = prompt.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({
        // Same working-directory default as the new-session dialog.
        workspace: DEFAULT_WORKSPACE,
        kind: "design",
        template,
        initialPrompt: trimmed,
        ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
      });
      void navigate({
        to: "/sessions/$sessionId/design",
        params: { sessionId: created.id },
      });
    } catch {
      // useMutation surfaces the error in `create.error`; the page shows it.
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8 space-y-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Design</h1>
          <WorkspaceClause />
        </div>

        {/* Prompt — submits against the selected template. */}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void createDesign(selected);
          }}
        >
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should we create?"
            aria-label="What should we create?"
            autoFocus
            className="flex-1"
          />
          <Button type="submit" disabled={create.isPending || prompt.trim() === ""}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </form>

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {create.error.message}
          </div>
        )}

        {/* Template gallery — a card click only SELECTS the template.
            Create (above) is the single creation path, and it requires a
            prompt: card-click-creates shipped once and minted briefless
            sessions before the user finished typing. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Template">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected === t.id}
              disabled={create.isPending}
              onClick={() => setSelected(t.id)}
              className={cn(
                "flex flex-col items-start gap-2 rounded border bg-paper p-4 text-left hover:bg-ink-wash disabled:opacity-60",
                selected === t.id ? "border-moss bg-moss-wash/30" : "border-line",
              )}
            >
              <t.Icon className="h-5 w-5 text-moss" aria-hidden />
              <span className="text-sm font-medium text-ink">{t.name}</span>
              <span className="text-xs text-muted">{t.description}</span>
            </button>
          ))}
        </div>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">Recent designs</h2>
          {recentQ.isLoading && <LoadingRow label="Loading designs…" className="py-0" />}
          {!recentQ.isLoading && recentQ.error && (
            <ErrorRow className="flex items-center gap-3 py-0">
              <span>The designs did not load. Select Retry.</span>
              <Button size="sm" variant="secondary" onClick={() => void recentQ.refetch()}>
                Retry
              </Button>
            </ErrorRow>
          )}
          {!recentQ.isLoading && !recentQ.error && recents.length === 0 && (
            <EmptyRow className="py-0">
              No designs yet. Describe what to create above, pick a template, and select Create.
            </EmptyRow>
          )}
          {recents.length > 0 && (
            <ul className="space-y-2">
              {recents.map((s) => (
                <RecentDesignRow key={s.id} session={s} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function RecentDesignRow({ session }: { session: SessionSummary }) {
  return (
    <li>
      <Link
        to="/sessions/$sessionId/design"
        params={{ sessionId: session.id }}
        className="flex items-center gap-3 rounded border border-line bg-paper px-4 py-3 hover:bg-ink-wash"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {session.title || "Untitled design"}
        </span>
        {session.template && (
          <span className="shrink-0 rounded bg-ink-wash px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
            {session.template}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted">
          {relativeTime(session.lastActivityAt)}
        </span>
      </Link>
    </li>
  );
}
