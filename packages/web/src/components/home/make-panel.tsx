import { Link } from "@tanstack/react-router";
import { BookOpen, Brain, FileText, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { ArtifactListItem, MemoryTreeEntry, SkillSummary, WorkflowDefinitionSummary } from "@valet/api/wire";
import { useArtifacts } from "~/api/artifacts";
import { useMemoryTree } from "~/api/memory";
import { useSkills } from "~/api/skills";
import { useWorkflows } from "~/api/workflows";
import { OwnerBadge } from "~/components/owner-badge";
import { Badge, ErrorRow, LoadingRow, WorkList, WorkRow, WorkSection } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { useListOwner } from "~/lib/use-list-owner";
import { OutputCards } from "./output-card";

/** Rows a section shows. Each section links to its full page for the rest. */
const ROWS = 5;
const FILES = 4;

/**
 * Make: what Valet made and what keeps working for the person. Files come
 * first, newest first, as cards to open and edit. Then the workflows that run
 * on their own, the skills Valet follows, and what it remembers. Each section
 * shows a few items and links to its full page. Presence and connected apps
 * close the list, because they decide what Valet watches and can use.
 */
export function MakePanel({ className }: { className?: string }) {
  return <div className={cn("space-y-7", className)}>
    <FilesSection />
    <WorkflowsSection />
    <SkillsSection />
    <MemorySection />
    <section aria-label="Setup">
      <WorkList>
        <WorkRow title={<Link to="/presence">Presence</Link>} detail="Routines, and the places Valet listens." />
        <WorkRow title={<Link to="/integrations">Connected apps</Link>} detail="The apps and accounts Valet can use." />
      </WorkList>
    </section>
  </div>;
}

function SeeAll({ to, children }: { to: "/artifacts" | "/workflows" | "/skills" | "/memory"; children: ReactNode }) {
  return <Link to={to} className="text-sm text-muted hover:text-ink hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{children}</Link>;
}

/** Files Valet published: the newest few, as the same cards a task shows. */
function FilesSection() {
  const q = useArtifacts(undefined, { mine: true });
  const files = newestFiles(q.data?.artifacts ?? []);
  return <WorkSection title="Files" icon={<FileText aria-hidden className="h-4 w-4 text-muted" />} bare
    actions={<SeeAll to="/artifacts">All files</SeeAll>}>
    {q.isPending ? <LoadingRow label="Loading files…" />
      : q.isError ? <ErrorRow>Could not load files. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></ErrorRow>
      : files.length === 0 ? <p className="text-sm text-muted">Docs, decks and reports Valet makes for you show here.</p>
      : <OutputCards outputs={files.map(file => ({ kind: "file" as const, title: file.title, href: `/a/${file.token}`, updatedAt: file.updatedAt }))} />}
  </WorkSection>;
}

export function newestFiles(artifacts: ArtifactListItem[]): ArtifactListItem[] {
  return artifacts.filter(a => !a.revoked).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, FILES);
}

function WorkflowsSection() {
  const q = useWorkflows();
  const rows = workflowsForMake(q.data?.workflows ?? []);
  return <WorkSection title="Workflows" icon={<Workflow aria-hidden className="h-4 w-4 text-muted" />} count={q.data?.workflows.length}
    actions={<SeeAll to="/workflows">All workflows</SeeAll>}>
    <Body query={q} what="workflows" empty="Ask Valet to do something on a schedule, or each time something happens." count={rows.length}>
      {rows.map(workflow => {
        const run = workflow.latestRun;
        return <WorkRow key={workflow.id}
          title={<Link to="/workflows/$workflowId" params={{ workflowId: workflow.id }}>{workflow.name}</Link>}
          badge={<><OwnerBadge ownerType={workflow.ownerType} ownerId={workflow.ownerId} /><RunBadge workflow={workflow} /></>}
          time={run?.createdAt}
          detail={run ? runDetail(workflow) : "No runs yet"} />;
      })}
    </Body>
  </WorkSection>;
}

