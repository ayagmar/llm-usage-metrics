import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  buildMachineExportLines,
  parseKnownFiles,
} from '../../src/machines/machine-export-bundle.js';

const header = { cliVersion: '1.0.0', hostname: 'laptop', exportedAt: '2026-10-08T10:00:00.000Z' };

const event = createUsageEvent({
  source: 'codex',
  sessionId: 's1',
  timestamp: '2026-10-08T09:00:00.000Z',
  inputTokens: 10,
  outputTokens: 5,
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
