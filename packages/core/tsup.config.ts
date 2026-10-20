import { cp } from 'node:fs/promises';

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
  // The pricing data, read at runtime from `./data/` next to the module that reads it. Both
  // `./internal` and `./pricing` use that module, so it lands in a shared chunk at the root of
  // dist/. `core:pack:check` prices an event from the installed tarball, so a move breaks it.
  onSuccess: async () => {
    await cp('src/pricing/data', 'dist/data', { recursive: true });
  },
});
