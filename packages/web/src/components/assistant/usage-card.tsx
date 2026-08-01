import { useQuery } from "@tanstack/react-query";
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
  const maxMemberCost = Math.max(0, ...(data?.org?.members.map((m) => m.costUsd) ?? []));

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">Usage</h2>
        {data?.org && (
          <span className="text-xs text-muted">last {data.org.windowDays} days</span>
        )}
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

            {data.org && data.org.members.length > 1 && (
              <div className="pt-1 space-y-1.5">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Team
                </div>
                {data.org.members.map((m) => (
                  <MemberBar
                    key={m.userId}
                    member={m}
                    max={maxMemberCost}
                    isMe={m.userId === me.data?.id}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function WindowStat({ label, window: w }: { label: string; window: UsageWindow }) {
  return (
    <div className="rounded-md bg-moss-wash px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 font-display text-lg text-ink leading-tight">{formatUsd(w.costUsd)}</div>
      <div className="text-[10px] text-muted tabular-nums">
        {formatTokens(w.inputTokens + w.outputTokens)} tok · {w.turns} turns
      </div>
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
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("w-24 truncate", isMe ? "text-ink font-medium" : "text-muted")}>
        {isMe ? "You" : member.name}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-ink-wash overflow-hidden">
        <div
          className={cn("h-full rounded-full", isMe ? "bg-moss" : "bg-muted/50")}
          style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
        />
      </div>
      <span className="w-14 text-right tabular-nums text-muted">{formatUsd(member.costUsd)}</span>
    </div>
  );
}
