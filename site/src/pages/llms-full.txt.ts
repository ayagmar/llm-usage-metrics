import type { APIRoute } from 'astro';
import { SUMMARY, getSidebarSections, pageUrl } from '../llms/docs';

function stripImports(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.startsWith('import '))
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
        stripImports(entry.body ?? ''),
      );
    }
  }
  return new Response(`${parts.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
