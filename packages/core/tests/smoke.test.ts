import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ExportTarget = { types: string; import: string };
type PackageJson = { exports: Record<string, ExportTarget> };

const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
) as PackageJson;

function sourceEntryFor(subpath: string): string {
  return path.join(packageRoot, 'src', subpath === '.' ? '' : subpath, 'index.ts');
}

describe('package exports', () => {
  it.each(Object.entries(packageJson.exports))(
    '%s points at the build output of an existing source entry',
    (subpath, target) => {
      const distDir = subpath === '.' ? './dist' : `./dist/${subpath.slice(2)}`;

      expect(existsSync(sourceEntryFor(subpath))).toBe(true);
      expect(target).toEqual({
        types: `${distDir}/index.d.ts`,
        import: `${distDir}/index.js`,
      });
    },
  );

  it('exports every source directory', () => {
    const sourceDirectories = readdirSync(path.join(packageRoot, 'src', 'sources')).sort();
    const sourceSubpaths = Object.keys(packageJson.exports)
      .filter((subpath) => subpath.startsWith('./sources/'))
      .map((subpath) => subpath.slice('./sources/'.length))
      .sort();

    expect(sourceSubpaths).toEqual(sourceDirectories);
  });
});
