import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  buildMachineExportLines,
  MACHINE_EXPORT_FORMAT,
  parseKnownFiles,
  readMachineExport,
} from '../../src/machines/machine-export-bundle.js';

const header = { cliVersion: '1.0.0', hostname: 'laptop', exportedAt: '2026-10-08T10:00:00.000Z' };

const event = createUsageEvent({
  source: 'codex',
  sessionId: 's1',
  timestamp: '2026-10-08T09:00:00.000Z',
  inputTokens: 10,
  outputTokens: 5,
  // The one-hour share must survive the trip, or the reader underprices it.
  cacheWriteTokens: 8,
  cacheWrite1hTokens: 6,
  costMode: 'estimated',
});

describe('buildMachineExportLines', () => {
  it('sends only files the reader lacks or holds at another revision, and lists every file', () => {
    const lines = buildMachineExportLines(
      header,
      [
        { source: 'codex', filePath: '/a.jsonl', revision: 'r1', events: [event] },
        { source: 'codex', filePath: '/b.jsonl', revision: 'r2', events: [event, event] },
        { source: 'codex', filePath: '/c.jsonl', revision: 'r3', events: [event] },
      ],
      new Map([
        [JSON.stringify(['codex', '/a.jsonl']), 'r1'],
        [JSON.stringify(['codex', '/b.jsonl']), 'old'],
      ]),
    );

    expect(lines.map((line) => line.type)).toEqual(['header', 'file', 'file', 'end']);
    expect(lines[0]).toMatchObject({ format: 'llm-usage-metrics.machine-export', version: 1 });
    expect(lines.slice(1, 3).map((line) => line.type === 'file' && line.filePath)).toEqual([
      '/b.jsonl',
      '/c.jsonl',
    ]);
    expect(lines[3]).toEqual({
      type: 'end',
      files: [
        ['codex', '/a.jsonl', 'r1'],
        ['codex', '/b.jsonl', 'r2'],
        ['codex', '/c.jsonl', 'r3'],
      ],
      eventCount: 4,
    });
  });

  it('leaves out files without events', () => {
    const lines = buildMachineExportLines(header, [
      { source: 'codex', filePath: '/empty.jsonl', revision: 'r1', events: [] },
    ]);

    expect(lines.at(-1)).toEqual({ type: 'end', files: [], eventCount: 0 });
    expect(lines).toHaveLength(2);
  });
});

describe('parseKnownFiles', () => {
  it('reads the files a previous sync holds', () => {
    expect(parseKnownFiles('{"version":1,"files":[["codex","/a.jsonl","r1"]]}')).toEqual(
      new Map([[JSON.stringify(['codex', '/a.jsonl']), 'r1']]),
    );
  });

  it.each([
    ['not json', 'Known files must be JSON'],
    ['{"version":2,"files":[]}', 'Known files must be {"version":1'],
    ['{"version":1}', 'Known files must be {"version":1'],
    ['{"version":1,"files":[["codex","/a.jsonl"]]}', 'Each known file must be'],
    ['{"version":1,"files":[["codex","/a.jsonl",""]]}', 'Each known file must be'],
    ['{"version":1,"files":[["codex","/a.jsonl",1]]}', 'Each known file must be'],
  ])('rejects %s', (text, message) => {
    expect(() => parseKnownFiles(text)).toThrow(message);
  });
});

describe('readMachineExport', () => {
  const headerLine = JSON.stringify({
    type: 'header',
    ...header,
    format: MACHINE_EXPORT_FORMAT,
    version: 1,
  });
  const fileLine = (revision = 'r1', events: unknown[] = [event]) =>
    JSON.stringify({ type: 'file', source: 'codex', filePath: '/a.jsonl', revision, events });
  const endLine = (files: unknown[] = [['codex', '/a.jsonl', 'r1']], eventCount = 1) =>
    JSON.stringify({ type: 'end', files, eventCount });

  async function* linesOf(...lines: string[]): AsyncGenerator<string> {
    for (const line of lines) {
      yield line;
    }
  }

  it('reads a complete bundle after any shell output', async () => {
    const bundle = await readMachineExport(
      linesOf('Welcome to laptop!', headerLine, fileLine(), '', endLine()),
    );

    expect(bundle).toEqual({
      header: { type: 'header', format: MACHINE_EXPORT_FORMAT, version: 1, ...header },
      sentFiles: [
        { type: 'file', source: 'codex', filePath: '/a.jsonl', revision: 'r1', events: [event] },
      ],
      files: [['codex', '/a.jsonl', 'r1']],
      eventCount: 1,
    });
  });

  it.each([
    ['no lines', [], 'no header line'],
    ['no end line', [headerLine, fileLine()], 'ended early (no end line)'],
    [
      'a newer version',
      [JSON.stringify({ type: 'header', format: MACHINE_EXPORT_FORMAT, version: 2 })],
      'exports bundle version 2, but this llm-usage-metrics reads version 1',
    ],
    ['a line after the end', [headerLine, endLine([], 0), endLine([], 0)], 'follows the end line'],
    ['a sent file it does not list', [headerLine, fileLine(), endLine([], 0)], 'does not list it'],
    [
      'a sent file at another revision',
      [headerLine, fileLine('r2'), endLine()],
      'does not list it at that revision',
    ],
    [
      'a file listed twice',
      [
        headerLine,
        endLine(
          [
            ['codex', '/a.jsonl', 'r1'],
            ['codex', '/a.jsonl', 'r1'],
          ],
          2,
        ),
      ],
      'lists /a.jsonl twice',
    ],
    [
      'an event of another source',
      [headerLine, fileLine('r1', [{ ...event, source: 'pi' }]), endLine()],
      'its source is pi, not codex',
    ],
    [
      'an event with a wrong type',
      [headerLine, fileLine('r1', [{ ...event, inputTokens: '10' }]), endLine()],
      'inputTokens is not a non-negative number',
    ],
    ['an unknown line type', [headerLine, JSON.stringify({ type: 'other' })], 'unknown type'],
    ['shell output without a bundle', ['command not found'], 'no header line'],
    ['text that is not JSON', [headerLine, 'ssh: banner'], 'line 2 is not JSON'],
  ])('rejects %s', async (_name, lines, message) => {
    await expect(readMachineExport(linesOf(...lines))).rejects.toThrow(message);
  });
});
