import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import type { ChangelogCategory } from "@valet/api/wire";
import { useChangelog } from "~/api/changelog";
import { useMe } from "~/api/settings";
import { Badge, Spinner } from "~/components/primitives";
import {
  lastSeenCheckpoint,
  markChangelogSeen,
  unreadCheckpointIds,
} from "~/lib/changelog-read-state";

export const Route = createFileRoute("/changelog")({ component: ChangelogPage });

const CATEGORY: Record<ChangelogCategory, { label: string; variant: "accent" | "neutral" | "success" | "warning" }> = {
  feature: { label: "Feature", variant: "accent" },
  improvement: { label: "Improvement", variant: "neutral" },
  fix: { label: "Fix", variant: "success" },
  security: { label: "Security", variant: "warning" },
};

function releaseDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function buildDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ChangelogPage() {
  const changelog = useChangelog();
  const me = useMe();
  const checkpoints = changelog.data?.manifest.checkpoints ?? [];
  const [seenWhenOpened, setSeenWhenOpened] = useState<string | null>();
  const unread = seenWhenOpened === undefined
    ? new Set<string>()
    : unreadCheckpointIds(checkpoints, seenWhenOpened);
  const newestId = checkpoints[0]?.id;

  useEffect(() => {
    if (!me.data || !newestId || seenWhenOpened !== undefined) return;
    setSeenWhenOpened(lastSeenCheckpoint(me.data.id));
    markChangelogSeen(me.data.id, newestId);
  }, [me.data, newestId, seenWhenOpened]);

  if (changelog.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading changelog…
      </div>
    );
  }
  if (changelog.isError) {
    return (
      <div className="flex-1 p-8 text-sm text-danger-500">
        Could not load the changelog. Reload the page to try again.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Changelog</h1>
        <p className="mt-2 text-sm text-muted">Changes in rolling builds and released versions.</p>

        {changelog.data.artifact.status === "latest-known" && (
          <div className="mt-6 rounded border border-line bg-ink-wash px-3 py-2 text-sm text-muted">
            This build has no release checkpoint. The latest known checkpoint is shown.
          </div>
        )}

        {checkpoints.length === 0 ? (
          <p className="mt-10 text-sm text-muted">No release checkpoints are available for this build.</p>
        ) : (
          <div className="mt-10 space-y-12">
            {checkpoints.map((checkpoint) => {
              const unreleased = checkpoint.kind === "unreleased";
              const checkpointSha = unreleased ? checkpoint.buildSha : checkpoint.releasedSha;
              const checkpointUrl = unreleased ? checkpoint.buildUrl : checkpoint.releaseUrl;
              return (
                <section key={checkpoint.id} aria-labelledby={`release-${checkpoint.id}`}>
                  <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
                    <h2 id={`release-${checkpoint.id}`} className="font-display text-xl text-ink">
                      {unreleased ? "Unreleased" : checkpoint.version}
                    </h2>
                    <span className="text-sm text-muted">
                      {unreleased ? buildDate(checkpoint.builtAt) : releaseDate(checkpoint.releasedAt)}
                    </span>
                    {unread.has(checkpoint.id) && <Badge variant="accent">New</Badge>}
                    {checkpointUrl && (
                      <a
                        href={checkpointUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-xs text-moss hover:underline"
                      >
                        {unreleased ? "Build" : "Release"} <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                  </div>

                  {unreleased && (
                    <a
                      href={`https://github.com/tkhq/valet/commit/${checkpointSha}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-block font-mono text-xs text-muted hover:text-moss hover:underline"
                    >
                      Build {checkpointSha.slice(0, 9)}
                    </a>
                  )}

                  {checkpoint.entries.length === 0 ? (
                    <p className="py-5 text-sm text-muted">
                      {unreleased
                        ? "No user-facing changes are pending in this build."
                        : "No user-facing changes shipped in this release."}
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {checkpoint.entries.map((entry) => {
                        const category = CATEGORY[entry.category];
                        const commit = entry.sources.commitSha;
                        return (
                          <li key={`${checkpoint.id}-${commit}`} className="py-5">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-medium text-ink">{entry.title}</h3>
                              <Badge variant={category.variant}>{category.label}</Badge>
                            </div>
                            <p className="mt-1 text-sm leading-6 text-muted">{entry.description}</p>
                            <div className="mt-2 flex gap-3 text-xs text-muted">
                              {entry.sources.pullRequest && (
                                <a
                                  href={`https://github.com/tkhq/valet/pull/${entry.sources.pullRequest}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:text-moss hover:underline"
                                >
                                  PR #{entry.sources.pullRequest}
                                </a>
                              )}
                              <a
                                href={`https://github.com/tkhq/valet/commit/${commit}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono hover:text-moss hover:underline"
                              >
                                {commit.slice(0, 9)}
                              </a>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
