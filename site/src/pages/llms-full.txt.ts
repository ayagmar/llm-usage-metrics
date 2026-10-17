import type { APIRoute } from 'astro';
import { SUMMARY, getSidebarSections, pageUrl } from '../llms/docs';

const diagramSources = import.meta.glob<string>('../components/diagrams/*.astro', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function elementText(source: string, tag: string): string {
  const open = source.indexOf(`<${tag}`);
  const start = source.indexOf('>', open) + 1;
  const end = source.indexOf(`</${tag}>`, start);
  if (open === -1 || end === -1) throw new Error(`Diagram source has no <${tag}>`);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Diagram component name to its `<title>` and `<desc>`, the diagram in words. */
const diagramTexts = new Map(
  Object.entries(diagramSources).map(([path, source]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.astro'.length),
    `Diagram: ${elementText(source, 'title')}. ${elementText(source, 'desc')}`,
  ]),
);

function toText(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .map((line) => {
      const tag = line.trim();
      if (!tag.startsWith('<') || !tag.endsWith('/>')) return line;
      return diagramTexts.get(tag.slice(1, -2).trim()) ?? line;
    })
    .join('\n')
    .trim();
}

export const GET: APIRoute = async () => {
  const parts = ['# LLM Usage Metrics', '', `> ${SUMMARY}`];
  const seen = new Set<string>();
  for (const section of await getSidebarSections()) {
    for (const entry of section.entries) {
      // The sources overview appears in two sidebar groups; include it once.
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      parts.push(
        '',
        `# ${entry.data.title}`,
        '',
        `Source: ${pageUrl(entry.id)}`,
        '',
        toText(entry.body ?? ''),
      );
    }
  }
  return new Response(`${parts.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
