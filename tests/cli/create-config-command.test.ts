import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfigCommand, USER_CONFIG_TEMPLATE } from '../../src/cli/create-config-command.js';
import { loadUserConfig } from '../../src/config/user-config.js';

const tempDirs: string[] = [];
const previousConfigPath = process.env.LLM_USAGE_CONFIG_PATH;

afterEach(async () => {
  process.env.LLM_USAGE_CONFIG_PATH = previousConfigPath;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempConfigPath(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'config.toml');
}

function uncommentTemplate(template: string): string {
  return template
    .split('\n')
    .map((line) => {
      const trimmedLine = line.trimStart();

      if (!trimmedLine.startsWith('# ')) {
        return line;
      }

      const uncommentedLine = trimmedLine.slice(2);
      const isConfigLine = uncommentedLine.startsWith('[') || uncommentedLine.includes('=');

      if (!isConfigLine) {
        return line;
      }

      return `${line.slice(0, line.length - trimmedLine.length)}${uncommentedLine}`;
    })
    .join('\n');
}

describe('createConfigCommand', () => {
  it('writes a config template to LLM_USAGE_CONFIG_PATH', async () => {
    const configPath = await createTempConfigPath('config-init-write-');
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createConfigCommand().parseAsync(['init'], { from: 'user' });

    await expect(readFile(configPath, 'utf8')).resolves.toBe(USER_CONFIG_TEMPLATE);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(`Wrote config template: ${configPath}`),
    );
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const configPath = await createTempConfigPath('config-init-existing-');
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    await writeFile(configPath, 'timezone = "UTC"\n', 'utf8');

    await expect(createConfigCommand().parseAsync(['init'], { from: 'user' })).rejects.toThrow(
      `Config file already exists: ${configPath} (use --force to overwrite)`,
    );
    await expect(readFile(configPath, 'utf8')).resolves.toBe('timezone = "UTC"\n');
  });

  it('overwrites an existing config with --force', async () => {
    const configPath = await createTempConfigPath('config-init-force-');
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    await writeFile(configPath, 'timezone = "UTC"\n', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createConfigCommand().parseAsync(['init', '--force'], { from: 'user' });

    await expect(readFile(configPath, 'utf8')).resolves.toBe(USER_CONFIG_TEMPLATE);
  });

  it('writes a template that parses cleanly when every key is uncommented', async () => {
    const configPath = await createTempConfigPath('config-init-template-');
    const uncommentedTemplate = uncommentTemplate(USER_CONFIG_TEMPLATE);

    expect(() => parseToml(uncommentedTemplate)).not.toThrow();

    const loadedConfig = await loadUserConfig({ LLM_USAGE_CONFIG_PATH: configPath }, async () => {
      return uncommentedTemplate;
    });

    expect(loadedConfig.warnings).toEqual([]);
  });
});
