/** `GET /api/notifications`: long titles and bodies, repeated titles that the
 * bell groups into one row with a count, read and unread rows. */
import type { ListNotificationsResponse, NotificationKind, NotificationSummary, NotificationUrgency } from "@valet/api/wire";
import { HEX_300, MINUTE, NOW, STRING_2000, TITLE_400, URL_300 } from "./common";
import { stressTitle } from "./approvals";

const KINDS: NotificationKind[] = ["notification", "question", "escalation", "review", "approval"];
const URGENCY: NotificationUrgency[] = ["low", "normal", "high"];

const BODIES = [
  STRING_2000,
  `Run failed at step ${HEX_300}. Logs: ${URL_300}`,
  `${TITLE_400}\n\nLine two of the body.\nLine three, with a list:\n- one\n- two\n- three`,
  undefined,
];

function notification(i: number): NotificationSummary {
  // Every fifth title repeats, so the bell shows one grouped row with a count.
  const title = i % 5 === 0 ? "Nightly dependency audit failed" : stressTitle(i);
  return {
    id: `notification-${i}`,
    kind: KINDS[i % KINDS.length]!,
    urgency: URGENCY[i % URGENCY.length]!,
    title,
    body: BODIES[i % BODIES.length],
    href: i % 3 === 0 ? undefined : `/presence/runs/run-${i}`,
    sessionId: i % 2 === 0 ? `session-${i}` : undefined,
    createdAt: NOW - i * 13 * MINUTE,
    readAt: i % 9 === 8 ? NOW - i * MINUTE : undefined,
  };
}

export const NOTIFICATION_COUNT = 60;

export const stressNotifications: ListNotificationsResponse = {
  notifications: Array.from({ length: NOTIFICATION_COUNT }, (_, i) => notification(i)),
};
