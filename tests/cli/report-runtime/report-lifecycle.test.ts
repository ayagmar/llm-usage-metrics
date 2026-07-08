import { describe, expect, it, vi } from 'vitest';

import {
  prepareReport,
  runPreparedReport,
} from '../../../src/cli/report-runtime/report-lifecycle.js';
import { RuntimeProfileCollector } from '../../../src/cli/runtime-profile.js';

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

  it('emits active config after active environment overrides', async () => {
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
                name: 'LLM_USAGE_PARSE_MAX_PARALLEL',
                value: '4',
                description: 'max parallel file parsing',
              },
            ],
            activeConfig: {
              path: '/tmp/config.json',
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
        line.includes('Active config: /tmp/config.json'),
      );

      expect(envHeaderIndex).toBeGreaterThanOrEqual(0);
      expect(configHeaderIndex).toBeGreaterThan(envHeaderIndex);
      expect(
        stderrLines.some((line) =>
          line.includes('LLM_USAGE_PARSE_MAX_PARALLEL=4  (max parallel file parsing)'),
        ),
      ).toBe(true);
      expect(stderrLines.some((line) => line.includes('sources=codex'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith('report body');
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });
});
