import { createMessageEvent, createToolCallEvent } from '@ayagmar/agent-sessions';
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
        {
          source: 'codex',
          filePath: '/a.jsonl',
          revision: 'r1',
          events: [event],
          sessionEvents: [],
        },
        {
          source: 'codex',
          filePath: '/b.jsonl',
          revision: 'r2',
          events: [event, event],
          sessionEvents: [],
        },
        {
          source: 'codex',
          filePath: '/c.jsonl',
          revision: 'r3',
          events: [event],
          sessionEvents: [],
        },
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
      { source: 'codex', filePath: '/empty.jsonl', revision: 'r1', events: [], sessionEvents: [] },
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
  const fileLine = (revision = 'r1', events: unknown[] = [event], extra: object = {}) =>
    JSON.stringify({
      type: 'file',
      source: 'codex',
      filePath: '/a.jsonl',
      revision,
      events,
      ...extra,
    });
  const call = createToolCallEvent({
    source: 'codex',
    sessionId: 's1',
    timestamp: '2026-10-08T09:00:01.000Z',
    toolCallId: 'call-1',
    name: 'exec_command',
    status: 'error',
    completedAt: '2026-10-08T09:00:02.000Z',
    durationMs: 1000,
  });
  const turn = createMessageEvent({
    source: 'codex',
    sessionId: 's1',
    timestamp: '2026-10-08T09:00:00.000Z',
    role: 'user',
    textLength: 12,
  });
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
        {
          type: 'file',
          source: 'codex',
          filePath: '/a.jsonl',
          revision: 'r1',
          events: [event],
        },
      ],
      files: [['codex', '/a.jsonl', 'r1']],
      eventCount: 1,
    });
  });

  it('reads a complete bundle before a logout message', async () => {
    const bundle = await readMachineExport(
      linesOf(headerLine, fileLine(), endLine(), 'Connection to laptop closed. Goodbye!'),
    );

    expect(bundle.files).toEqual([['codex', '/a.jsonl', 'r1']]);
  });

  it('reads tool calls and turns, never their text, and skips kinds it does not keep', async () => {
    const bundle = await readMachineExport(
      linesOf(
        headerLine,
        fileLine('r1', [event], {
          sessionEvents: [
            turn,
            { ...turn, text: 'not stored', raw: { text: 'not stored' } },
            call,
            { ...call, kind: 'session_meta' },
          ],
        }),
        endLine(),
      ),
    );

    expect(bundle.sentFiles[0].sessionEvents).toEqual([turn, turn, call]);
  });

  it('drops a tool call or turn with a value a newer version may add, and keeps the usage', async () => {
    const bundle = await readMachineExport(
      linesOf(
        headerLine,
        fileLine('r1', [event], {
          sessionEvents: [{ ...call, status: 'cancelled' }, { ...turn, role: 'developer' }, call],
        }),
        endLine(),
      ),
    );

    expect(bundle.sentFiles[0]).toMatchObject({ events: [event], sessionEvents: [call] });
  });

  it('keeps which events record one request through an export', async () => {
    const claudeEvent = createUsageEvent({ ...event, source: 'claude', singleRequest: true });
    const droidEvent = createUsageEvent({ ...event, source: 'droid' });
    const lines = buildMachineExportLines(header, [
      {
        source: 'claude',
        filePath: '/c.jsonl',
        revision: 'r1',
        events: [claudeEvent],
        sessionEvents: [],
      },
      {
        source: 'droid',
        filePath: '/d.jsonl',
        revision: 'r1',
        events: [droidEvent],
        sessionEvents: [],
      },
    ]);
    const bundle = await readMachineExport(linesOf(...lines.map((line) => JSON.stringify(line))));

    expect(bundle.sentFiles.map((file) => file.events[0].singleRequest)).toEqual([true, undefined]);
  });

  it("keeps a claude event's message and request ids through an export", async () => {
    const claudeEvent = createUsageEvent({
      ...event,
      source: 'claude',
      messageId: 'msg_1',
      requestId: 'req_1',
    });
    const lines = buildMachineExportLines(header, [
      {
        source: 'claude',
        filePath: '/c.jsonl',
        revision: 'r1',
        events: [claudeEvent],
        sessionEvents: [],
      },
    ]);
    const bundle = await readMachineExport(linesOf(...lines.map((line) => JSON.stringify(line))));

    expect(bundle.sentFiles[0].events).toEqual([claudeEvent]);
  });

  it('flags the events of an export that predates the flag from their source', async () => {
    const claudeEvent = createUsageEvent({ ...event, source: 'claude' });
    const bundle = await readMachineExport(
      linesOf(
        headerLine,
        fileLine('r1', [event]),
        JSON.stringify({
          type: 'file',
          source: 'claude',
          filePath: '/c.jsonl',
          revision: 'r1',
          events: [claudeEvent],
        }),
        endLine(
          [
            ['codex', '/a.jsonl', 'r1'],
            ['claude', '/c.jsonl', 'r1'],
          ],
          2,
        ),
      ),
    );

    expect(bundle.sentFiles.map((file) => [file.source, file.events[0].singleRequest])).toEqual([
      ['codex', undefined],
      ['claude', true],
    ]);
  });

  it('rejects a singleRequest that is not a boolean', async () => {
    await expect(
      readMachineExport(
        linesOf(headerLine, fileLine('r1', [{ ...event, singleRequest: 'yes' }]), endLine()),
      ),
    ).rejects.toThrow('line 2 has an invalid event at index 0: singleRequest is not a boolean');
  });

  it('builds a file line a reader without session events reads unchanged', async () => {
    const lines = buildMachineExportLines(header, [
      {
        source: 'codex',
        filePath: '/a.jsonl',
        revision: 'r1',
        events: [event],
        sessionEvents: [call, turn],
      },
    ]);
    const bundle = await readMachineExport(linesOf(...lines.map((line) => JSON.stringify(line))));

    expect(bundle.sentFiles[0]).toMatchObject({ events: [event], sessionEvents: [call, turn] });
    // eventCount counts usage only, as readers before session events check it.
    expect(bundle.eventCount).toBe(1);
  });

  it.each([
    [{ codex: 'n2.p1', pi: 5, '': 'n1.p1' }, { codex: 'n2.p1' }],
    [{}, {}],
    ['n2.p1', undefined],
    [undefined, undefined],
  ])('reads the parser versions %j of the header as %j', async (parserVersions, expected) => {
    const bundle = await readMachineExport(
      linesOf(
        JSON.stringify({
          type: 'header',
          ...header,
          format: MACHINE_EXPORT_FORMAT,
          version: 1,
          parserVersions,
        }),
        endLine([], 0),
      ),
    );

    expect(bundle.header.parserVersions).toEqual(expected);
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
    [
      'session events that are not a list',
      [headerLine, fileLine('r1', [event], { sessionEvents: {} }), endLine()],
      'line 2 is not a valid file line',
    ],
    [
      'a tool call of another source',
      [
        headerLine,
        fileLine('r1', [event], { sessionEvents: [{ ...call, source: 'pi' }] }),
        endLine(),
      ],
      'invalid session event at index 0: its source is pi, not codex',
    ],
    [
      'a turn with a wrong type',
      [
        headerLine,
        fileLine('r1', [event], { sessionEvents: [{ ...turn, textLength: '12' }] }),
        endLine(),
      ],
      'textLength is not a non-negative number',
    ],
    ['an unknown line type', [headerLine, JSON.stringify({ type: 'other' })], 'unknown type'],
    ['shell output without a bundle', ['command not found'], 'no header line'],
    ['text that is not JSON', [headerLine, 'ssh: banner'], 'line 2 is not JSON'],
  ])('rejects %s', async (_name, lines, message) => {
    await expect(readMachineExport(linesOf(...lines))).rejects.toThrow(message);
  });
});
