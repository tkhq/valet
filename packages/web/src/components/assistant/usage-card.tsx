import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { UsageMemberSummary, UsageWindow } from "@valet/api/wire";
import { api } from "~/api/client";
import { useMe } from "~/api/settings";
import { Spinner } from "~/components/primitives";
import { formatTokens, formatUsd } from "~/lib/format-usage";
import { cn } from "~/lib/cn";

/**
 * Dashboard usage card — replaces the old session list ("Your work"),
 * which duplicated /sessions without adding signal. Shows what the user
 * actually asks about: spend. Personal windows (today / 7d / 30d) always;
 * the org comparison renders ONLY when the server includes it (the
 * `features.organizations` flag — single-user mode never sees it).
 */
export function UsageCard() {
  const me = useMe();
  const usageQ = useQuery({
    queryKey: ["usage", "summary"],
    queryFn: () => api.getUsageSummary(),
    refetchInterval: 60_000,
  });

  const data = usageQ.data;
  // Rank only after the viewer's identity settles (loaded or errored).
  // Ranking while /api/me is still in flight would paint the list without
  // the "You" row, then append it and shift the layout when the id lands.
  const org = data?.org && !me.isPending ? topMembers(data.org.members, me.data?.id) : null;
  const maxMemberCost = Math.max(0, ...(org?.shown.map((m) => m.costUsd) ?? []));

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">Usage</h2>
        <Link
          to="/usage"
          className="text-xs text-moss hover:underline underline-offset-2"
        >
          View all usage →
        </Link>
      </header>

      <div className="px-4 py-3 space-y-3">
        {usageQ.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {usageQ.error && (
          <div className="text-xs text-danger-500">
            Couldn't load usage.{" "}
            <button type="button" className="underline" onClick={() => usageQ.refetch()}>
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <WindowStat label="Today" window={data.me.day} />
              <WindowStat label="7 days" window={data.me.week} />
              <WindowStat label="30 days" window={data.me.month} />
            </div>

            {org && org.shown.length > 1 && (
              <div className="pt-1 space-y-1.5">
                {/* These rows rank `data.org.members` — the whole org
                    roster, never a team's — capped at the top spenders,
                    with the viewer always included (see topMembers).
                    "Team" now names a real, narrower thing in this
                    product, so calling this that would misreport whose
                    spend is on screen. */}
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Organization
                </div>
                {org.shown.map((m) => (
                  <MemberBar
                    key={m.userId}
                    member={m}
                    max={maxMemberCost}
                    isMe={m.userId === me.data?.id}
                  />
                ))}
                {org.hidden > 0 && (
                  <div className="text-[10px] text-muted">+ {org.hidden} more</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Max org rows the card shows. Past this depth the list pushes the card
 * far below the fold and the tail bars flatten into noise.
 */
export const ORG_MEMBER_CAP = 15;

/**
 * Top spenders for the org list, capped at ORG_MEMBER_CAP. Re-sorts with
 * the API's own comparator (cost desc, then tokens — the other copy lives
 * in packages/api/src/routes/usage.ts; keep them in sync) instead of
 * trusting wire order, so the cap always drops the cheapest rows.
 *
 * When meId is known the viewer is always on the list: a viewer ranked
 * below the cap is appended as one extra row, and a viewer with no spend
 * at all gets a synthesized $0 row — the API aggregates only users with
 * usage rows, so a zero-spend viewer is absent from `members` entirely.
 * Exported pure function so the behavior is testable without rendering
 * React.
 */
export function topMembers(
  members: UsageMemberSummary[],
  meId?: string,
): {
  shown: UsageMemberSummary[];
  hidden: number;
} {
  const sorted = [...members].sort(
    (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
  );
  const meIdx = meId === undefined ? -1 : sorted.findIndex((m) => m.userId === meId);
  const shown = sorted.slice(0, ORG_MEMBER_CAP);
  if (meIdx >= ORG_MEMBER_CAP) shown.push(sorted[meIdx]);
  // `hidden` counts real members only, so it is fixed before the
  // synthetic $0 row (which hides nobody) is appended.
  const hidden = members.length - shown.length;
  if (meId !== undefined && meIdx === -1) {
    shown.push({
      userId: meId,
      name: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
      unpricedTurns: 0,
    });
  }
  return { shown, hidden };
}

export interface WindowCostDisplay {
  /** The headline number. */
  text: string;
  /** Qualifier under the number. Empty when the cost covers every turn. */
  note: string;
}

/**
 * Cost presentation for one window, extracted so it's testable without
 * rendering React (CLAUDE.md: prefer pure functions over private member
 * access for tests).
 *
 * The engine records no cost for an unpriced model (custom/OpenRouter
 * providers, dev fakes) rather than recording 0, and the API keeps that
 * distinction in `unpricedTurns`. So a window can be partly measured, and a
 * window can be entirely unmeasured. Neither may render as a confident "$0":
 * an unmeasured window shows a dash, and a partly measured one shows the
 * priced spend as a floor.
 */
export function windowCostDisplay(w: UsageWindow): WindowCostDisplay {
  if (w.turns === 0) return { text: formatUsd(0), note: "" };
  if (w.unpricedTurns === 0) return { text: formatUsd(w.costUsd), note: "" };
  if (w.unpricedTurns >= w.turns) return { text: "—", note: "unpriced" };
  return { text: `${formatUsd(w.costUsd)}+`, note: `${w.unpricedTurns} unpriced` };
}

function WindowStat({ label, window: w }: { label: string; window: UsageWindow }) {
  const cost = windowCostDisplay(w);
  return (
    <div className="rounded-md bg-moss-wash px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 font-display text-lg text-ink leading-tight">{cost.text}</div>
      <div className="text-[10px] text-muted tabular-nums">
        {formatTokens(w.totalTokens)} tok · {w.turns} turns
      </div>
      {cost.note && <div className="text-[10px] text-muted">{cost.note}</div>}
    </div>
  );
}

function MemberBar({
  member,
  max,
  isMe,
}: {
  member: UsageMemberSummary;
  max: number;
  isMe: boolean;
}) {
  const fraction = max > 0 ? member.costUsd / max : 0;
  const cost = windowCostDisplay(member);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("w-24 truncate", isMe ? "text-ink font-medium" : "text-muted")}>
        {isMe ? "You" : member.name}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-ink-wash overflow-hidden">
        {/* `bg-muted-wash`, never `bg-muted/50`: the slash modifier on a
            `var()` token emits no rule, which shipped these bars invisible
            for everyone but the viewer. See theme.css's trap note. */}
        <div
          className={cn("h-full rounded-full", isMe ? "bg-moss" : "bg-muted-wash")}
          style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
        />
      </div>
      <span
        className="w-16 text-right tabular-nums text-muted"
        title={
          cost.note
            ? `${member.unpricedTurns} of ${member.turns} turns had no price`
            : undefined
        }
      >
        {cost.text}
      </span>
    </div>
  );
}
