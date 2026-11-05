import { Link } from "@tanstack/react-router";
import { FileText, GitMerge, GitPullRequest } from "lucide-react";
import type { HomeTaskOutput } from "@valet/api/wire";
import { Time } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Something a task made, as a small card: a shared file or a pull request,
 * with when it last changed ("Updated 5:48 AM"). A file opens its share
 * page; a pull request opens on GitHub.
 */
export function OutputCard({ output, className }: { output: HomeTaskOutput; className?: string }) {
  const Icon = output.kind === "file" ? FileText : output.state === "merged" ? GitMerge : GitPullRequest;
  const body = <>
    <Icon aria-hidden className={cn("h-4 w-4 shrink-0", output.state === "merged" ? "text-moss" : "text-muted")} />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium text-ink">{output.title}</span>
      <span className="block text-xs text-muted">
        {output.kind === "pull_request" && output.state ? `${output.state[0]!.toUpperCase()}${output.state.slice(1)} · ` : ""}Updated <Time ts={output.updatedAt} />
      </span>
    </span>
  </>;
  const classes = cn("flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-paper px-3 py-2 hover:bg-ink-wash max-sm:min-h-11", className);
  return output.kind === "file"
    ? <Link to="/a/$token" params={{ token: output.href.replace(/^\/a\//, "") }} className={classes}>{body}</Link>
    : <a href={output.href} target="_blank" rel="noreferrer" className={classes}>{body}</a>;
}

/** Up to three outputs in a wrapping row. */
export function OutputCards({ outputs, className }: { outputs?: HomeTaskOutput[]; className?: string }) {
  if (!outputs?.length) return null;
  return <div className={cn("grid min-w-0 gap-2 sm:grid-cols-2", className)}>
    {outputs.map(output => <OutputCard key={output.href} output={output} />)}
  </div>;
}
