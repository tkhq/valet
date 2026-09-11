import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type OwnerFilter } from "~/api/client";
import { useOrg, useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
import { ChevronDown } from "lucide-react";
import {
  Button, Input, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "~/components/primitives";

/** The parent keys this form by owner and path so navigation resets its draft. */
export function MemoryTransfer({ path, owner }: { path: string; owner?: OwnerFilter }) {
  const virtual = /^team:([^/]+)\/(.+)$/.exec(path);
  const sourceTeam = owner?.ownerType === "team" ? owner.ownerId : virtual?.[1];
  const from = virtual?.[2] ?? path;
  const direction = sourceTeam ? "pull" : "push";
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [to, setTo] = useState(from);
  const teamsQ = useTeams({ enabled: open && direction === "push" });
  const orgQ = useOrg({ enabled: open && direction === "push" });
  const queryClient = useQueryClient();
  const teams = teamsQ.data?.teams ?? [];
  const writable = teams.filter((team) => team.callerRole !== null &&
    (team.callerRole === "admin" || (orgQ.data?.id === team.orgId && orgQ.data.callerRole === "admin")));
  const ready = direction === "pull" || (!teamsQ.isPending && !orgQ.isPending && !teamsQ.isError && !orgQ.isError);
  const selectedTeam = sourceTeam ?? teamId;
  const mutation = useMutation({
    mutationFn: () => api.copyMemoryFile(direction, { from, to: to.trim(), teamId: selectedTeam }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["memory"] }); },
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
              (direction === "pull" || writable.some((team) => team.id === selectedTeam))) mutation.mutate();
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
                        onSelect={() => { setTeamId(team.id); mutation.reset(); }}>
                        {team.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
          <label className="block">Destination path
            <Input className="mt-1" value={to} required
              disabled={mutation.isPending} onChange={(event) => { setTo(event.target.value); mutation.reset(); }} />
          </label>
          {mutation.error && <p role="alert" className="text-danger-500">{errorText(mutation.error)}</p>}
          {mutation.isSuccess && <p role="status">Copied to {mutation.data.file.path} in {direction === "pull" ? "personal memory" : "team memory"}.</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!ready || !selectedTeam || !to.trim() || mutation.isPending || mutation.isSuccess ||
              (direction === "push" && !writable.some((team) => team.id === selectedTeam))}>
              {mutation.isPending ? "Copying…" : label}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={mutation.isPending}
              onClick={() => { setOpen(false); mutation.reset(); }}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}
