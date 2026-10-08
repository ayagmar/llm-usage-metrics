import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineCommand, createSyncCommand } from '../../src/cli/create-machine-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// The test env points LLM_USAGE_CONFIG_PATH at a missing file, so no machine is configured.
describe('createMachineCommand', () => {
  it('runs machine export with the --known path', async () => {
    const missingPath = path.resolve('tests/fixtures/no-such-known-files.json');

    await expect(
      createMachineCommand().parseAsync(['export', '--known', missingPath], { from: 'user' }),
    ).rejects.toThrow(missingPath);
  });

  it('validates machine add arguments before connecting', async () => {
    await expect(
      createMachineCommand().parseAsync(['add', 'Laptop', 'me@laptop'], { from: 'user' }),
    ).rejects.toThrow('Invalid machine name "Laptop"');
    await expect(
      createMachineCommand().parseAsync(['add', 'laptop', '--', '-oProxyCommand=x'], {
        from: 'user',
      }),
    ).rejects.toThrow('Invalid ssh destination "-oProxyCommand=x"');
  });

  it('lists, removes and syncs against the configured machines', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createMachineCommand().parseAsync(['list'], { from: 'user' });
    await createSyncCommand().parseAsync([], { from: 'user' });
    await expect(
      createMachineCommand().parseAsync(['remove', 'laptop'], { from: 'user' }),
    ).rejects.toThrow('No machine named laptop');
    await expect(createSyncCommand().parseAsync(['laptop'], { from: 'user' })).rejects.toThrow(
      'Unknown machine(s): laptop',
    );

    expect(stdout.mock.calls.map(([line]) => String(line))).toEqual([
      'No machines configured.',
      'Add one with: llm-usage machine add <name> [user@host]',
      'No machines configured. Add one with: llm-usage machine add <name> [user@host]',
    ]);
  });
});
