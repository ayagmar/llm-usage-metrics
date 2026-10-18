import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readClassifiedJsonlObjects, readJsonlObjects } from '../src/utils/read-jsonl-objects.js';
import { canCountOpenFds, countOpenFds } from './helpers/open-fds.js';

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
      expect.fail(`Unexpected record: ${JSON.stringify(record)}`);
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
      expect.fail(`Unexpected record: ${JSON.stringify(record)}`);
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
        expect.fail(`Unexpected record: ${JSON.stringify(record)}`);
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

  it('keeps reads in progress at once apart after an earlier read', async () => {
    // The CLI parses several files at once on one thread; each read keeps its own chunk.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-interleaved-'));
    tempDirs.push(rootDir);

    const expectedByFile = ['a', 'b'].map((name) =>
      Array.from({ length: 3_000 }, (_, index) => ({
        file: name,
        index,
        text: name.repeat(700 + (index % 97)),
      })),
    );
    const filePaths = expectedByFile.map((_, index) => path.join(rootDir, `${index}.jsonl`));

    await Promise.all(
      filePaths.map((filePath, index) =>
        writeFile(filePath, expectedByFile[index].map((row) => JSON.stringify(row)).join('\n')),
      ),
    );

    const readFirst: Array<Record<string, unknown>> = [];

    for await (const record of readJsonlObjects(filePaths[0])) {
      readFirst.push(record);
    }

    const readers = filePaths.map((filePath) => readJsonlObjects(filePath));
    const recordsByFile: Array<Record<string, unknown>[]> = [[], []];
    let openReads = readers.length;

    while (openReads > 0) {
      openReads = 0;

      for (const [index, reader] of readers.entries()) {
        const next = await reader.next();

        if (!next.done) {
          recordsByFile[index].push(next.value);
          openReads += 1;
        }
      }
    }

    expect(readFirst).toEqual(expectedByFile[0]);
    expect(recordsByFile).toEqual(expectedByFile);
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

  it.runIf(canCountOpenFds)('closes the file before an early return resolves', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-early-return-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'larger-than-a-chunk.jsonl');
    const line = JSON.stringify({ type: 'message', text: 'x'.repeat(1000) });
    await writeFile(filePath, `${line}\n`.repeat(3000), 'utf8');
    const before = countOpenFds();

    for await (const record of readJsonlObjects(filePath)) {
      expect(record.type).toBe('message');
      break;
    }

    // No polling: the generator's return() must not resolve while the fd is open.
    expect(countOpenFds()).toBe(before);
  });

  it('hands a malformed line to the callback as the predicate saw it', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-malformed-input-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    await writeFile(filePath, '\uFEFF {"bad": \r\n{"ok":1}\n', 'utf8');
    const malformedBytes: string[] = [];
    const malformedTexts: string[] = [];

    await collectAll(
      readJsonlObjects(filePath, {
        shouldParseLineBytes: () => true,
        onMalformedLine: (lineBytes) => {
          malformedBytes.push(lineBytes.toString('utf8'));
        },
      }),
    );
    await collectAll(
      readJsonlObjects(filePath, {
        shouldParseLine: () => true,
        onMalformedLine: (lineText) => {
          malformedTexts.push(lineText);
        },
      }),
    );

    // Bytes without the BOM and line ending; text trimmed as well.
    expect(malformedBytes).toEqual([' {"bad": ']);
    expect(malformedTexts).toEqual(['{"bad":']);
  });
});

async function collectAll<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

describe('readClassifiedJsonlObjects', () => {
  const lines = [
    '{"type":"assistant","usage":{}}',
    '{"type":"user"}',
    '{"type":"skip"}',
    '{"type":"assistant","usage":',
  ];

  async function writeLines(): Promise<string> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-classified-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    await writeFile(filePath, lines.join('\n'), 'utf8');
    return filePath;
  }

  const usageBytes = Buffer.from('"usage"');
  const skipBytes = Buffer.from('"skip"');

  it('reports whether the usage prefilter accepted each line, by bytes', async () => {
    const filePath = await writeLines();
    const malformed: boolean[] = [];

    const items = await collectAll(
      readClassifiedJsonlObjects(filePath, {
        shouldParseLineBytes: (lineBytes) => !lineBytes.includes(skipBytes),
        isUsageLineBytes: (lineBytes) => lineBytes.includes(usageBytes),
        onMalformedLine: (lineBytes) => {
          malformed.push(lineBytes.includes(usageBytes));
        },
      }),
    );

    expect(items).toEqual([
      { record: { type: 'assistant', usage: {} }, isUsageLine: true },
      { record: { type: 'user' }, isUsageLine: false },
    ]);
    expect(malformed).toEqual([true]);
  });

  it('reports whether the usage prefilter accepted each line, by text', async () => {
    const filePath = await writeLines();

    const items = await collectAll(
      readClassifiedJsonlObjects(filePath, {
        shouldParseLine: (lineText) => !lineText.includes('"skip"'),
        isUsageLine: (lineText) => lineText.includes('"usage"'),
      }),
    );

    expect(items.map((item) => item.isUsageLine)).toEqual([true, false]);
  });
});

describe('readJsonlObjects with a position', () => {
  const bigLine = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 10) });
  const content = ['{"n":1}', bigLine, '{"n":3}', '{"n":4}'].join('\n') + '\n';

  async function openContent(): Promise<Awaited<ReturnType<typeof open>>> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-position-'));
    tempDirs.push(rootDir);
    const filePath = path.join(rootDir, 'session.jsonl');
    await writeFile(filePath, content, 'utf8');
    return open(filePath, 'r');
  }

  function positionAt(handle: Awaited<ReturnType<typeof open>>, start: number) {
    const lineEnds: number[] = [];
    const chunks: Buffer[] = [];
    return {
      lineEnds,
      chunks,
      position: {
        handle,
        start,
        onChunk: (chunk: Buffer) => chunks.push(chunk),
        onLineEnd: (offset: number) => lineEnds.push(offset),
      },
    };
  }

  it('leaves a caller-owned handle open after a full read', async () => {
    const handle = await openContent();

    try {
      const { lineEnds, chunks, position } = positionAt(handle, 0);
      const records = await collectAll(readJsonlObjects('', { position }));

      expect(records.map((record) => record.n)).toEqual([1, undefined, 3, 4]);
      expect(lineEnds.at(-1)).toBe(Buffer.byteLength(content));
      expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
      await expect(handle.stat()).resolves.toMatchObject({ size: Buffer.byteLength(content) });
    } finally {
      await handle.close();
    }
  });

  it('leaves a caller-owned handle open after the consumer stops early', async () => {
    const handle = await openContent();

    try {
      const { position } = positionAt(handle, 0);

      for await (const record of readJsonlObjects('', { position })) {
        expect(record).toEqual({ n: 1 });
        break;
      }

      await expect(handle.stat()).resolves.toMatchObject({ size: Buffer.byteLength(content) });
    } finally {
      await handle.close();
    }
  });

  it('starts at the given offset and reports line ends from there', async () => {
    const handle = await openContent();

    try {
      const start = content.indexOf('{"n":3}');
      const { lineEnds, position } = positionAt(handle, start);
      const records = await collectAll(readJsonlObjects('', { position }));

      expect(records).toEqual([{ n: 3 }, { n: 4 }]);
      expect(lineEnds).toEqual([start + 8, start + 16]);
    } finally {
      await handle.close();
    }
  });
});
