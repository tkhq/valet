import type { SessionSandboxImage } from "@valet/api/wire";
import { sourceHealthGuidance } from "@valet/shared";
import { Link } from "@tanstack/react-router";
import { Callout } from "~/components/primitives";

/** Spec 7.4 / 11.4: shown while `agent_sessions.image_fallback` is set. */
export function ImageFallbackBanner({ image, isOrgAdmin }: { image: SessionSandboxImage | undefined; isOrgAdmin: boolean }) {
  const fallback = image?.fallback;
  if (!fallback) return null;
  const repo = image.repoFullName ?? "repository";
  return (
    <Callout tone="warning" role="status" className="mx-4 my-2">
      <p>Running on the stock image. The <code>{repo}</code> image failed its compatibility check and is being rebuilt.</p>
      <p className="mt-1 text-muted">{sourceHealthGuidance(fallback.reason)}</p>
      {isOrgAdmin && (
        <Link className="mt-1 inline-block underline" to="/settings/organization/sandbox-images" search={{ source: fallback.sourceId }}>
          Manage images
        </Link>
      )}
    </Callout>
  );
}
