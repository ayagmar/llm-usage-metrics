import { Ajv2020 } from 'ajv/dist/2020.js';
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

  it('prints schemas that compile on their own, offline and in strict mode', async () => {
    const listOutput = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createSchemaCommand().parseAsync(['--list'], { from: 'user' });
    const names = listOutput.mock.calls.map((call) => String(call[0]));
    listOutput.mockRestore();

    for (const name of names) {
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await createSchemaCommand().parseAsync([name], { from: 'user' });
      const output = stdout.mock.calls.map((call) => String(call[0])).join('\n');
      stdout.mockRestore();

      const ajv = new Ajv2020({ strict: true });
      expect(() => ajv.compile(JSON.parse(output) as object), name).not.toThrow();
    }
  });

  it('lists every schema name with --list', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createSchemaCommand().parseAsync(['--list'], { from: 'user' });

    const names = stdout.mock.calls.map((call) => String(call[0]));
    expect(names).toHaveLength(19);
    expect(names).toContain('usage');
    expect(names).toContain('share');
    expect(names).toContain('events-line');
    expect(names).toContain('machine-export');
    expect(names).toContain('config');
    expect(names).toContain('config-show');
  });

  it('keeps config for the config file and config-show for the config show report', async () => {
    const printSchemaId = async (name: string): Promise<unknown> => {
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await createSchemaCommand().parseAsync([name], { from: 'user' });
      const output = String(stdout.mock.calls[0]?.[0]);
      stdout.mockRestore();
      return (JSON.parse(output) as { $id?: unknown }).$id;
    };

    await expect(printSchemaId('config')).resolves.toMatch(/config-schema\.json$/u);
    await expect(printSchemaId('config-show')).resolves.toMatch(
      /report-config\.v1\.schema\.json$/u,
    );
  });

  it('rejects unknown names with the valid-name list', async () => {
    await expect(createSchemaCommand().parseAsync(['nope'], { from: 'user' })).rejects.toThrow(
      /Unknown schema "nope".*usage/,
    );
  });
});
