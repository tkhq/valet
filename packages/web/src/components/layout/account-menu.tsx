import { Link } from "@tanstack/react-router";
import { Settings, ShieldCheck } from "lucide-react";
import { useChangelog } from "~/api/changelog";
import { pluginEnabledForCaller, useMe, useOrg } from "~/api/settings";
import {
  Avatar, AvatarFallback, AvatarImage, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, StatusDot,
} from "~/components/primitives";
import { useLastSeenCheckpoint } from "~/lib/changelog-read-state";

/**
 * The person's avatar at the top bar's right edge, on every screen size. It
 * opens Settings and the pages about the account: Usage, Valet Security when
 * the org enables it, and the Changelog. A dot on the avatar marks a release
 * the person has not read.
 */
export function AccountMenu() {
  const meQ = useMe();
  const orgQ = useOrg();
  const changelogQ = useChangelog();
  const seenCheckpoint = useLastSeenCheckpoint(meQ.data?.id);
  const newest = changelogQ.data?.manifest.checkpoints[0];
  const changelogUnread = !!meQ.data && !!newest && seenCheckpoint !== newest.id;
  const securityEnabled = pluginEnabledForCaller(orgQ.data, "security") === true;
  const me = meQ.data;
  const initial = (me?.name.trim() || me?.email || "?")[0]!.toUpperCase();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={changelogUnread ? "Account and settings, new releases" : "Account and settings"}
        className="relative ml-auto inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss max-md:min-h-11 max-md:min-w-11">
        <Avatar size="sm" className="h-7 w-7">
          {me?.avatarUrl && <AvatarImage src={me.avatarUrl} alt="" />}
          <AvatarFallback className="flex h-full w-full items-center justify-center text-xs font-medium text-ink">{initial}</AvatarFallback>
        </Avatar>
        {changelogUnread && <StatusDot tone="accent" size="sm" className="absolute right-0.5 top-0.5 ring-2 ring-paper max-md:right-2 max-md:top-2" />}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      {me && <DropdownMenuLabel className="font-normal">
        <span className="block truncate text-sm font-medium text-ink">{me.name || me.email}</span>
        {me.name && <span className="block truncate text-xs text-muted">{me.email}</span>}
      </DropdownMenuLabel>}
      {me && <DropdownMenuSeparator />}
      <DropdownMenuItem asChild><Link to="/settings"><Settings className="h-4 w-4" aria-hidden />Settings</Link></DropdownMenuItem>
      <DropdownMenuItem asChild><Link to="/usage">Usage</Link></DropdownMenuItem>
      {securityEnabled && <DropdownMenuItem asChild><Link to="/security"><ShieldCheck className="h-4 w-4" aria-hidden />Valet Security</Link></DropdownMenuItem>}
      <DropdownMenuItem asChild>
        <Link to="/changelog" className="justify-between">
          Changelog
          {changelogUnread && <StatusDot tone="accent" size="sm" label="New releases" />}
        </Link>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
