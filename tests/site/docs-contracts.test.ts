import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { revealHiddenOptions } from '../../src/cli/report-definitions/shared-report-options.js';
import { createCli } from '../../src/cli/create-cli.js';
import { getDefaultSourceIds } from '@ayagmar/agent-sessions/registry';

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

  it('imports only names the library exports, from subpaths in its exports map', async () => {
    const coreRoot = path.resolve('packages/core');
    const packageExports = (
      JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8')) as {
        exports: Record<string, { import: string }>;
      }
    ).exports;
    const libraryPages = (await readdirPosix(path.join(docsRoot, 'library')))
      .filter((file) => file.endsWith('.mdx'))
      .map((file) => path.join(docsRoot, 'library', file));
    const imports: { file: string; subpath: string; names: string[] }[] = [];

    for (const file of [...libraryPages, path.join(coreRoot, 'README.md')]) {
      const content = await readFile(file, 'utf8');
      const statements = content.matchAll(
        /^import (?:type )?\{([^}]*)\} from '@ayagmar\/agent-sessions((?:\/[\w/-]+)?)';$/gm,
      );
      for (const [, names, subpath] of statements) {
        imports.push({
          file: path.relative(process.cwd(), file),
          subpath: `.${subpath}`,
          names: names
            .split(',')
            .map((name) => name.replace(/^\s*type\s+/, '').trim())
            .filter(Boolean),
        });
      }
    }

    expect(imports.length).toBeGreaterThan(0);
    for (const { file, subpath } of imports) {
      expect(Object.keys(packageExports), `${file} imports ${subpath}`).toContain(subpath);
    }

    const entries = new Map(
      [...new Set(imports.map(({ subpath }) => subpath))].map((subpath) => [
        subpath,
        path.join(
          coreRoot,
          packageExports[subpath].import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
        ),
      ]),
    );
    const program = ts.createProgram([...entries.values()], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    });
    const checker = program.getTypeChecker();
    const exportedNames = new Map(
      [...entries].map(([subpath, file]) => {
        const sourceFile = program.getSourceFile(file);
        const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) throw new Error(`No module for ${subpath} at ${file}`);
        return [subpath, new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.name))];
      }),
    );

    for (const { file, subpath, names } of imports) {
      for (const name of names) {
        expect(exportedNames.get(subpath)?.has(name), `${file}: ${name} from ${subpath}`).toBe(
          true,
        );
      }
    }
  }, 60_000);

  it('gives the docs overview its own route beside the custom landing page', async () => {
    const files = await readdir(docsRoot);
    expect(files).toContain('docs.mdx');
    expect(files).not.toContain('index.mdx');
  });
});
