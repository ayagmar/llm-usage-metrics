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
      buildShare: async () => ({
        fileName: 'usage-share.html',
        logLabel: 'usage',
        render: () => '<!doctype html><title>report</title>',
      }),
    });

    await runPreparedReport({ preparedReport });
  }

  it('writes one HTML report, then opens it', async () => {
    const writeSpy = vi
      .spyOn(shareArtifact, 'writeShareFile')
      .mockImplementation(async (fileName) => `/tmp/${fileName}`);
    const openSpy = vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runShareReport(undefined);

      expect(writeSpy.mock.calls).toEqual([
        ['usage-share.html', '<!doctype html><title>report</title>'],
      ]);
      expect(openSpy).toHaveBeenCalledWith('/tmp/usage-share.html');
      expect(consoleLogSpy).toHaveBeenCalledWith('report body');
      const stderr = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderr).toContain('Wrote usage share report: /tmp/usage-share.html');
      expect(stderr).toContain('Opened usage share report: /tmp/usage-share.html');
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('builds the share report in its own profiled stage, from the report data', async () => {
    let nowTick = 0;
    const runtimeProfile = new RuntimeProfileCollector(() => {
      nowTick += 1;
      return nowTick;
    });
    const buildShare = vi.fn(async (data: { rows: number }) => ({
      fileName: 'usage-share.html',
      logLabel: 'usage',
      render: () => `<p>${data.rows}</p>`,
    }));

    const preparedReport = await prepareReport({
      commandOptions: { share: true },
      supportedFormats: ['terminal'] as const,
      runtimeProfile,
      buildData: async () => ({ rows: 3 }),
      getDiagnostics: () => ({}),
      render: () => 'report body',
      buildShare,
    });

    expect(buildShare).toHaveBeenCalledWith({ rows: 3 }, { runtimeProfile });
    expect(preparedReport.shareArtifact?.render()).toBe('<p>3</p>');
    expect(runtimeProfile.snapshot().stageTimings.map((stage) => stage.name)).toContain(
      'report.prepare.build_share',
    );
  });

  it('does no share work without --share', async () => {
    const buildShare = vi.fn();

    const preparedReport = await prepareReport({
      commandOptions: {},
      supportedFormats: ['terminal'] as const,
      buildData: async () => ({}),
      getDiagnostics: () => ({}),
      render: () => 'report body',
      buildShare,
    });

    expect(buildShare).not.toHaveBeenCalled();
    expect(preparedReport.shareArtifact).toBeUndefined();
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

      expect(writeSpy).toHaveBeenCalledTimes(1);
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
        'Could not open usage share report: /tmp/usage-share.html (no opener)',
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

  it('rejects --redact without --share', async () => {
    await expect(
      prepareReport({
        commandOptions: { redact: true },
        supportedFormats: ['terminal'] as const,
        buildData: async () => ({}),
        getDiagnostics: () => ({}),
        render: () => 'report body',
      }),
    ).rejects.toThrow('--redact only applies with --share');
  });
});
