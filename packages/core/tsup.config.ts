import { defineConfig } from 'tsup';

import packageJson from './package.json' with { type: 'json' };

// One entry per `exports` subpath, so the build and the exports map cannot drift:
// '.' -> src/index.ts, './sources/amp' -> src/sources/amp/index.ts.
const entry = Object.fromEntries(
  Object.keys(packageJson.exports).map((subpath) => {
    const directory = subpath === '.' ? '' : `${subpath.slice(2)}/`;
    return [`${directory}index`, `src/${directory}index.ts`];
  }),
);

export default defineConfig({
  entry,
  format: ['esm'],
  platform: 'node',
  // The default rewrites `node:x` to `x`, and `node:sqlite` has no bare alias.
  removeNodeProtocol: false,
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
});
