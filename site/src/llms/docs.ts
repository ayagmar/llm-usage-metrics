import { getCollection, type CollectionEntry } from 'astro:content';
import { sidebar } from '../sidebar.mjs';

export const SITE_URL = 'https://ayagmar.github.io/llm-usage-metrics';

export const SUMMARY =
  'llm-usage-metrics is a local CLI that reads usage logs from AI coding tools and reports tokens, estimated cost, sessions, trends, and comparisons. Install with `npm i -g llm-usage-metrics` and run `llm-usage`.';

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
