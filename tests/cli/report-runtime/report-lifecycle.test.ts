import { describe, expect, it, vi } from 'vitest';

import {
  prepareReport,
  runPreparedReport,
} from '../../../src/cli/report-runtime/report-lifecycle.js';
import { RuntimeProfileCollector } from '../../../src/cli/runtime-profile.js';
import * as shareArtifact from '../../../src/cli/share-artifact.js';
import { setLogLevel } from '../../../src/utils/logger.js';

describe('report-lifecycle', () => {
  it('emits the final runtime profile snapshot after render timing is recorded', async () => {
    let nowTick = 0;
    const runtimeProfile = new RuntimeProfileCollector(() => {
      nowTick += 1;
      return nowTick;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const preparedReport = await prepareReport({
        commandOptions: { json: true },
        supportedFormats: ['json'] as const,
        runtimeProfile,
        buildData: async () => ({ value: 'ok' }),
        getDiagnostics: () => ({
          runtimeProfile: runtimeProfile.snapshot(),
        }),
        render: (data) => JSON.stringify(data),
      });

      await runPreparedReport({
        preparedReport,
        getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
      });

      const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(stderrLines.some((line) => line.includes('report.prepare.build_data'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('report.prepare.render'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith('{"value":"ok"}');
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('emits active config after active environment overrides under --verbose', async () => {
    setLogLevel('debug');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runPreparedReport({
        preparedReport: {
          format: 'terminal',
          output: 'report body',
          diagnostics: {
            activeEnvOverrides: [
              {
                name: 'LLM_USAGE_PARSE_WORKERS',
                value: '0',
                description: 'parse worker count',
              },
            ],
            activeConfig: {
              path: '/tmp/config.toml',
              entries: [{ key: 'sources', value: 'codex' }],
            },
          },
        },
        getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
        getActiveConfig: (diagnostics) => diagnostics.activeConfig,
      });

      const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      const envHeaderIndex = stderrLines.findIndex((line) =>
        line.includes('Active environment overrides:'),
      );
      const configHeaderIndex = stderrLines.findIndex((line) =>
        line.includes('Active config: /tmp/config.toml'),
      );

      expect(envHeaderIndex).toBeGreaterThanOrEqual(0);
      expect(configHeaderIndex).toBeGreaterThan(envHeaderIndex);
      expect(
        stderrLines.some((line) =>
          line.includes('LLM_USAGE_PARSE_WORKERS=0  (parse worker count)'),
        ),
      ).toBe(true);
      expect(stderrLines.some((line) => line.includes('sources=codex'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith('report body');
    } finally {
      setLogLevel('info');
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('prints report hints on stderr after the output', async () => {
    const order: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      order.push(`stderr:${String(value)}`);
    });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      order.push(`stdout:${String(value)}`);
    });

    try {
      const preparedReport = await prepareReport({
        commandOptions: {},
        supportedFormats: ['terminal'] as const,
        buildData: async () => ({ hint: 'try --all' }),
        getDiagnostics: () => ({}),
        render: () => 'report body',
        getHintsAfterOutput: (data, format) => [`${data.hint} (${format})`],
      });

      await runPreparedReport({ preparedReport });

      expect(order[0]).toBe('stdout:report body');
      expect(order[1]).toContain('try --all (terminal)');

      order.length = 0;
      const withRenderHints = await prepareReport({
        commandOptions: {},
        supportedFormats: ['terminal'] as const,
        buildData: async () => ({ hint: 'try --all' }),
        getDiagnostics: () => ({}),
        render: () => ({ output: 'narrow body', hintsAfterOutput: ['hid Models'] }),
        getHintsAfterOutput: (data) => [data.hint],
      });

      await runPreparedReport({ preparedReport: withRenderHints });

      expect(order[0]).toBe('stdout:narrow body');
      expect(order[1]).toContain('hid Models');
      expect(order[2]).toContain('try --all');
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  async function runShareReport(open: boolean | undefined) {
    const preparedReport = await prepareReport({
      commandOptions: { share: true, open },
      supportedFormats: ['terminal'] as const,
      buildData: async () => ({}),
      getDiagnostics: () => ({}),
      render: () => 'report body',
      createShareArtifact: () => ({
        fileName: 'usage-share.svg',
        logLabel: 'usage',
        title: 'Usage share card',
        render: (theme) => `<svg data-theme="${theme.name}"/>`,
      }),
    });

    await runPreparedReport({ preparedReport });
  }

  it('writes the dark SVG and a page with both themes, then opens the page', async () => {
    const writeSpy = vi
      .spyOn(shareArtifact, 'writeShareFile')
      .mockImplementation(async (fileName) => `/tmp/${fileName}`);
    const openSpy = vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runShareReport(undefined);

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(writeSpy).toHaveBeenNthCalledWith(1, 'usage-share.svg', '<svg data-theme="dark"/>');
      const [pageName, page] = writeSpy.mock.calls[1] ?? [];
      expect(pageName).toBe('usage-share.html');
      expect(page).toContain('<svg data-theme="dark"/>');
      expect(page).toContain('<svg data-theme="light"/>');
      expect(page).toContain('data-file-base-name="usage-share"');
      expect(openSpy).toHaveBeenCalledWith('/tmp/usage-share.html');
      const stderr = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderr).toContain('Wrote usage share SVG: /tmp/usage-share.svg');
      expect(stderr).toContain('Wrote usage share page: /tmp/usage-share.html');
      expect(stderr).toContain('Opened usage share page: /tmp/usage-share.html');
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('writes the share files without opening them for --no-open', async () => {
    const writeSpy = vi
      .spyOn(shareArtifact, 'writeShareFile')
      .mockImplementation(async (fileName) => `/tmp/${fileName}`);
    const openSpy = vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runShareReport(false);

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('warns but keeps the report when the page cannot be opened', async () => {
    const writeSpy = vi
      .spyOn(shareArtifact, 'writeShareFile')
      .mockImplementation(async (fileName) => `/tmp/${fileName}`);
    const openSpy = vi.spyOn(shareArtifact, 'openShareFile').mockRejectedValue('no opener');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runShareReport(undefined);

      expect(consoleLogSpy).toHaveBeenCalledWith('report body');
      expect(consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'Could not open usage share page: /tmp/usage-share.html (no opener)',
      );
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('rejects --no-open without --share', async () => {
    await expect(
      prepareReport({
        commandOptions: { open: false },
        supportedFormats: ['terminal'] as const,
        buildData: async () => ({}),
        getDiagnostics: () => ({}),
        render: () => 'report body',
      }),
    ).rejects.toThrow('--no-open only applies with --share');
  });
});
