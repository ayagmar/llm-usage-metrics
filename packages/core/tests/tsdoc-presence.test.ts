import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every name a public subpath exports has a doc comment on its declaration. A comment that
// only carries `@internal` counts: it marks the name as outside the semver promise.
// `./internal` makes no promise and is not checked.
const UNCHECKED_SUBPATHS = new Set(['./internal']);

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const packageExports = (
  JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: string }>;
  }
).exports;

/** The source entry of a `dist` export target: `./dist/x/index.js` -> `src/x/index.ts`. */
function sourceEntry(target: string): string {
  return path.join(packageRoot, target.replace(/^\.\/dist\//u, 'src/').replace(/\.js$/u, '.ts'));
}

function hasDocComment(declaration: ts.Declaration): boolean {
  return ts.getJSDocCommentsAndTags(declaration).length > 0;
}

/** `subpath: name` for every public export whose declarations carry no doc comment. */
function readUndocumented(): string[] {
  const entries = Object.entries(packageExports)
    .filter(([subpath]) => !UNCHECKED_SUBPATHS.has(subpath))
    .map(([subpath, target]) => [subpath, sourceEntry(target.import)] as const);
  const program = ts.createProgram(
    entries.map(([, file]) => file),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    },
  );
  const checker = program.getTypeChecker();
  const undocumented: string[] = [];

  for (const [subpath, file] of entries) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);

    if (!sourceFile || !moduleSymbol) {
      throw new Error(`No module for ${subpath} at ${file}`);
    }

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declarations = symbol.getDeclarations() ?? [];

      if (!declarations.some(hasDocComment)) {
        undocumented.push(`${subpath}: ${exported.name}`);
      }
    }
  }

  return undocumented.sort();
}

describe('TSDoc presence', () => {
  it('documents every export of the public subpaths', () => {
    expect(readUndocumented()).toEqual([]);
  }, 60_000);
});
