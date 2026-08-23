import { createFileRoute } from "@tanstack/react-router";
import { useArtifact } from "~/api/artifacts";
import { ApiError } from "~/api/client";
import { Markdown } from "~/components/markdown";
import { Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";

/**
 * `/a/$token` — the shared-artifact reader (artifacts design). Public in
 * the same sense as `/login`: listed in the root layout's public set, so
 * it renders standalone with no signed-in chrome. The API decides who may
 * read: `public` artifacts serve anonymously (org opt-in), `org` ones 401
 * a signed-out caller — which the api client's central 401 handler turns
 * into a `/login` redirect on real-auth deployments.
 *
 * The body is a share-time snapshot. Memory cross-links inside it render
 * as plain markdown links that go nowhere useful for an external reader,
 * which is correct: no `memoryLinks` handling here, because the reader has
 * no memory access.
 */
export const Route = createFileRoute("/a/$token")({
  component: ArtifactPage,
});

function ArtifactPage() {
  const { token } = Route.useParams();
  const artifactQ = useArtifact(token);

  if (artifactQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (artifactQ.error) {
    const status = artifactQ.error instanceof ApiError ? artifactQ.error.status : undefined;
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="font-display text-xl text-ink">
            {status === 401 ? "This document needs a login." : "This link doesn't work anymore."}
          </h1>
          <p className="text-sm text-muted">
            {status === 401
              ? "It is shared with a Valet organization. Log in to view it."
              : "The share was revoked, or the link is wrong. Ask the person who sent it for a fresh one."}
          </p>
          {status === 401 && (
            <a
              href={`/login?next=${encodeURIComponent(`/a/${token}`)}`}
              className="inline-block text-sm text-moss hover:underline"
            >
              Go to login
            </a>
          )}
        </div>
      </div>
    );
  }

  const doc = artifactQ.data;
  if (!doc) return null;

  return (
    <div className="min-h-screen">
      <article className="mx-auto max-w-[70ch] px-6 py-12">
        <header className="mb-8 space-y-2 border-b border-line pb-6">
          <h1 className="font-display text-3xl leading-tight text-ink">{doc.title}</h1>
          <p className="text-xs text-muted">
            {doc.sharedBy ? `Shared by ${doc.sharedBy} · ` : "Shared "}
            via Valet · updated {relativeTime(doc.updatedAt)}
          </p>
        </header>
        <Markdown className="font-display text-[17px] prose-headings:font-display">{doc.content}</Markdown>
      </article>
    </div>
  );
}
