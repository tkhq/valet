import { Bell } from "lucide-react";
import type { NotificationSummary } from "@valet/api/wire";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from "~/api/queries";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * Notifications bell for the top nav (Phase 4 decision 22). Polls
 * GET /api/notifications every 30s (see `useNotifications`), shows an
 * unread-count badge, and lists the 50 most recent in a dropdown. Clicking
 * an item marks it read and navigates to its `href` (a full-page nav —
 * simplest correct thing for a handful of cross-session links; no typed
 * router route exists for an arbitrary notification target).
 *
 * Assistant-centered web UI decision 18: also refetches on dropdown OPEN
 * (in addition to the 30s poll) so a dropdown left closed for a while
 * doesn't show stale unread state the moment it's opened.
 */

/**
 * Pure `onOpenChange` handler, extracted so the open-refetch behavior is
 * unit-testable without rendering the Radix dropdown (CLAUDE.md: prefer
 * pure functions over exercising private/DOM internals in tests).
 */
export function makeOpenChangeHandler(refetch: () => void): (open: boolean) => void {
  return (open) => {
    if (open) refetch();
  };
}

export function NotificationsBell() {
  const { data, refetch } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const items = data?.notifications ?? [];
  const unreadCount = items.filter((n) => !n.readAt).length;

  async function onSelectItem(n: NotificationSummary) {
    // Await the mark-read POST before navigating — `window.location.assign`
    // triggers a full-page nav in the same tick, which can cancel an
    // in-flight fetch before the browser sends it.
    try {
      if (!n.readAt) await markRead.mutateAsync(n.id);
    } finally {
      if (n.href) window.location.assign(n.href);
    }
  }

  return (
    <DropdownMenu onOpenChange={makeOpenChangeHandler(refetch)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative px-2"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unreadCount > 0 && (
            <Badge
              variant="accent"
              className="absolute -top-1 -right-1 min-w-[16px] justify-center px-1 py-0 text-[10px] leading-4"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[340px] max-h-[420px] overflow-y-auto">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>Notifications</span>
          {unreadCount > 0 && (
            <button
              type="button"
              className="text-xs font-normal text-muted hover:text-[--fg] hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                markAllRead.mutate();
              }}
            >
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 && (
          <div className="px-2 py-3 text-sm text-muted">No notifications yet.</div>
        )}
        {items.map((n) => (
          <DropdownMenuItem
            key={n.id}
            onSelect={() => onSelectItem(n)}
            className={cn("flex flex-col items-stretch gap-0.5", !n.readAt && "bg-accent-100/40 dark:bg-accent-700/10")}
          >
            <span className="flex items-center gap-1.5">
              {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-600" aria-hidden />}
              <span className="text-sm font-medium truncate">{n.title}</span>
            </span>
            <span className="text-xs text-muted">{relativeTime(n.createdAt)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
