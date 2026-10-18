import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runToolsReport } from '../../src/cli/run-tools-report.js';
import type { ToolsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { createToolFixtureAdapters } from '../helpers/tool-call-fixtures.js';
import {
  captureStdout,
  expectGolden,
  fixedNow,
  freezeDate,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M12_TOOLS_GOLDEN_NAMES } from './m12-tools-names.js';

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;
const NARROW_COLUMNS = 50;

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`tools goldens (${WINDOWS_SKIP_REASON})`, () => {
  useIsolatedEnvironment();
  useGoldenUpdateCheck(M12_TOOLS_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  function renderTools(options: ToolsCommandOptions, columns?: number): Promise<string> {
    const restoreStdout = columns === undefined ? undefined : overrideStdoutTty(columns);

    return captureStdout(() =>
      runToolsReport(
        { timezone: 'UTC', ...options },
        {
          now: fixedNow,
          createAdapters: () => createToolFixtureAdapters(),
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: '',
            disabledBy: 'configuration',
          }),
        },
      ),
    ).finally(restoreStdout);
  }

  it('freezes reports/tools.json', async () => {
    await expectGolden('reports/tools.json', await renderTools({ json: true }));
  });

  it('freezes reports/tools.md', async () => {
    await expectGolden('reports/tools.md', await renderTools({ markdown: true }));
  });

  it('freezes reports/tools.txt', async () => {
    const output = await renderTools({}, TERMINAL_COLUMNS);

    expect(output).not.toContain('\u001B[');
    await expectGolden('reports/tools.txt', output);
  });

  it('freezes reports/tools-by-source-by-repo.txt', async () => {
    await expectGolden(
      'reports/tools-by-source-by-repo.txt',
      await renderTools({ bySource: true, byRepo: true, top: '5' }, TERMINAL_COLUMNS),
    );
  });

  it('freezes reports/tools-narrow.txt', async () => {
    await expectGolden('reports/tools-narrow.txt', await renderTools({ top: '3' }, NARROW_COLUMNS));
  });

  it('freezes reports/tools-empty.txt and .md', async () => {
    const empty = { source: 'gemini' };

    await expectGolden('reports/tools-empty.txt', await renderTools(empty, TERMINAL_COLUMNS));
    await expectGolden('reports/tools-empty.md', await renderTools({ ...empty, markdown: true }));
  });
});
