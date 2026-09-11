import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, memoryCopyConflict, type MemoryCopyRequest, type OwnerFilter } from "~/api/client";
import { useOrg, useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
import { ChevronDown } from "lucide-react";
import {
  Button, Input, ConfirmDialog, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "~/components/primitives";

/** Reset drafts and confirmations even when a parent reuses this component. */
export function MemoryTransfer({ path, owner }: { path: string; owner?: OwnerFilter }) {
  return <MemoryTransferForm key={JSON.stringify([owner?.ownerType, owner?.ownerId, path])} path={path} owner={owner} />;
}

function MemoryTransferForm({ path, owner }: { path: string; owner?: OwnerFilter }) {
  const virtual = /^team:([^/]+)\/(.+)$/.exec(path);
  const sourceTeam = owner?.ownerType === "team" ? owner.ownerId : virtual?.[1];
  const from = virtual?.[2] ?? path;
  const direction = sourceTeam ? "pull" : "push";
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [to, setTo] = useState(from);
  const pathInput = useRef<HTMLInputElement>(null);
  const [conflict, setConflict] = useState<{
    request: MemoryCopyRequest; version: string | null; changed: boolean;
  } | null>(null);
  const teamsQ = useTeams({ enabled: open && direction === "push" });
  const orgQ = useOrg({ enabled: open && direction === "push" });
  const queryClient = useQueryClient();
  const teams = teamsQ.data?.teams ?? [];
  const writable = teams.filter((team) => team.callerRole !== null &&
    (team.callerRole === "admin" || (orgQ.data?.id === team.orgId && orgQ.data.callerRole === "admin")));
  const ready = direction === "pull" || (!teamsQ.isPending && !orgQ.isPending && !teamsQ.isError && !orgQ.isError);
  const selectedTeam = sourceTeam ?? teamId;
  const mutation = useMutation({
    mutationFn: (request: MemoryCopyRequest) => api.copyMemoryFile(direction, request),
    onError: (error, request) => {
      const found = memoryCopyConflict(error);
      setConflict(found ? { request, ...found, changed: found.changed || request.replacement !== undefined } : null);
    },
    onSuccess: async () => {
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
  const selectedTeamName = teams.find((team) => team.id === teamId)?.name ?? "Choose a team";
  const label = direction === "pull" ? "Pull to personal memory" : "Push to a team";

  return (
    <section className="mt-8 border-t border-line pt-4 text-sm">
      <button type="button" className="text-moss hover:underline" aria-expanded={open}
        onClick={() => setOpen(!open)} disabled={mutation.isPending}>{label}</button>
      {open && (
        <form className="mt-3 space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (ready && selectedTeam && to.trim() && !mutation.isPending &&
              (direction === "pull" || writable.some((team) => team.id === selectedTeam))) mutation.mutate({ from, to: to.trim(), teamId: selectedTeam });
        }}>
          <p className="text-muted">The original stays unchanged. Later edits do not sync.</p>
          {direction === "push" && (
            <p className="text-muted">A team or organization admin can copy files into this team.</p>
          )}
          {direction === "push" && (
            <>
              {!ready && !teamsQ.isError && !orgQ.isError && <p role="status">Loading teams…</p>}
              {(teamsQ.isError || orgQ.isError) && <p role="alert">Could not load team access. <button type="button"
                className="underline" onClick={() => { void teamsQ.refetch(); void orgQ.refetch(); }}>Retry</button></p>}
              {ready && writable.length === 0 && <p>No teams available for copying.</p>}
              <div className="space-y-1">
                <p>Destination team</p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="secondary" size="sm"
                      aria-label={`Destination team: ${selectedTeamName}`}
                      disabled={!ready || mutation.isPending}>
                      {selectedTeamName}
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {teams.map((team) => (
                      <DropdownMenuItem key={team.id} disabled={!writable.some((t) => t.id === team.id)}
                        onSelect={() => { setTeamId(team.id); setConflict(null); mutation.reset(); }}>
                        {team.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
          <label className="block">Destination path
            <Input ref={pathInput} className="mt-1" value={to} required
              disabled={mutation.isPending} onChange={(event) => { setTo(event.target.value); setConflict(null); mutation.reset(); }} />
          </label>
          {mutation.error && !conflict && <p role="alert" className="text-danger-500">{errorText(mutation.error)}</p>}
          {mutation.isSuccess && <p role="status">Copied to {mutation.data.file.path} in {direction === "pull" ? "personal memory" : "team memory"}.</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!ready || !selectedTeam || !to.trim() || mutation.isPending || mutation.isSuccess ||
              (direction === "push" && !writable.some((team) => team.id === selectedTeam))}>
              {mutation.isPending ? "Copying…" : label}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={mutation.isPending}
              onClick={() => { setOpen(false); setConflict(null); mutation.reset(); }}>Cancel</Button>
          </div>
        </form>
      )}
      <ConfirmDialog open={conflict !== null}
        onOpenChange={(next) => { if (!next && !mutation.isPending) { setConflict(null); mutation.reset(); } }}
        title={conflict?.version === null ? "Destination no longer exists" : "Replace existing file?"}
        description={conflict
          ? `${conflict.request.to} ${conflict.version === null ? "no longer exists" : "already exists"} in ${direction === "pull" ? "personal memory" : `team ${selectedTeamName}`}. ${conflict.version === null ? "Copy" : "Replace it with"} ${conflict.request.from} from ${direction === "pull" ? "the selected team" : "personal memory"}? The source stays unchanged.`
          : ""}
        confirmLabel={conflict?.version === null ? "Copy" : "Replace"} pendingLabel="Copying…" pending={mutation.isPending}
        onConfirm={() => {
          if (conflict && !mutation.isPending) mutation.mutate({
            from: conflict.request.from, to: conflict.request.to, teamId: conflict.request.teamId,
            ...(conflict.version === null ? {} : { replacement: { expectedVersion: conflict.version } }),
          });
        }}>
        {conflict?.changed && <p role="alert">The destination changed since your confirmation. Choose again.</p>}
        <Button type="button" variant="secondary" disabled={mutation.isPending}
          onClick={() => {
            setConflict(null); mutation.reset();
            requestAnimationFrame(() => pathInput.current?.focus());
          }}>Choose another path</Button>
      </ConfirmDialog>
    </section>
  );
}
