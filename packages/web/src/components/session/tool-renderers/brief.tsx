import { Newspaper } from "lucide-react";
import { BriefCard, type BriefItem, type BriefItemState } from "~/components/home/brief-card";
import { ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer, type ToolRendererProps } from "./types";

const STATES = new Set<BriefItemState>(["needs_you", "working", "done", "fyi"]);

/** The headline and items of a `show_brief` call, or undefined while its args are incomplete. */
export function briefFromArgs(args: unknown): { headline: string; items: BriefItem[] } | undefined {
  if (!args || typeof args !== "object") return undefined;
  const { headline, items } = args as Record<string, unknown>;
  if (typeof headline !== "string" || !Array.isArray(items)) return undefined;
  const parsed = items.flatMap((raw): BriefItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const { topic, text, state, thread_id: threadId } = raw as Record<string, unknown>;
    if (typeof topic !== "string" || typeof text !== "string") return [];
    const known = typeof state === "string" && STATES.has(state as BriefItemState) ? state as BriefItemState : "fyi";
    return [{ topic, text, state: known, ...(typeof threadId === "string" && threadId ? { threadId } : {}) }];
  });
  return { headline, items: parsed };
}

function BriefPreview({ args, status }: ToolRendererProps) {
  const brief = status === "completed" ? briefFromArgs(args) : undefined;
  return brief ? <BriefCard headline={brief.headline} items={brief.items} className="my-1" /> : null;
}

export const briefRenderer: ToolRenderer = {
  matches: "show_brief",
  category: "read",
  Icon: Newspaper,
  bare: true,
  formatTarget: (args) => briefFromArgs(args)?.headline,
  Preview: BriefPreview,
  Body: ({ result, error }) => <ToolBody><pre className="whitespace-pre-wrap font-mono text-[12px] text-ink/85">{error ?? resultText(result)}</pre></ToolBody>,
};
