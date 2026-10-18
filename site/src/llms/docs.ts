import { getCollection, type CollectionEntry } from 'astro:content';
import { getDefaultSourceIds } from '../../../src/sources/create-default-adapters';
import { sidebar } from '../sidebar.mjs';

export const SITE_URL = 'https://ayagmar.github.io/llm-usage-metrics';

export const SUMMARY = `llm-usage-metrics is a local CLI that reads session logs from ${getDefaultSourceIds().length} AI coding tools and reports tokens and estimated cost by day, hour, project, session, 5-hour block and subscription plan, with trends, comparisons, tool-call counts, prompt sizes and a self-contained interactive HTML report. Install with \`npm i -g llm-usage-metrics\` and run \`llm-usage\`. Its parsers are also a Node.js library, \`@ayagmar/agent-sessions\`, that reads the same logs as events.`;

export type DocsSection = { label: string; entries: CollectionEntry<'docs'>[] };

export function pageUrl(id: string): string {
  return `${SITE_URL}/${id}/`;
}

/** Docs pages grouped and ordered as in the site sidebar. */
export async function getSidebarSections(): Promise<DocsSection[]> {
  const entries = new Map(
    (await getCollection('docs')).map((entry: CollectionEntry<'docs'>) => [entry.id, entry]),
  );
  return sidebar.map((group) => ({
    label: group.label,
    entries: group.items.map(({ slug }) => {
      const entry = entries.get(slug);
      if (!entry) throw new Error(`Sidebar slug "${slug}" has no docs page`);
      return entry;
    }),
  }));
}
