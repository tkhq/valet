import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { ArrowDownRight, ArrowUpRight, CalendarDays, MapPin, Quote as QuoteIcon, Users } from "lucide-react";
import type { ReactNode } from "react";
import { widgetCatalog, type WidgetSpec } from "@valet/api/widgets";
import { readChart } from "@valet/shared";
import { Badge, Button, StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { useSendAsPerson, useThreadReplyTarget } from "../send-as-person";
import { ChartView } from "./chart-view";

/**
 * Valet's components for the widget catalog (`@valet/api/widgets`). The
 * model picks and fills them; these decide how they look, so every widget
 * reads like the rest of the thread.
 */

const STATUS = {
  needs_you: { tone: "warning", label: "Needs you" },
  working: { tone: "info", label: "Working" },
  done: { tone: "neutral", label: "Done" },
  failed: { tone: "danger", label: "Failed" },
} as const;

/** A Button that sends its reply as the person. Outside a live thread it shows, disabled. */
function ReplyButton({ label, reply, primary }: { label: string; reply: string; primary?: boolean }) {
  const target = useThreadReplyTarget();
  const send = useSendAsPerson(target?.sessionId ?? "", target?.threadId, "Could not send. Type your reply instead.");
  return <span className="inline-flex flex-col gap-1">
    <Button size="sm" variant={primary ? "primary" : "secondary"} disabled={!target || send.pending} onClick={() => void send.reply(reply)}>{label}</Button>
    {send.error && <span role="alert" className="text-xs text-danger-500">{send.error}</span>}
  </span>;
}

/** One cell per day in columns of seven, oldest first, shaded by the share of the busiest day. */
function Heatmap({ values, label }: { values: number[]; label?: string }) {
  const max = Math.max(1, ...values);
  const weeks: number[][] = [];
  for (let i = 0; i < values.length; i += 7) weeks.push(values.slice(i, i + 7));
  return <figure className="min-w-0 space-y-2">
    <div className="flex gap-[3px] overflow-x-auto pb-1" role="img" aria-label={label ?? `Activity over ${values.length} days`}>
      {weeks.map((week, w) => <div key={w} className="flex shrink-0 flex-col gap-[3px]">
        {week.map((value, d) => <span key={d} title={String(value)} className="h-2.5 w-2.5 rounded-[2px]"
          style={{ background: value === 0 ? "var(--ink-wash-strong)" : `color-mix(in oklch, var(--ink) ${Math.round(20 + 70 * value / max)}%, transparent)` }} />)}
      </div>)}
    </div>
    {label && <figcaption className="text-xs text-muted">{label}</figcaption>}
  </figure>;
}

function Initial({ name }: { name: string }) {
  return <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-wash text-[11px] font-medium text-ink">{name.trim()[0]?.toUpperCase() ?? "?"}</span>;
}

const { registry } = defineRegistry(widgetCatalog, {
  components: {
    Card: ({ props, children }) => <section className="min-w-0 space-y-3 rounded-xl border border-line bg-paper p-4">
      {(props.title || props.subtitle) && <header className="min-w-0">
        {props.title && <h3 className="text-sm font-medium text-ink">{props.title}</h3>}
        {props.subtitle && <p className="text-xs text-muted">{props.subtitle}</p>}
      </header>}
      {children}
    </section>,
    Stack: ({ props, children }) => <div className={cn("flex min-w-0", props.direction === "row" ? "flex-row flex-wrap items-center" : "flex-col", props.gap === "sm" ? "gap-2" : "gap-3")}>{children}</div>,
    Heading: ({ props }) => <h4 className="text-sm font-medium text-ink">{props.text}</h4>,
    Text: ({ props }) => <p className={cn("text-sm [overflow-wrap:anywhere]", props.muted ? "text-muted" : "text-ink")}>{props.text}</p>,
    Stat: ({ props }) => <div className="min-w-0">
      <p className="text-xs text-muted">{props.label}</p>
      <p className="flex items-baseline gap-1.5 text-2xl font-semibold tabular-nums text-ink">
        {props.value}
        {props.trend === "up" && <ArrowUpRight aria-label="Up" className="h-4 w-4 text-muted" />}
        {props.trend === "down" && <ArrowDownRight aria-label="Down" className="h-4 w-4 text-muted" />}
      </p>
      {props.detail && <p className="text-xs text-muted">{props.detail}</p>}
    </div>,
    Table: ({ props }) => <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-line text-left text-xs text-muted">
          {props.columns.map(column => <th key={column.key} scope="col" className={cn("py-1.5 pr-3 font-normal last:pr-0", column.align === "right" && "text-right")}>{column.label}</th>)}
        </tr></thead>
        <tbody>{props.rows.map((row, i) => <tr key={i} className="border-b border-line/60 last:border-0">
          {props.columns.map(column => <td key={column.key} className={cn("py-1.5 pr-3 text-ink last:pr-0", column.align === "right" && "text-right tabular-nums")}>{row[column.key] ?? ""}</td>)}
        </tr>)}</tbody>
      </table>
    </div>,
    List: ({ props }) => <ul className="min-w-0 divide-y divide-line/60">
      {props.items.map((item, i) => {
        const title = item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="hover:underline">{item.title}</a> : item.title;
        return <li key={i} className="flex min-w-0 items-start gap-2 py-2 first:pt-0 last:pb-0">
          {item.status && <StatusDot tone={STATUS[item.status].tone} label={STATUS[item.status].label} className="mt-1.5" />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-ink [overflow-wrap:anywhere]">{title}</span>
            {item.subtitle && <span className="block text-xs text-muted">{item.subtitle}</span>}
          </span>
          {(item.status || item.meta) && <span className="shrink-0 text-right text-xs text-muted tabular-nums">
            {item.status && <span aria-hidden="true" className="block">{STATUS[item.status].label}</span>}
            {item.meta && <span className="block">{item.meta}</span>}
          </span>}
        </li>;
      })}
    </ul>,
    Quote: ({ props }) => <figure className="min-w-0 space-y-2">
      {(props.source || props.time) && <figcaption className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">{props.source}</span><span className="shrink-0 tabular-nums">{props.time}</span>
      </figcaption>}
      <blockquote className="flex gap-2 font-display text-[15px] leading-relaxed text-ink">
        <QuoteIcon aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="[overflow-wrap:anywhere]">{props.text}</span>
      </blockquote>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Initial name={props.speaker} /><span className="text-ink">{props.speaker}</span>
        {props.takeaway && <span>· Takeaway: {props.takeaway}</span>}
      </p>
    </figure>,
    Event: ({ props }) => <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium text-ink">{props.title}</p>
      <p className="flex items-center gap-1.5 text-sm text-ink"><CalendarDays aria-hidden className="h-3.5 w-3.5 text-muted" />{props.start}{props.end ? ` to ${props.end}` : ""}</p>
      {props.location && <p className="flex items-center gap-1.5 text-sm text-muted"><MapPin aria-hidden className="h-3.5 w-3.5" />{props.location}</p>}
      {props.attendees && props.attendees.length > 0 && <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
        <Users aria-hidden className="h-3.5 w-3.5" />{props.attendees.map(name => <span key={name} className="inline-flex items-center gap-1"><Initial name={name} />{name}</span>)}
      </p>}
      {props.note && <p className="text-xs text-muted">{props.note}</p>}
    </div>,
    KeyValue: ({ props }) => <dl className="grid min-w-0 grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {props.items.map((item, i) => <Pair key={i} label={item.label}>{item.value}</Pair>)}
    </dl>,
    Badge: ({ props }) => <Badge variant={props.tone ?? "neutral"} className="w-fit">{props.text}</Badge>,
    Progress: ({ props }) => <div className="min-w-0 space-y-1">
      <div className="flex justify-between gap-2 text-xs"><span className="text-ink">{props.label}</span><span className="text-muted tabular-nums">{props.detail ?? `${Math.round(props.value)}%`}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-wash" role="progressbar" aria-label={props.label} aria-valuenow={Math.round(props.value)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-ink" style={{ width: `${props.value}%` }} />
      </div>
    </div>,
    Heatmap: ({ props }) => <Heatmap values={props.values} label={props.label} />,
    Chart: ({ props }) => {
      const chart = readChart(props);
      return chart ? <ChartView {...chart} /> : null;
    },
    Button: ({ props }) => <ReplyButton label={props.label} reply={props.reply} primary={props.primary} />,
    Link: ({ props }) => <a href={props.href} target="_blank" rel="noreferrer" className="w-fit text-sm text-moss hover:underline">{props.label}</a>,
    Divider: () => <hr className="border-line" />,
  },
});

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-muted [overflow-wrap:anywhere]">{label}</dt><dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd></>;
}

/** A widget the assistant showed, drawn from its spec. */
export function WidgetView({ spec, title }: { spec: WidgetSpec; title?: string }) {
  return <div role="figure" aria-label={title ?? "Widget"} className="min-w-0 max-w-xl">
    <JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  </div>;
}
