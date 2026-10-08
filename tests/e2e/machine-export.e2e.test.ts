import { cp, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { schemaDocuments } from '../../src/cli/report-schema-registry.js';
import { runEventsReport } from '../../src/cli/run-events-report.js';
import { runMachineExport } from '../../src/cli/run-machine-export.js';
import { openEventStore } from '../../src/persistence/event-store.js';
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

  it('resends a file whose source changed, and keeps listing a deleted file served as history', async () => {
    const first = await exportLines();
    const piFile = path.join(rootDir, 'pi', 'session.jsonl');
    const codexFile = path.join(rootDir, 'codex', 'session.jsonl');
    const later = new Date('2030-01-01T00:00:00.000Z');
    await utimes(codexFile, later, later);
    await rm(piFile);

    const second = await exportLines({ known: '-' }, knownStdin(endLine(first)));

    expect(fileLines(second).map((line) => line.filePath)).toEqual([codexFile]);
    expect(endLine(second).eventCount).toBe(endLine(first).eventCount);
    expect(
      endLine(second)
        .files.map(([, filePath]) => filePath)
        .sort(),
    ).toEqual([codexFile, piFile].sort());
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
          store.database.exec("DELETE FROM files WHERE source = 'pi'");
        }

        return store;
      },
    });

    expect(fileLines(lines).map((line) => line.source)).toEqual(['codex']);
    expect(stderr.mock.calls.flat().join('\n')).toMatch(
      /machine export left out \d+ event\(s\) that reports count but the event store does not hold/,
    );
  });

  it('fails without the event store instead of exporting nothing', async () => {
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');

    await expect(exportLines()).rejects.toThrow('machine export reads the event store');
  });
});
