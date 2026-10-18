#!/usr/bin/env node
import module from 'node:module';

// The engines range in package.json. npm only warns about it, so an older Node would
// otherwise fail later on a missing API instead of saying what it needs. Bun reports the
// Node version it implements; any Bun that runs this file is accepted.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
const isSupportedRuntime =
  process.versions.bun !== undefined || nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 16);

if (isSupportedRuntime) {
  // Reuse V8's compiled code for the CLI bundle across runs, so a repeat run skips most
  // of the compile step. Node 22.8+ and Bun have it; the guard covers a runtime that
  // reports a supported version without it.
  if (typeof module.enableCompileCache === 'function') {
    module.enableCompileCache();
  }

  // Only modules loaded after enableCompileCache() use the cache, so this loader stays tiny
  // and the CLI must load dynamically. A computed specifier keeps the bundler from inlining it.
  // eslint-disable-next-line no-restricted-syntax -- the loader exists to import the CLI late
  await import(new URL('./index.js', import.meta.url).href);
} else {
  console.error(
    `llm-usage requires Node.js 22.16+ or 24+; this is Node.js ${process.versions.node}.`,
  );
  process.exitCode = 1;
}
