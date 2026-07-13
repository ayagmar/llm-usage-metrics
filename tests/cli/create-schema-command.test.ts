import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSchemaCommand } from '../../src/cli/create-schema-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSchemaCommand', () => {
  it('prints the named schema as indented json on stdout', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createSchemaCommand().parseAsync(['usage'], { from: 'user' });

    const output = stdout.mock.calls.map((call) => String(call[0])).join('\n');
    const parsed = JSON.parse(output) as { $id?: string };
    expect(parsed.$id?.endsWith('report-usage.v1.schema.json')).toBe(true);
    expect(output).toContain('\n  ');
  });

  it('lists every schema name with --list', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createSchemaCommand().parseAsync(['--list'], { from: 'user' });

    const names = stdout.mock.calls.map((call) => String(call[0]));
    expect(names).toHaveLength(11);
    expect(names).toContain('usage');
    expect(names).toContain('events-line');
    expect(names).toContain('config');
  });

  it('rejects unknown names with the valid-name list', async () => {
    await expect(createSchemaCommand().parseAsync(['nope'], { from: 'user' })).rejects.toThrow(
      /Unknown schema "nope".*usage/,
    );
  });
});
