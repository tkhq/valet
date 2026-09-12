import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
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
import { useLivePendingGates } from "~/hooks/use-live-pending-gates";
import { cn } from "~/lib/cn";
import { attentionSessionIds, isActionable } from "~/lib/use-attention-ping";
import { relativeTime } from "~/lib/relative-time";

const KIND_LABEL: Record<NotificationKind, string> = {
  notification: "Notification",
  question: "Question",
  escalation: "Escalation",
  approval: "Approval",
  review: "Review",
};

export interface BellState {
  unreadCount: number;
  needsAttention: boolean;
}

/** Derive bell state from the poll and the live gate store. */
export function deriveBellState(
  notifications: NotificationSummary[] | undefined,
  livePendingGates: Readonly<Record<string, boolean>>,
): BellState {
  const items = notifications ?? [];
  const hasUnscopedAction = items.some((n) => isActionable(n) && n.sessionId === undefined);
  return {
    unreadCount: items.filter((n) => n.readAt === undefined).length,
    needsAttention: hasUnscopedAction || attentionSessionIds(items, livePendingGates).size > 0,
  };
}

/** Keep actionable notifications above general updates without changing recency within either group. */
export function sortNotifications(notifications: readonly NotificationSummary[]): NotificationSummary[] {
  return [...notifications].sort((a, b) => Number(isActionable(b)) - Number(isActionable(a)));
}

/**
 * Pure `onOpenChange` handler, extracted so the open-refetch behavior is
 * unit-testable without rendering the Radix dropdown.
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
  const livePendingGates = useLivePendingGates();
  const { unreadCount, needsAttention } = deriveBellState(data?.notifications, livePendingGates);
  const items = sortNotifications(data?.notifications ?? []);
  const wasAttention = useRef(needsAttention);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (needsAttention && !wasAttention.current) setPulse(true);
    if (!needsAttention) setPulse(false);
    wasAttention.current = needsAttention;
  }, [needsAttention]);

  async function onSelectItem(n: NotificationSummary) {
    try {
      if (!n.readAt) await markRead.mutateAsync(n.id);
    } finally {
      if (n.href) window.location.assign(n.href);
    }
  }

  const ariaLabel = needsAttention
    ? unreadCount > 0
      ? `${unreadCount} unread notifications. A decision is required.`
      : "A decision is required."
    : unreadCount > 0
      ? `${unreadCount} unread notifications`
      : "Notifications";

  return (
    <DropdownMenu onOpenChange={makeOpenChangeHandler(refetch)}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="relative px-2" aria-label={ariaLabel}>
          <Bell
            className={cn(
              "h-4 w-4",
              needsAttention && "text-amber-700 dark:text-amber-300",
              pulse && "animate-[pulse_700ms_ease-out_1] motion-reduce:animate-none",
            )}
            aria-hidden
            onAnimationEnd={() => setPulse(false)}
          />
          {unreadCount > 0 && (
            <Badge
              variant={needsAttention ? "warning" : "accent"}
              className="absolute -top-1 -right-1 min-w-[16px] justify-center px-1 py-0 text-[10px] leading-4"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px] min-w-0 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
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
              <span className="min-w-0 flex-1 text-sm font-medium truncate">{n.title}</span>
              {isActionable(n) && <Badge variant="warning">{KIND_LABEL[n.kind]}</Badge>}
            </span>
            <span className="text-xs text-muted">{relativeTime(n.createdAt)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
