// Checks the built site (site/dist) for broken internal links: every href/src under the base
// must resolve to a built file, and every #fragment on an internal page must exist as an id on
// the target page. External links are counted, not fetched. Run after `pnpm run site:build`.

import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyLink, extractIds, extractLinks, toDistCandidates } from './lib/links.mjs';

const BASE = '/llm-usage-metrics/';
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

if (!existsSync(distRoot)) {
  console.error(`No built site at ${distRoot}. Run \`pnpm run site:build\` first.`);
  process.exit(1);
}

const posix = (relative) => relative.split(path.sep).join('/');
const files = (await readdir(distRoot, { recursive: true })).map(posix);
const htmlFiles = files.filter((file) => file.endsWith('.html')).sort();

/** The URL path a built HTML file is served at. */
function toUrlPath(file) {
  if (file === 'index.html') return BASE;
  if (file.endsWith('/index.html')) return `${BASE}${file.slice(0, -'index.html'.length)}`;
  return `${BASE}${file}`;
}

function resolveFile(urlPath) {
  const candidates = toDistCandidates(urlPath, BASE);
  if (candidates === null) return null;
  return (
    candidates.find((candidate) => {
      const full = path.join(distRoot, candidate);
      return existsSync(full) && statSync(full).isFile();
    }) ?? null
  );
}

const idsByFile = new Map();
async function idsOf(file) {
  if (!idsByFile.has(file)) {
    idsByFile.set(file, extractIds(await readFile(path.join(distRoot, file), 'utf8')));
  }
  return idsByFile.get(file);
}

const broken = [];
let internalCount = 0;
let externalCount = 0;

for (const file of htmlFiles) {
  const pagePath = toUrlPath(file);
  const html = await readFile(path.join(distRoot, file), 'utf8');
  idsByFile.set(file, extractIds(html));

  for (const value of new Set(extractLinks(html))) {
    const link = classifyLink(value, pagePath);
    if (link.kind === 'external') externalCount += 1;
    if (link.kind !== 'internal') continue;
    internalCount += 1;

    const target = resolveFile(link.path);
    if (target === null) {
      broken.push(`${pagePath} → ${value}`);
      continue;
    }
    if (link.fragment !== null && target.endsWith('.html')) {
      const ids = await idsOf(target);
      if (!ids.has(link.fragment)) broken.push(`${pagePath} → ${value} (no id "${link.fragment}")`);
    }
  }
}

console.log(
  `Checked ${htmlFiles.length} pages: ${internalCount} internal links, ${externalCount} external links (not fetched).`,
);

if (broken.length > 0) {
  console.error(`\n${broken.length} broken link(s):`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}
