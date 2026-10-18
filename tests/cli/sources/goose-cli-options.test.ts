import { describe, expect, it } from 'vitest';

import { createAdaptersFromOptions } from '../../../src/cli/source-cli-options.js';

describe('goose CLI options', () => {
  it('rejects a blank --goose-db in the CLI validation before the adapter sees it', () => {
    expect(() => createAdaptersFromOptions({ gooseDb: '  ' })).toThrow(
      '--goose-db must be a non-empty path',
    );
  });
});
