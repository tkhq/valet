import { ChevronDown } from "lucide-react";
import type { OrgMemberWire } from "@valet/api/wire";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from "~/components/primitives";
import { useSetOrgMemberRole } from "~/api/settings";

const SOLE_ADMIN_TOOLTIP = "an organization needs at least one admin";

function initials(name: string | null, email: string): string {
  const source = (name ?? email).trim();
  return source.slice(0, 1).toUpperCase() || "?";
}

function formatJoined(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Organization · Members roster (spec controls inventory). Role change per
 * row via a `DropdownMenu`, optimistic with rollback (`useSetOrgMemberRole`
 * in `~/api/settings`). The sole admin's control is disabled with the
 * spec-verbatim tooltip — the server's last-admin guard is authoritative,
 * this is a courtesy that avoids a round-trip error for the common case.
 */
export function MembersTable({ members }: { members: OrgMemberWire[] }) {
  const admins = members.filter((m) => m.role === "admin");
  const setRole = useSetOrgMemberRole();

  return (
    <div className="space-y-3">
      <div className="divide-y divide-line">
        {members.map((member) => {
          const isSoleAdmin = member.role === "admin" && admins.length === 1;
          return (
            <div
              key={member.userId}
              className="flex items-center gap-3 py-3 sm:gap-4"
            >
              <Avatar size="md">
                <AvatarFallback>{initials(member.name, member.email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  {member.name ?? member.email}
                </div>
                <div className="truncate text-xs text-muted">{member.email}</div>
              </div>
              <div className="hidden shrink-0 text-xs text-muted sm:block">
                Joined {formatJoined(member.joinedAt)}
              </div>
              <RoleControl
                role={member.role}
                disabled={isSoleAdmin}
                onSelect={(role) =>
                  setRole.mutate({ userId: member.userId, body: { role } })
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function roleLabel(role: "admin" | "operator" | "member"): string {
  if (role === "admin") return "Admin";
  if (role === "operator") return "Operator";
  return "Member";
}

function roleBadgeVariant(role: "admin" | "operator" | "member"): "accent" | "success" | "neutral" {
  if (role === "admin") return "accent";
  if (role === "operator") return "success";
  return "neutral";
}

function RoleControl({
  role,
  disabled,
  onSelect,
}: {
  role: "admin" | "operator" | "member";
  disabled: boolean;
  onSelect: (role: "admin" | "operator" | "member") => void;
}) {
  const trigger = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      className="gap-1.5"
    >
      <Badge variant={roleBadgeVariant(role)} className="pointer-events-none">
        {roleLabel(role)}
      </Badge>
      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );

  if (disabled) {
    return (
      <Tooltip content={SOLE_ADMIN_TOOLTIP}>
        <span>{trigger}</span>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onSelect("admin")}>Admin</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect("operator")}>Operator</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect("member")}>Member</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
