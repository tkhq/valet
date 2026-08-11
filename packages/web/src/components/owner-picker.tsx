import { Label } from "~/components/primitives";
import { useTeams } from "~/api/settings";

/** "" = the caller owns the resource; any other value is a teamId. */
export const OWNER_SELF = "";

/**
 * Owner select for create dialogs: the caller, or a team the caller is a
 * member of. Offers only teams with a non-null `callerRole` — org admins
 * see every org team in `useTeams()`, but the create routes require
 * membership, so a non-member team would 404 on submit. Renders nothing
 * when the caller has no eligible team.
 */
export function OwnerPicker({
  id,
  value,
  onChange,
  help,
}: {
  id: string;
  value: string;
  onChange: (teamId: string) => void;
  /** One sentence on what team ownership means for this resource. */
  help: string;
}) {
  const teams = useTeams();
  const eligible = (teams.data?.teams ?? []).filter((t) => t.callerRole !== null);
  if (eligible.length === 0) return null;

  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>Owner</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded border border-[--border] bg-[--bg] px-3 text-sm text-[--fg]"
      >
        <option value={OWNER_SELF}>You</option>
        {eligible.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted">{help}</p>
    </div>
  );
}
