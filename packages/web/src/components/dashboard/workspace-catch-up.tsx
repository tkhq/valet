import type { OwnerFilter } from "~/api/client";
import { useMe } from "~/api/settings";
import { useListOwner } from "~/lib/use-list-owner";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { WorkspaceActivity } from "./workspace-activity";

export function WorkspaceCatchUp({ owner: explicitOwner }: { owner?: OwnerFilter }) {
  const selectedOwner = useListOwner();
  const me = useMe();
  const owner = explicitOwner ?? selectedOwner;
  if (me.error && (!owner || owner.ownerType === "user")) {
    return <ErrorRow>Could not load your workspace. Reload to try again.</ErrorRow>;
  }
  if (!owner) return <LoadingRow label="Loading work…" />;
  return <WorkspaceActivity owner={owner} />;
}
