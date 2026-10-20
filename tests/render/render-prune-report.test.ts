import { afterEach, describe, expect, it } from 'vitest';

import { renderPruneReport } from '../../src/render/render-prune-report.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

let restoreStdout: (() => void) | undefined;

afterEach(() => {
  restoreStdout?.();
  restoreStdout = undefined;
});

describe('renderPruneReport', () => {
  it('lists a long path whole on a narrow terminal, with no space where the table wrapped it', () => {
    const filePath =
      '/home/user/.claude/projects/-home-user-projects-demo-very-long-name/155cf7a6-1b2c-4d5e-8f90-c3b0dcaaebed.jsonl';
    restoreStdout = overrideStdoutTty(80);

    const output = renderPruneReport({
      candidates: [
        {
          source: 'claude',
          filePath,
          eventCount: 12,
          newestTimestamp: '2026-10-01T10:00:00.000Z',
          reasons: ['suppressed'],
        },
      ],
      summary: {
        storePath: '/home/user/.cache/llm-usage/events.db',
        applied: false,
        candidateFileCount: 1,
        candidateEventCount: 12,
      },
    });

    expect(output.split('\n')).toContain(`claude · ${filePath}`);
  });
});
