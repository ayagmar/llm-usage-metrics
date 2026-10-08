#!/usr/bin/env node
import module from 'node:module';

// Reuse V8's compiled code for the CLI bundle across runs, so a repeat run skips most
// of the compile step. Every supported runtime has it: Node 22.8+ and Bun.
module.enableCompileCache();

// Only modules loaded after enableCompileCache() use the cache, so this loader stays tiny
// and the CLI must load dynamically. A computed specifier keeps the bundler from inlining it.
// eslint-disable-next-line no-restricted-syntax -- the loader exists to import the CLI late
await import(new URL('./index.js', import.meta.url).href);