/** Workflows that need the person or are running come first, then the most recently run. */
export function workflowsForMake(workflows: WorkflowDefinitionSummary[]): WorkflowDefinitionSummary[] {
  const rank = (w: WorkflowDefinitionSummary) => w.latestRun?.needsApproval ? 0 : w.latestRun && w.latestRun.status !== "settled" ? 1 : 2;
  const when = (w: WorkflowDefinitionSummary) => w.latestRun?.createdAt ?? w.updatedAt;
  return [...workflows].sort((a, b) => rank(a) - rank(b) || when(b) - when(a)).slice(0, ROWS);
}

function RunBadge({ workflow }: { workflow: WorkflowDefinitionSummary }) {
  const run = workflow.latestRun;
  if (!run) return null;
  if (run.needsApproval) return <Badge variant="warning">Needs approval</Badge>;
  if (run.status !== "settled") return <Badge variant="accent">Running</Badge>;
  if (run.outcome === "failed") return <Badge variant="danger">Failed</Badge>;
  return null;
}

function runDetail(workflow: WorkflowDefinitionSummary): string {
  const run = workflow.latestRun!;
  if (run.status !== "settled") return "Started";
  return run.outcome === "cancelled" ? "Cancelled" : run.outcome === "failed" ? "Last run failed" : "Last run finished";
}

/** The person's own skills and their teams': the plugin catalog is long and sorts first, so it stays on the Skills page. */
function SkillsSection() {
  const personal = useSkills({ scope: "personal", limit: ROWS });
  const team = useSkills({ scope: "team", limit: ROWS });
  const rows = [...(personal.data?.skills ?? []), ...(team.data?.skills ?? [])].slice(0, ROWS);
  const query = { isPending: personal.isPending || team.isPending, isError: personal.isError || team.isError,
    refetch: () => { void personal.refetch(); void team.refetch(); } };
  return <WorkSection title="Skills" icon={<BookOpen aria-hidden className="h-4 w-4 text-muted" />}
    actions={<SeeAll to="/skills">All skills</SeeAll>}>
    <Body query={query} what="skills" empty="Ask Valet to save a way of working as a skill, and it follows it next time." count={rows.length}>
      {rows.map(skill => <WorkRow key={skill.origin === "plugin" ? skill.name : skill.id}
        title={<SkillLink skill={skill} />}
        badge={skill.origin !== "plugin" && <OwnerBadge ownerType={skill.ownerType} ownerId={skill.ownerId} />}
        detail={skill.description && <span className="line-clamp-2">{skill.description}</span>} />)}
    </Body>
  </WorkSection>;
}

function SkillLink({ skill }: { skill: SkillSummary }) {
  return skill.origin === "plugin"
    ? <Link to="/skills/$skillName" params={{ skillName: skill.name }}>{skill.name}</Link>
    : <Link to="/skills/stored/$skillId" params={{ skillId: skill.id }}>{skill.name}</Link>;
}

function MemorySection() {
  const owner = useListOwner();
  const q = useMemoryTree(owner);
  const rows = recentMemory(q.data?.entries ?? []);
  return <WorkSection title="Memory" icon={<Brain aria-hidden className="h-4 w-4 text-muted" />}
    actions={<SeeAll to="/memory">All memory</SeeAll>}>
    <Body query={q} what="memory" empty="Valet saves what it learns about you and your work here." count={rows.length}>
      {rows.map(entry => <WorkRow key={entry.path}
        title={<Link to="/memory/$" params={{ _splat: entry.path }}>{entry.title || entry.path}</Link>}
        badge={entry.pinned && <Badge>Pinned</Badge>}
        time={entry.updatedAt}
        detail={entry.path} />)}
    </Body>
  </WorkSection>;
}

/** Pinned notes first, then the most recently changed. */
export function recentMemory(entries: MemoryTreeEntry[]): MemoryTreeEntry[] {
  return entries.filter(e => !e.dir).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, ROWS);
}

/** A row-list body: a loading row, an error row with Retry, an empty line, or the rows. */
function Body({ query, what, empty, count, children }: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  what: string; empty: string; count: number; children: ReactNode;
}) {
  if (query.isPending) return <div className="px-4 py-3"><LoadingRow label={`Loading ${what}…`} /></div>;
  if (query.isError) return <div className="px-4 py-3"><ErrorRow>Could not load {what}. <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></ErrorRow></div>;
  if (count === 0) return <p className="px-4 py-3 text-sm text-muted sm:pl-5">{empty}</p>;
  return <>{children}</>;
}
