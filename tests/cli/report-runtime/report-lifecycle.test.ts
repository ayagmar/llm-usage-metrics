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
});
