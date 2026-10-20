import { afterEach, describe, expect, it } from 'vitest';

import type { PruneCandidate } from '../../src/cli/run-prune-report.js';
import { renderPruneReport } from '../../src/render/render-prune-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import { markerPalette } from '../helpers/marker-palette.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

let restoreStdout: (() => void) | undefined;

afterEach(() => {
  restoreStdout?.();
  restoreStdout = undefined;
});

const longPath =
  '/home/user/.claude/projects/-home-user-projects-demo-very-long-name/155cf7a6-1b2c-4d5e-8f90-c3b0dcaaebed.jsonl';

function createCandidate(filePath: string): PruneCandidate {
  return {
    source: 'claude',
    filePath,
    eventCount: 12,
    newestTimestamp: '2026-10-01T10:00:00.000Z',
    reasons: ['suppressed'],
  };
}

function render(
  candidates: PruneCandidate[],
  options: { terminalWidth?: number; useColor?: boolean } = {},
): string {
  return renderPruneReport(
    {
      candidates,
      summary: {
        storePath: '/home/user/.cache/llm-usage/events.db',
        applied: false,
        candidateFileCount: candidates.length,
        candidateEventCount: candidates.length * 12,
      },
    },
    { useColor: false, palette: markerPalette, ...options },
  );
}

describe('renderPruneReport', () => {
  it('lists a long path whole on a narrow terminal, with no space where the table wrapped it', () => {
    restoreStdout = overrideStdoutTty(44);

    const output = render([createCandidate(longPath)]);

    expect(output.split('\n')).toContain(`claude · ${longPath}`);
  });

  it('keeps a path on one line when the terminal has room for it', () => {
    const output = render([createCandidate(longPath)], { terminalWidth: 200 });

    expect(output.split('\n').some((line) => line.includes(`│ ${longPath} │`))).toBe(true);
  });

  it('keeps piped paths whole and does not pad short ones to a fixed width', () => {
    const output = render([createCandidate('/tmp/old.jsonl')]);

    expect(output).toContain('│ /tmp/old.jsonl │');
  });

  it('hides the timestamp column before it wraps a path', () => {
    const output = render([createCandidate(longPath)], { terminalWidth: 150 });

    expect(output).not.toContain('Newest Timestamp');
    expect(output).toContain(`│ ${longPath} │`);
  });

  // A listed row's title is the one exception: it keeps the path whole, to copy it.
  it.each([44, 80, 120])('keeps every line but a path title within %i columns', (terminalWidth) => {
    const output = render([createCandidate(longPath), createCandidate('/tmp/old.jsonl')], {
      terminalWidth,
    });
    const tooWide = output.split('\n').filter((line) => visibleWidth(line) > terminalWidth);

    expect(tooWide).toEqual(terminalWidth < 80 ? [`claude · ${longPath}`] : []);
  });

  it('wraps a path to the room the terminal leaves, keeping every character', () => {
    const output = render([createCandidate(longPath)], { terminalWidth: 80 });
    const pathLines = output
      .split('\n')
      .filter((line) => line.startsWith('│ '))
      .slice(2)
      .map((line) => line.split('│')[2].trim());

    expect(pathLines.length).toBeGreaterThan(1);
    expect(pathLines.join('')).toBe(longPath);
  });

  it('says there is nothing to prune instead of drawing an empty table', () => {
    const output = render([]);

    expect(output).toContain('No files to prune.');
    expect(output).not.toContain('╭');
    expect(output).not.toContain('--apply');
  });

  it('colors the source with its hue and the header bold', () => {
    const output = render([createCandidate('/tmp/old.jsonl')], {
      terminalWidth: 120,
      useColor: true,
    });

    expect(output).toContain('│ <blue>claude</blue> │');
    expect(output).toContain('│ <bold>Source</bold> │');
  });
});
