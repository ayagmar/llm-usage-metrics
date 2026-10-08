import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { revealHiddenOptions } from '../../src/cli/report-definitions/shared-report-options.js';
import { createCli } from '../../src/cli/create-cli.js';
import { getDefaultSourceIds } from '../../src/sources/create-default-adapters.js';

const docsRoot = path.resolve('site/src/content/docs');

// readdir returns backslash-separated paths on Windows; routes are slash-separated.
async function readdirPosix(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join('/'));
}

describe('website documentation contracts', () => {
  it('publishes discovery documentation for every registered source', async () => {
    const overview = await readFile(path.join(docsRoot, 'sources/index.mdx'), 'utf8');

    for (const id of getDefaultSourceIds()) {
      const detail = await readFile(path.join(docsRoot, 'sources', `${id}.mdx`), 'utf8');
      expect(detail, id).toContain('llm-usage');
      expect(overview, id).toContain(`/llm-usage-metrics/sources/${id}/`);
    }
  });

  it('keeps generated command help aligned with each current CLI command', async () => {
    const reference = await readFile(path.join(docsRoot, 'cli-reference.mdx'), 'utf8');
    const cli = createCli({ version: 'test' });
    // The reference documents the per-source path flags that only --help-all shows.
    revealHiddenOptions(cli);

    for (const command of cli.commands) {
      expect(reference, command.name()).toContain(command.helpInformation().trimEnd());
      for (const subcommand of command.commands) {
        expect(reference, `${command.name()} ${subcommand.name()}`).toContain(
          subcommand.helpInformation().trimEnd(),
        );
      }
    }
  });

  it('resolves internal documentation links to published routes or public files', async () => {
    const entries = await readdirPosix(docsRoot);
    const docFiles = entries.filter((entry) => entry.endsWith('.mdx'));
    const routes = new Set([
      '', // Custom Astro landing page.
      ...docFiles.map((file) => file.replace(/(?:\/index)?\.mdx$/, '')),
    ]);
    const publicFiles = new Set(await readdirPosix(path.resolve('site/public')));

    for (const file of docFiles) {
      const content = await readFile(path.join(docsRoot, file), 'utf8');
      const links = content.matchAll(/(?:\]\(|href=["'])\/llm-usage-metrics\/([^\s)"']*)/g);
      for (const [, target] of links) {
        const route = target.split('#')[0].replace(/\/$/, '');
        expect(routes.has(route) || publicFiles.has(route), `${file} links to ${target}`).toBe(true);
      }
    }
  });

  it('gives the docs overview its own route beside the custom landing page', async () => {
    const files = await readdir(docsRoot);
    expect(files).toContain('docs.mdx');
    expect(files).not.toContain('index.mdx');
  });
});
