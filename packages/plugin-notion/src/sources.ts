import type { SourceInput } from '@valet/shared';

/**
 * Sources from a Notion MCP result: a fetched page, or each page in a search.
 * An item counts only with a title and a link on notion.so or notion.site.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function notionUrl(value: unknown): string | undefined {
  const url = text(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return parsed.protocol === 'https:' && (host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site')) ? url : undefined;
  } catch {
    return undefined;
  }
}

function itemSource(item: Record<string, unknown>): SourceInput | undefined {
  const url = notionUrl(item.url);
  const title = text(item.title) ?? text(record(item.properties)?.title);
  if (!url || !title) return undefined;
  const kind = text(item.type) ?? text(record(item.metadata)?.type);
  const body = text(item.text) ?? text(item.highlight) ?? text(item.summary);
  return {
    service: 'notion',
    title,
    url,
    ...(body ? { snippet: body } : {}),
    ...(kind ? { location: kind } : {}),
  };
}

/** Sources for a Notion tool that reads or searches pages. Writes give none. */
export function notionSources(toolName: string, data: unknown): SourceInput[] {
  if (!/(fetch|search|get|retrieve|query)/.test(toolName) || /(create|update|move|duplicate|comment)/.test(toolName)) return [];
  const root = record(data);
  const items = Array.isArray(data) ? data : Array.isArray(root?.results) ? root.results : root ? [root] : [];
  return items.slice(0, 20).flatMap((value) => {
    const item = record(value);
    const source = item ? itemSource(item) : undefined;
    return source ? [source] : [];
  });
}
