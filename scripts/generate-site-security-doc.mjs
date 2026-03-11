#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const inputPath = join(rootDir, 'docs', 'security.md');
const outputPath = join(rootDir, 'site', 'src', 'content', 'docs', 'security.mdx');

const frontmatter = `---
title: Security
description: Security scans, dependency update flow, SHA pinning, and contributor security steps for this repo.
---
`;

function stripTopLevelHeading(markdown) {
  return markdown.replace(/^#\s+.*\n+/u, '');
}

function generateSecurityDoc(markdown) {
  const body = stripTopLevelHeading(markdown).trim();

  return `${frontmatter}
:::note[Auto-generated]
Generated from \`docs/security.md\`. Edit the canonical contributor doc instead of this file.
:::

${body}
`;
}

function main() {
  const sourceMarkdown = readFileSync(inputPath, 'utf8');
  const generatedMarkdown = generateSecurityDoc(sourceMarkdown);
  writeFileSync(outputPath, generatedMarkdown, 'utf8');
  console.log(`Security docs generated at ${outputPath}`);
}

main();
