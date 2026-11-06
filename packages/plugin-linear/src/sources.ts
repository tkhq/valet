import type { SourceInput } from '@valet/shared';

/**
 * Sources from a Linear MCP result: an issue or a comment that has a link.
 * The Linear server returns one item, a list, or an object that holds a list
 * (`issues`, `comments`, `projects`). The walk reads each level once and
 * keeps only items whose link is on linear.app. An item with no link is not
 * a source, because the reader could not open it.
 */

const MAX_DEPTH = 3;
const MAX_ITEMS = 20;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function linearUrl(value: unknown): string | undefined {
  const url = text(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'linear.app' || parsed.hostname.endsWith('.linear.app')) ? url : undefined;
  } catch {
    return undefined;
  }
}

function itemSource(item: Record<string, unknown>): SourceInput | undefined {
  const url = linearUrl(item.url);
  if (!url) return undefined;
  const issue = record(item.issue);
  if (url.includes('#comment-') || (text(item.body) && !text(item.title))) {
    const on = text(issue?.identifier) ?? text(issue?.title);
    const author = text(record(item.user)?.name) ?? text(item.userName);
    return {
      service: 'linear',
      title: on ? `Comment on ${on}` : 'Linear comment',
      url,
      snippet: text(item.body),
      ...(author ? { location: `by ${author}` } : {}),
    };
  }
  const title = text(item.title) ?? text(item.name);
  if (!title) return undefined;
  const identifier = text(item.identifier);
  const status = text(record(item.status)?.name) ?? text(item.status);
  return {
    service: 'linear',
    title: identifier ? `${identifier} ${title}` : title,
    url,
    snippet: text(item.description) ?? text(item.summary),
    ...(status ? { location: status } : {}),
  };
}

function collect(value: unknown, depth: number, out: SourceInput[]): void {
  if (out.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, depth + 1, out);
    return;
  }
  const item = record(value);
  if (!item) return;
  const source = itemSource(item);
  if (source) {
    out.push(source);
    return;
  }
  for (const key of ['issues', 'comments', 'projects', 'documents', 'results', 'nodes', 'items', 'data']) {
    if (key in item) collect(item[key], depth + 1, out);
  }
}

/** Sources for a Linear tool that reads items. Writes and unknown tools give none. */
export function linearSources(toolName: string, data: unknown): SourceInput[] {
  if (!/^(get|list|search|find)_/.test(toolName)) return [];
  const out: SourceInput[] = [];
  collect(data, 0, out);
  return out;
}
