import { Badge } from "~/components/primitives";

/** Org role → Badge (label + color). Shared by members-table and
 * invites-panel so renaming a role or changing its color is one edit. */
export type OrgRoleLabel = "admin" | "operator" | "member";

const LABEL: Record<OrgRoleLabel, string> = {
  admin: "Admin",
  operator: "Operator",
  member: "Member",
};

const VARIANT: Record<OrgRoleLabel, "accent" | "success" | "neutral"> = {
  admin: "accent",
  operator: "success",
  member: "neutral",
};

export function RoleBadge({ role, className }: { role: OrgRoleLabel; className?: string }) {
  return (
    <Badge variant={VARIANT[role]} className={className}>
      {LABEL[role]}
    </Badge>
  );
}
