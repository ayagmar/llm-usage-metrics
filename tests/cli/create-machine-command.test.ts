import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMachineCommand } from '../../src/cli/create-machine-command.js';

describe('createMachineCommand', () => {
  it('runs machine export with the --known path', async () => {
    const missingPath = path.resolve('tests/fixtures/no-such-known-files.json');

    await expect(
      createMachineCommand().parseAsync(['export', '--known', missingPath], { from: 'user' }),
    ).rejects.toThrow(missingPath);
  });
});
