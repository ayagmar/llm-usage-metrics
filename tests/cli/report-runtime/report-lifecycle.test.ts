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

  it('writes the share SVG without opening it for --no-open', async () => {
    const writeSpy = vi
      .spyOn(shareArtifact, 'writeShareSvgFile')
      .mockResolvedValue('/tmp/usage-share.svg');
    const openSpy = vi.spyOn(shareArtifact, 'writeAndOpenShareSvgFile');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const preparedReport = await prepareReport({
        commandOptions: { share: true, open: false },
        supportedFormats: ['terminal'] as const,
        buildData: async () => ({}),
        getDiagnostics: () => ({}),
        render: () => 'report body',
        createShareArtifact: () => ({
          fileName: 'usage-share.svg',
          svg: '<svg/>',
          logLabel: 'usage',
        }),
      });

      await runPreparedReport({ preparedReport });

      expect(writeSpy).toHaveBeenCalledWith('usage-share.svg', '<svg/>');
      expect(openSpy).not.toHaveBeenCalled();
      expect(
        consoleErrorSpy.mock.calls.some((call) =>
          String(call[0]).includes('Wrote usage share SVG: /tmp/usage-share.svg'),
        ),
      ).toBe(true);
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
