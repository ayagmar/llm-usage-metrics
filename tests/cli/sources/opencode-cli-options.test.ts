import { describe, expect, it } from 'vitest';

import { createAdaptersFromOptions } from '../../../src/cli/source-cli-options.js';

describe('opencode CLI options', () => {
  it('rejects a blank --opencode-db in the CLI validation before the adapter sees it', () => {
    expect(() => createAdaptersFromOptions({ opencodeDb: '  ' })).toThrow(
      '--opencode-db must be a non-empty path',
    );
  });
});
