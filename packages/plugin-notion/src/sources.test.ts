import { describe, expect, it } from 'vitest';
import { notionSources } from './sources.js';

describe('notionSources', () => {
  it('makes a source from a fetched page', () => {
    expect(notionSources('notion-fetch', { metadata: { type: 'page' }, title: 'Roadmap', url: 'https://www.notion.so/Roadmap-123', text: 'Q4 goals' }))
      .toEqual([{ service: 'notion', title: 'Roadmap', url: 'https://www.notion.so/Roadmap-123', snippet: 'Q4 goals', location: 'page' }]);
  });

  it('makes a source for each search result with a Notion link', () => {
    const sources = notionSources('notion-search', { results: [
      { title: 'A', url: 'https://www.notion.so/A-1', type: 'page', highlight: 'hit' },
      { title: 'B', url: 'https://example.com/B' },
    ] });
    expect(sources.map((s) => s.title)).toEqual(['A']);
  });

  it('gives no source for a write', () => {
    expect(notionSources('notion-create-pages', { title: 'A', url: 'https://www.notion.so/A-1' })).toEqual([]);
  });
});
