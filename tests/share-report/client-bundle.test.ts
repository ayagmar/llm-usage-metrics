import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { renderShareClientBundle } from '../../scripts/build-share-client.mjs';
import {
  SHARE_CLIENT_SCRIPT,
  SHARE_CLIENT_SCRIPT_HASH,
  SHARE_CLIENT_STYLE,
  SHARE_CLIENT_STYLE_HASH,
} from '../../src/share-report/client-bundle.generated.js';

function cspHash(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

describe('share client bundle', () => {
  it('matches a fresh build of the client sources', async () => {
    const committed = readFileSync(
      path.resolve('src/share-report/client-bundle.generated.ts'),
      'utf8',
    );

    expect(
      await renderShareClientBundle(),
      'client-bundle.generated.ts is stale; run `node scripts/build-share-client.mjs`',
    ).toBe(committed);
  });

  it('carries CSP hashes of the exact script and style text', () => {
    expect(SHARE_CLIENT_SCRIPT_HASH).toBe(cspHash(SHARE_CLIENT_SCRIPT));
    expect(SHARE_CLIENT_STYLE_HASH).toBe(cspHash(SHARE_CLIENT_STYLE));
  });

  it.each([
    ['script', SHARE_CLIENT_SCRIPT],
    ['style', SHARE_CLIENT_STYLE],
  ])('keeps the inline %s free of sequences that would break out of its element', (_, text) => {
    expect(text.length).toBeGreaterThan(0);

    for (const sequence of ['</script', '</style', '<!--']) {
      expect(text.toLowerCase()).not.toContain(sequence);
    }
  });
});

describe('repo modules in the share client', () => {
  it('are only helpers that import nothing, so they hold no module state of the CLI', async () => {
    const result = await build({
      entryPoints: ['src/share-report/client/ui/main.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      logLevel: 'silent',
      outfile: 'share-client.js',
    });
    const outside = Object.keys(result.metafile.inputs)
      .filter((input) => !input.startsWith('src/share-report/client/'))
      .sort();

    expect(outside).toEqual([
      'src/render/format-duration.ts',
      'src/utils/date-key.ts',
      'src/utils/delta-ratio.ts',
      'src/utils/usd-math.ts',
    ]);

    for (const input of outside) {
      expect(readFileSync(input, 'utf8'), input).not.toMatch(/^import /mu);
    }
  });
});
