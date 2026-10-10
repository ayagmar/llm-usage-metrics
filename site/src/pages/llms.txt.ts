import type { APIRoute } from 'astro';
import { SITE_URL, SUMMARY, getSidebarSections, pageUrl } from '../llms/docs';

export const GET: APIRoute = async () => {
  const lines = [
    '# LLM Usage Metrics',
    '',
    `> ${SUMMARY}`,
    '',
    `All docs pages in one file: ${SITE_URL}/llms-full.txt`,
  ];
  for (const section of await getSidebarSections()) {
    lines.push('', `## ${section.label}`, '');
    for (const entry of section.entries) {
      const description = entry.data.description ? `: ${entry.data.description}` : '';
      lines.push(`- [${entry.data.title}](${pageUrl(entry.id)})${description}`);
    }
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
