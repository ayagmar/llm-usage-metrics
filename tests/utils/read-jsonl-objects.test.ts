import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readJsonlObjects } from '../../src/utils/read-jsonl-objects.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('readJsonlObjects', () => {
  it('streams valid JSON objects and skips malformed lines', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-objects-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        '{"type":"session","id":"a"}',
        'not-json',
        '[1,2,3]',
        '{"type":"message","index":2}',
        '   ',
      ].join('\n'),
      'utf8',
    );

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([
      { type: 'session', id: 'a' },
      { type: 'message', index: 2 },
    ]);
  });

  it('notifies once for a nonblank malformed line without a prefilter', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-malformed-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    let malformedLines = 0;

    await writeFile(filePath, ['not-json', '[1,2,3]', '   '].join('\n'), 'utf8');

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath, {
      onMalformedLine: () => {
        malformedLines++;
      },
    })) {
      records.push(record);
    }

    expect(records).toEqual([]);
    expect(malformedLines).toBe(1);
  });

  it('notifies only for malformed lines that pass the text prefilter', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-malformed-text-filter-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    let malformedLines = 0;

    await writeFile(filePath, ['{"keep":', '{"skip":'].join('\n'), 'utf8');

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLine: (lineText) => lineText.includes('"keep"'),
      onMalformedLine: () => {
        malformedLines++;
      },
    })) {
      void record;
    }

    expect(malformedLines).toBe(1);
  });

  it('notifies only for malformed lines that pass the byte prefilter', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-malformed-byte-filter-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    const keepBytes = Buffer.from('"keep"');
    let malformedLines = 0;

    await writeFile(filePath, ['{"keep":', '{"skip":'].join('\n'), 'utf8');

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLineBytes: (lineBytes) => lineBytes.includes(keepBytes),
      onMalformedLine: () => {
        malformedLines++;
      },
    })) {
      void record;
    }

    expect(malformedLines).toBe(1);
  });

  it('handles UTF-8 BOM on the first JSONL line', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-bom-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'with-bom.jsonl');

    await writeFile(filePath, `\uFEFF${JSON.stringify({ type: 'session', id: 'bom' })}\n`, 'utf8');

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([{ type: 'session', id: 'bom' }]);
  });

  it('scales to many JSONL lines without loading malformed data', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-many-lines-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'many-lines.jsonl');
    const lineCount = 10_000;
    const lines = Array.from({ length: lineCount }, (_, index) =>
      JSON.stringify({ type: 'message', index }),
    );

    await writeFile(filePath, lines.join('\n'), 'utf8');

    let count = 0;

    for await (const record of readJsonlObjects(filePath)) {
      if (record.type === 'message') {
        count += 1;
      }
    }

    expect(count).toBe(lineCount);
  });

  it('propagates file read errors', async () => {
    const missingPath = path.join(os.tmpdir(), `read-jsonl-missing-${Date.now()}.jsonl`);

    await expect(async () => {
      for await (const record of readJsonlObjects(missingPath)) {
        void record;
      }
    }).rejects.toThrow();
  });

  it('supports raw-line parse filtering before JSON.parse', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-filter-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'filter.jsonl');

    await writeFile(
      filePath,
      [
        '{"type":"session","id":"a"}',
        '{"type":"message","text":"keep"}',
        '{"type":"message","text":"skip"}',
      ].join('\n'),
      'utf8',
    );

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLine: (lineText) => lineText.includes('"text":"keep"'),
    })) {
      records.push(record);
    }

    expect(records).toEqual([{ type: 'message', text: 'keep' }]);
  });

  it('parses CRLF-terminated JSONL files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-crlf-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'crlf.jsonl');

    await writeFile(
      filePath,
      ['{"type":"session","id":"a"}', '{"type":"message","index":2}'].join('\r\n'),
      'utf8',
    );

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([
      { type: 'session', id: 'a' },
      { type: 'message', index: 2 },
    ]);
  });

  it('parses the final line when it has no trailing newline', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-final-line-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'final-line.jsonl');

    await writeFile(
      filePath,
      ['{"type":"session","id":"a"}', '{"type":"message","index":2}'].join('\n'),
      'utf8',
    );

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([
      { type: 'session', id: 'a' },
      { type: 'message', index: 2 },
    ]);
  });

  it('parses a single JSONL line larger than the stream chunk size', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-large-line-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'large-line.jsonl');
    const text = 'x'.repeat(300 * 1024);

    await writeFile(filePath, `${JSON.stringify({ type: 'message', text })}\n`, 'utf8');

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([{ type: 'message', text }]);
  });

  it('supports byte-level parse filtering before utf8 decoding', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-byte-filter-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'byte-filter.jsonl');
    const keepBytes = Buffer.from('"text":"keep"');

    await writeFile(
      filePath,
      [
        '{"type":"session","id":"a"}',
        '{"type":"message","text":"keep"}',
        '{"type":"message","text":"skip"}',
      ].join('\n'),
      'utf8',
    );

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLineBytes: (lineBytes) => lineBytes.includes(keepBytes),
    })) {
      records.push(record);
    }

    expect(records).toEqual([{ type: 'message', text: 'keep' }]);
  });

  it('treats U+2028 inside a JSON string as content instead of a line terminator', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-line-separator-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'line-separator.jsonl');

    await writeFile(filePath, '{"type":"message","text":"before\u2028after"}\n', 'utf8');

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([{ type: 'message', text: 'before\u2028after' }]);
  });

  it('strips a UTF-8 BOM before byte-level parse filtering', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-bom-byte-filter-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'bom-byte-filter.jsonl');
    const keepBytes = Buffer.from('"id":"bom"');
    let firstByte: number | undefined;

    await writeFile(filePath, `\uFEFF${JSON.stringify({ type: 'session', id: 'bom' })}\n`, 'utf8');

    const records: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLineBytes: (lineBytes) => {
        firstByte = lineBytes[0];
        return lineBytes.includes(keepBytes);
      },
    })) {
      records.push(record);
    }

    expect(firstByte).toBe('{'.charCodeAt(0));
    expect(records).toEqual([{ type: 'session', id: 'bom' }]);
  });
});
