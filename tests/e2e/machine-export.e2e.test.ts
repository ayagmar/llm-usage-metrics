import { cp, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { schemaDocuments } from '../../src/cli/report-schema-registry.js';
import { runEventsReport } from '../../src/cli/run-events-report.js';
import { runMachineExport } from '../../src/cli/run-machine-export.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  readStoredFileSnapshots,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import type {
  MachineExportEndLine,
  MachineExportFileLine,
  MachineExportLine,
} from '../../src/machines/machine-export-bundle.js';

let rootDir: string;

async function exportLines(
  options: Parameters<typeof runMachineExport>[0] = {},
  stdin?: Readable,
  deps: Parameters<typeof runMachineExport>[1] = {},
): Promise<MachineExportLine[]> {
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  await runMachineExport(options, { ...deps, stdout, stdin });

  return Buffer.concat(chunks)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as MachineExportLine);
}

function fileLines(lines: MachineExportLine[]): MachineExportFileLine[] {
  return lines.filter((line): line is MachineExportFileLine => line.type === 'file');
}

function endLine(lines: MachineExportLine[]): MachineExportEndLine {
  const last = lines.at(-1);

  if (last?.type !== 'end') {
    throw new Error('the bundle has no end line');
  }

  return last;
}

function knownStdin(end: MachineExportEndLine): Readable {
  return Readable.from([JSON.stringify({ version: 1, files: end.files })]);
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'machine-export-'));
  await cp(path.resolve('tests/fixtures/e2e/pi'), path.join(rootDir, 'pi'), { recursive: true });
  await cp(path.resolve('tests/fixtures/e2e/codex'), path.join(rootDir, 'codex'), {
    recursive: true,
  });
  await writeFile(
    path.join(rootDir, 'config.toml'),
    ['sources = ["pi", "codex"]', '[sourceDirs]', 'pi = "pi"', 'codex = "codex"', ''].join('\n'),
  );
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(rootDir, 'config.toml'));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe('machine export e2e', () => {
  it('exports the events a report counts, unpriced, in lines that match the schema', async () => {
    const lines = await exportLines();
    const validate = new Ajv2020({ allErrors: true }).compile(
      schemaDocuments['machine-export'] as object,
    );

    for (const line of lines) {
      expect(validate(line), JSON.stringify(validate.errors)).toBe(true);
    }

    expect(lines[0]).toMatchObject({ type: 'header', hostname: os.hostname() });
    expect(fileLines(lines).map((line) => line.source)).toEqual(['pi', 'codex']);

    const exportedEvents = fileLines(lines).flatMap((line) => line.events);
    expect(endLine(lines).eventCount).toBe(exportedEvents.length);
    // Estimated costs are priced by the reader; explicit source costs travel as-is.
    expect(exportedEvents.filter((event) => event.costMode === 'estimated')).not.toHaveLength(0);
    expect(
      exportedEvents.filter(
        (event) => event.costMode === 'estimated' && event.costUsd !== undefined,
      ),
    ).toEqual([]);

    const reported: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      reported.push(String(chunk));
      return true;
    });
    await runEventsReport({ timezone: 'UTC' });
    const reportedCount = reported.join('').trimEnd().split('\n').length;
    expect(exportedEvents).toHaveLength(reportedCount);
  });

  it('sends nothing again to a reader that holds every file at the same revision', async () => {
    const first = await exportLines();
    const second = await exportLines({ known: '-' }, knownStdin(endLine(first)));

    expect(fileLines(second)).toEqual([]);
    expect(endLine(second)).toEqual(endLine(first));
  });

  it('resends only files whose events changed, and keeps listing a deleted file served as history', async () => {
    const first = await exportLines();
    const piFile = path.join(rootDir, 'pi', 'session.jsonl');
    const codexFile = path.join(rootDir, 'codex', 'session.jsonl');
    const codexLines = (await readFile(codexFile, 'utf8')).trimEnd().split('\n');
    // One more turn: cumulative totals grow a day later.
    const nextTurn = JSON.stringify({
      timestamp: '2026-02-03T08:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 300,
            cached_input_tokens: 70,
            output_tokens: 150,
            reasoning_output_tokens: 30,
            total_tokens: 550,
          },
        },
      },
    });
    await writeFile(codexFile, [...codexLines, nextTurn].join('\n'));
    await rm(piFile);

    const second = await exportLines({ known: '-' }, knownStdin(endLine(first)));

    expect(fileLines(second).map((line) => line.filePath)).toEqual([codexFile]);
    expect(endLine(second).eventCount).toBe(endLine(first).eventCount + 1);
    expect(
      endLine(second)
        .files.map(([, filePath]) => filePath)
        .sort(),
    ).toEqual([codexFile, piFile].sort());
  });

  it('sends nothing for a file touched without new events', async () => {
    const first = await exportLines();
    const later = new Date('2030-01-01T00:00:00.000Z');
    await utimes(path.join(rootDir, 'codex', 'session.jsonl'), later, later);

    expect(fileLines(await exportLines({ known: '-' }, knownStdin(endLine(first))))).toEqual([]);
  });

  it('reads the known files from a path', async () => {
    const first = await exportLines();
    const knownPath = path.join(rootDir, 'known.json');
    await writeFile(knownPath, JSON.stringify({ version: 1, files: endLine(first).files }));

    expect(fileLines(await exportLines({ known: knownPath }))).toEqual([]);
  });

  it('warns when the event store lacks events that reports count', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let opens = 0;
    // The second open is the export's read: drop one counted file from the store first.
    const lines = await exportLines({}, undefined, {
      openEventStore: async (filePath) => {
        const store = await openEventStore(filePath);
        opens += 1;

        if (opens === 2) {
          store.database.exec("DELETE FROM events WHERE source = 'pi'");
        }

        return store;
      },
    });

    expect(fileLines(lines).map((line) => line.source)).toEqual(['codex']);
    expect(stderr.mock.calls.flat().join('\n')).toMatch(
      /machine export left out \d+ event\(s\) that reports count but the event store does not hold/,
    );
  });

  it('leaves out a stored file that failed to parse this run, as reports do', async () => {
    const goodFile = path.join(rootDir, 'good.json');
    const badFile = path.join(rootDir, 'bad.json');
    // Each file holds one session id; "FAIL" makes parsing it throw.
    const adapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => [goodFile, badFile],
      parseFile: async (filePath) => {
        const sessionId = (await readFile(filePath, 'utf8')).trim();

        if (sessionId === 'FAIL') {
          throw new Error('unreadable');
        }

        return [
          createUsageEvent({
            source: 'codex',
            sessionId,
            timestamp: '2026-10-01T10:00:00.000Z',
            inputTokens: 10,
            costMode: 'estimated',
          }),
        ];
      },
    };
    const deps = { createAdapters: () => [adapter] };
    await writeFile(path.join(rootDir, 'config.toml'), 'sources = ["codex"]\n');
    await writeFile(goodFile, 'good');
    await writeFile(badFile, 'bad');
    const first = await exportLines({}, undefined, deps);
    expect(endLine(first).files.map(([, filePath]) => filePath)).toEqual([goodFile, badFile]);

    await writeFile(badFile, 'FAIL');
    const second = await exportLines({ known: '-' }, knownStdin(endLine(first)), deps);

    expect(endLine(second)).toEqual({
      type: 'end',
      files: [endLine(first).files[0]],
      eventCount: 1,
    });
  });

  it('changes a revision when stored events change under the same fingerprint', async () => {
    // Two concurrent runs can store different events for one fingerprint.
    const store = await openEventStore(path.join(rootDir, 'race.db'));
    const fingerprint = { dependencies: [{ path: '/a.jsonl', exists: true, size: 1, mtimeMs: 1 }] };
    const event = (sessionId: string) =>
      createUsageEvent({
        source: 'codex',
        sessionId,
        timestamp: '2026-10-01T10:00:00.000Z',
        costMode: 'estimated',
      });

    try {
      replaceFileEvents(store, {
        source: 'codex',
        filePath: '/a.jsonl',
        fingerprint,
        events: [event('a')],
        skippedRows: 0,
        now: 1,
      });
      const [before] = readStoredFileSnapshots(store, [{ source: 'codex', filePath: '/a.jsonl' }]);
      replaceFileEvents(store, {
        source: 'codex',
        filePath: '/a.jsonl',
        fingerprint,
        events: [event('a'), event('b')],
        skippedRows: 0,
        now: 2,
      });
      const [after] = readStoredFileSnapshots(store, [{ source: 'codex', filePath: '/a.jsonl' }]);

      expect(after.events).toHaveLength(2);
      expect(after.revision).not.toBe(before.revision);
    } finally {
      closeEventStore(store);
    }
  });

  it('fails without the event store instead of exporting nothing', async () => {
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');

    await expect(exportLines()).rejects.toThrow('machine export reads the event store');
  });
});
