import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSessionReport } from '../../src/cli/run-session-report.js';
import type { SessionCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, useGoldenUpdateCheck, WINDOWS_SKIP_REASON } from './golden-harness.js';
import { M12_TIMELINE_GOLDEN_NAMES } from './m12-timeline-names.js';

const [claudeJson, claudeMarkdown, claudeTerminal, codexTerminal, narrowTerminal] =
  M12_TIMELINE_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;
const NARROW_COLUMNS = 50;

// The tools report's fixtures: real claude and codex logs with tool calls and turns.
const FIXTURES = path.resolve('tests/fixtures/tools');

function renderTimeline(
  id: string,
  options: SessionCommandOptions,
  columns?: number,
): Promise<string> {
  const restoreStdout = columns === undefined ? undefined : overrideStdoutTty(columns);

  return buildSessionReport({
    claudeDir: path.join(FIXTURES, 'claude'),
    codexDir: path.join(FIXTURES, 'codex'),
    source: 'claude,codex',
    timezone: 'UTC',
    id: [id],
    timeline: true,
    ...options,
  }).finally(restoreStdout);
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `session timeline goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    useIsolatedEnvironment();
    useBundledPricingOnly();
    useGoldenUpdateCheck(M12_TIMELINE_GOLDEN_NAMES);

    it(`freezes ${claudeJson}`, async () => {
      await expectGolden(claudeJson, await renderTimeline('evt-session', { json: true }));
    });

    it(`freezes ${claudeMarkdown}`, async () => {
      await expectGolden(claudeMarkdown, await renderTimeline('evt-session', { markdown: true }));
    });

    it(`freezes ${claudeTerminal} and ${codexTerminal}`, async () => {
      const claude = await renderTimeline('evt-session', {}, TERMINAL_COLUMNS);

      expect(claude).not.toContain('\u001B[');
      await expectGolden(claudeTerminal, claude);
      await expectGolden(codexTerminal, await renderTimeline('codex-events', {}, TERMINAL_COLUMNS));
    });

    it(`freezes ${narrowTerminal}`, async () => {
      await expectGolden(narrowTerminal, await renderTimeline('evt-session', {}, NARROW_COLUMNS));
    });
  },
);
