import { createFileRoute } from "@tanstack/react-router";
import { ArtifactEditor } from "~/components/artifact/artifact-editor";
import { usePageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/artifacts_/$id")({ component: ArtifactEditorPage });

function ArtifactEditorPage() {
  const { id } = Route.useParams();
  usePageTitle("Artifact editor");
  return <ArtifactEditor key={id} id={id} />;
}
