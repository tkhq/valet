/** Scores a detector's spans against labeled messages. */
import type { LabeledMessage } from "./dataset.js";

export interface Span {
  start: number;
  end: number;
}

export interface DetectorResult {
  id: string;
  spans: Span[];
}

export interface Score {
  /** Messages with keys where every key span was caught. */
  recall: number;
  /** Messages without keys where anything was flagged. */
  falseAlarmRate: number;
  /** Flagged spans that overlap a key span. */
  spanPrecision: number;
  messagesWithKeys: number;
  messagesWithoutKeys: number;
  flaggedSpans: number;
  misses: string[];
  falseAlarms: string[];
}

const overlap = (a: Span, b: Span): boolean => a.start < b.end && a.end > b.start;

export function score(messages: LabeledMessage[], results: Map<string, Span[]>): Score {
  let withKeys = 0;
  let caught = 0;
  let without = 0;
  let alarms = 0;
  let flagged = 0;
  let truePositiveSpans = 0;
  const misses: string[] = [];
  const falseAlarms: string[] = [];
  for (const m of messages) {
    const spans = results.get(m.id) ?? [];
    flagged += spans.length;
    truePositiveSpans += spans.filter((s) => m.secrets.some((k) => overlap(s, k))).length;
    if (m.secrets.length > 0) {
      withKeys++;
      if (m.secrets.every((k) => spans.some((s) => overlap(s, k)))) caught++;
      else misses.push(m.id);
    } else {
      without++;
      if (spans.length > 0) {
        alarms++;
        falseAlarms.push(m.id);
      }
    }
  }
  return {
    recall: withKeys ? caught / withKeys : 1,
    falseAlarmRate: without ? alarms / without : 0,
    spanPrecision: flagged ? truePositiveSpans / flagged : 1,
    messagesWithKeys: withKeys,
    messagesWithoutKeys: without,
    flaggedSpans: flagged,
    misses,
    falseAlarms,
  };
}

/** Recall per category, for messages with keys. */
export function recallByCategory(messages: LabeledMessage[], results: Map<string, Span[]>): Map<string, number> {
  const groups = new Map<string, { n: number; hit: number }>();
  for (const m of messages) {
    if (m.secrets.length === 0) continue;
    const g = groups.get(m.category) ?? { n: 0, hit: 0 };
    g.n++;
    const spans = results.get(m.id) ?? [];
    if (m.secrets.every((k) => spans.some((s) => overlap(s, k)))) g.hit++;
    groups.set(m.category, g);
  }
  return new Map([...groups].map(([k, g]) => [k, g.hit / g.n]));
}
