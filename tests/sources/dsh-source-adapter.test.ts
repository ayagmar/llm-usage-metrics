import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DshSourceAdapter,
  getDefaultDshSessionsDir,
} from '../../src/sources/dsh/dsh-source-adapter.js';
import {
  createTornTailBytes,
  dshAssistantMessageFixture,
  dshSessionHeader,
  dshTitleRequestFixture,
  resolveDshSessionLogPath,
  writeDshSessionLog,
  type DshSessionHeaderFixture,
} from '../fixtures/dsh/dsh-session-fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

const SESSION_HEADER: DshSessionHeaderFixture = {
  id: 'session-4ef04d32-90e6-4dec-a20b-fd77ccaea338',
  createdAt: 1_789_137_045_495,
  cwd: '/home/dev/projects/llm-usage-metrics',
};

function sessionHeaderLine(): string {
  return JSON.stringify(dshSessionHeader(SESSION_HEADER));
}

function usageLine(params: {
  seq: number;
  time: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}): string {
  return JSON.stringify(
    dshAssistantMessageFixture({
      seq: params.seq,
      time: params.time,
      usage: {
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cacheReadTokens: params.cacheReadTokens ?? 0,
        reasoningTokens: params.reasoningTokens ?? 0,
        totalTokens:
          params.totalTokens ??
          params.inputTokens + params.outputTokens + (params.cacheReadTokens ?? 0),
      },
    }),
  );
}

describe('DshSourceAdapter', () => {
  it('exposes a stable source id and default sessions directory', () => {
    const adapter = new DshSourceAdapter();

    expect(adapter.id).toBe('dsh');
    expect(getDefaultDshSessionsDir({ env: {}, homeDir: '/home/dev' })).toBe(
      path.join('/home/dev', '.dsh', 'sessions'),
    );
  });

  it('resolves the default sessions directory from DSH_HOME', () => {
    expect(getDefaultDshSessionsDir({ env: { DSH_HOME: '/srv/dsh' }, homeDir: '/home/dev' })).toBe(
      path.join('/srv/dsh', 'sessions'),
    );
    expect(getDefaultDshSessionsDir({ env: { DSH_HOME: '~/harness' }, homeDir: '/home/dev' })).toBe(
      path.join('/home/dev', 'harness', 'sessions'),
    );
    expect(getDefaultDshSessionsDir({ env: { DSH_HOME: '  ' }, homeDir: '/home/dev' })).toBe(
      path.join('/home/dev', '.dsh', 'sessions'),
    );
    expect(getDefaultDshSessionsDir({ env: { DSH_HOME: '~' }, homeDir: '/home/dev' })).toBe(
      path.join('/home/dev', 'sessions'),
    );
  });

  it('discovers canonical session logs across roots in deterministic order', async () => {
    const root = await createTempRoot('dsh-discovery-');
    const firstRoot = path.join(root, 'a-sessions');
    const secondRoot = path.join(root, 'b-sessions');
    const missingRoot = path.join(root, 'missing');

    const plainLog = path.join(firstRoot, '--proj-a--', 'session-a', 'session.v3.jsonl');
    const compressedLog = path.join(secondRoot, '--proj-b--', 'session-b', 'session.v3.jsonl.zstd');
    const ignoredLog = path.join(firstRoot, '--proj-a--', 'session-c', 'notes.jsonl');
    const ignoredArchive = path.join(firstRoot, 'session-backup.jsonl.zstd');

    for (const filePath of [plainLog, compressedLog, ignoredLog, ignoredArchive]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '{}\n', 'utf8');
    }

    const adapter = new DshSourceAdapter({
      defaultRootDirs: [secondRoot, firstRoot, missingRoot],
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(plainLog),
      await realpath(compressedLog),
    ]);
  });

  it('scans only the explicit directory and validates required directory overrides', async () => {
    const root = await createTempRoot('dsh-explicit-');
    const explicitRoot = path.join(root, 'sessions');
    const logPath = path.join(explicitRoot, '--proj-a--', 'session-a', 'session.v3.jsonl');
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, '{}\n', 'utf8');

    const adapter = new DshSourceAdapter({ dir: explicitRoot, defaultRootDirs: [root] });
    await expect(adapter.discoverFiles()).resolves.toEqual([await realpath(logPath)]);

    const blankAdapter = new DshSourceAdapter({ dir: '   ', requireDir: true });
    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'DSH sessions directory must be a non-empty path',
    );

    const missingAdapter = new DshSourceAdapter({
      dir: path.join(root, 'absent'),
      requireDir: true,
    });
    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'DSH sessions directory is missing or unreadable',
    );

    const filePath = path.join(root, 'not-a-dir.jsonl');
    await writeFile(filePath, '{}\n', 'utf8');
    const fileAdapter = new DshSourceAdapter({ dir: filePath, requireDir: true });
    await expect(fileAdapter.discoverFiles()).rejects.toThrow(
      `DSH sessions directory is not a directory: ${filePath}`,
    );
  });

  it('parses every appended zstd frame into one event per assistant message', async () => {
    const root = await createTempRoot('dsh-parse-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', SESSION_HEADER.id));

    await writeDshSessionLog({
      filePath: logPath,
      frames: [
        [
          sessionHeaderLine(),
          JSON.stringify({
            type: 'step/start',
            seq: 1,
            time: SESSION_HEADER.createdAt + 1,
            data: { turn: 1, step: 1 },
          }),
        ],
        [
          usageLine({
            seq: 2,
            time: SESSION_HEADER.createdAt + 1_000,
            inputTokens: 883,
            outputTokens: 195,
            cacheReadTokens: 10_624,
            reasoningTokens: 35,
            totalTokens: 11_702,
          }),
          JSON.stringify({
            type: 'tool/call',
            seq: 3,
            time: SESSION_HEADER.createdAt + 1_200,
            data: { turn: 1, step: 1, callId: 'call-1', name: 'bash' },
          }),
        ],
        [
          usageLine({
            seq: 4,
            time: SESSION_HEADER.createdAt + 2_000,
            inputTokens: 2499,
            outputTokens: 235,
            cacheReadTokens: 11_648,
            reasoningTokens: 43,
            totalTokens: 14_382,
          }),
        ],
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.skippedRows).toBe(0);
    expect(result.skippedRowReasons).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'dsh',
      sessionId: SESSION_HEADER.id,
      timestamp: new Date(SESSION_HEADER.createdAt + 1_000).toISOString(),
      repoRoot: '/home/dev/projects/llm-usage-metrics',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      inputTokens: 883,
      outputTokens: 195,
      reasoningTokens: 35,
      cacheReadTokens: 10_624,
      cacheWriteTokens: 0,
      totalTokens: 11_702,
      costMode: 'estimated',
    });
    expect(result.events[1]).toMatchObject({
      timestamp: new Date(SESSION_HEADER.createdAt + 2_000).toISOString(),
      inputTokens: 2499,
      outputTokens: 235,
      cacheReadTokens: 11_648,
      reasoningTokens: 43,
      totalTokens: 14_382,
    });
  });

  it('reads plain uncompressed session logs', async () => {
    const root = await createTempRoot('dsh-plain-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-plain'));

    await writeDshSessionLog({
      filePath: logPath,
      frames: 'plain',
      lines: [
        sessionHeaderLine(),
        usageLine({
          seq: 1,
          time: SESSION_HEADER.createdAt + 500,
          inputTokens: 10,
          outputTokens: 5,
        }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath.replace(/\.zstd$/u, ''));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      sessionId: SESSION_HEADER.id,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('falls back to the session directory name and title request route', async () => {
    const root = await createTempRoot('dsh-fallback-');
    const sessionId = 'session-fallback-0000';
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', sessionId));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        JSON.stringify(dshTitleRequestFixture({ seq: 1, time: SESSION_HEADER.createdAt + 10 })),
        JSON.stringify(
          dshAssistantMessageFixture({
            seq: 2,
            time: SESSION_HEADER.createdAt + 20,
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
            source: {},
          }),
        ),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      sessionId,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      repoRoot: undefined,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
  });

  it('reports per-file skip reasons for structurally invalid rows', async () => {
    const root = await createTempRoot('dsh-skips-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-skips'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        JSON.stringify(
          dshAssistantMessageFixture({
            seq: 2,
            time: SESSION_HEADER.createdAt + 30,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          }),
        ),
        '{"type":"assistant/message","seq":1,',
        JSON.stringify(
          dshAssistantMessageFixture({
            seq: 3,
            time: 'not-a-timestamp',
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          }),
        ),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(3);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'json_parse_error', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });

  it('keeps decoded frames and reports the torn tail of a crashed append', async () => {
    const root = await createTempRoot('dsh-torn-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-torn'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        usageLine({
          seq: 1,
          time: SESSION_HEADER.createdAt + 40,
          inputTokens: 11,
          outputTokens: 4,
        }),
      ],
      trailingBytes: createTornTailBytes(
        '{"type":"assistant/message","seq":9,"data":{"usage":{"inputTokens":5',
      ),
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ inputTokens: 11, outputTokens: 4, totalTokens: 15 });
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'undecodable_jsonl_frame', count: 1 }]);
  });

  it('recovers frames that follow a damaged region of the log', async () => {
    const root = await createTempRoot('dsh-damage-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-damaged'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [sessionHeaderLine()],
      segments: [
        { bytes: Buffer.from('this region is not a zstd frame') },
        {
          frame: [
            usageLine({
              seq: 1,
              time: SESSION_HEADER.createdAt + 50,
              inputTokens: 5,
              outputTokens: 6,
            }),
          ],
        },
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ inputTokens: 5, outputTokens: 6, totalTokens: 11 });
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'undecodable_jsonl_frame', count: 1 }]);
  });

  it('reports an unreadable log when every frame decodes to nothing', async () => {
    const root = await createTempRoot('dsh-empty-frames-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-empty'));
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      logPath,
      Buffer.concat([zstdCompressSync(Buffer.from('')), zstdCompressSync(Buffer.from(''))]),
    );

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'file_parse_failed', count: 1 }]);
  });

  it('propagates unexpected read failures instead of reporting an empty file', async () => {
    const root = await createTempRoot('dsh-read-failure-');
    const adapter = new DshSourceAdapter();

    await expect(
      adapter.parseFileWithDiagnostics(path.join(root, 'session-absent', 'session.v3.jsonl.zstd')),
    ).rejects.toThrow(/ENOENT/u);
  });

  it('ignores a non-object session header that still matches the line prefilter', async () => {
    const root = await createTempRoot('dsh-non-object-');
    const logPath = resolveDshSessionLogPath(path.join(root, 'session-non-object'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        'null',
        usageLine({ seq: 1, time: SESSION_HEADER.createdAt + 90, inputTokens: 3, outputTokens: 3 }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ sessionId: 'session-non-object', totalTokens: 6 });
  });

  it('keeps earlier state when a session header carries unusable fields', async () => {
    const root = await createTempRoot('dsh-header-fallbacks-');
    const sessionId = 'session-header-fallbacks';
    const logPath = resolveDshSessionLogPath(path.join(root, sessionId));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        JSON.stringify({
          type: 'session/title-llm-request',
          seq: 1,
          time: SESSION_HEADER.createdAt + 5,
          data: { provider: 'deepseek-official', model: 'deepseek-flash' },
        }),
        usageLine({ seq: 2, time: SESSION_HEADER.createdAt + 6, inputTokens: 2, outputTokens: 2 }),
        JSON.stringify({ type: 'session', version: 3, id: 7, cwd: '/tmp/from-header' }),
        usageLine({ seq: 3, time: SESSION_HEADER.createdAt + 7, inputTokens: 4, outputTokens: 4 }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      sessionId,
      repoRoot: undefined,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    // A non-string header id must not overwrite the identity resolved earlier,
    // while a usable cwd still contributes repository attribution.
    expect(result.events[1]).toMatchObject({
      sessionId,
      repoRoot: '/tmp/from-header',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
  });

  it('reports an unreadable log instead of throwing when no frame decodes', async () => {
    const root = await createTempRoot('dsh-unreadable-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-broken'));
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, Buffer.from('not a zstd frame at all'), 'binary');

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'file_parse_failed', count: 1 }]);
  });

  it('ignores rows that carry no usage by design', async () => {
    const root = await createTempRoot('dsh-ignored-rows-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-ignored'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        JSON.stringify({
          type: 'system/message',
          seq: 1,
          time: SESSION_HEADER.createdAt + 1,
          data: { turn: 1, step: 1, message: { role: 'system', content: [] } },
        }),
        JSON.stringify({
          type: 'tool/result',
          seq: 2,
          time: SESSION_HEADER.createdAt + 2,
          data: { turn: 1, step: 1, callId: 'call-1', output: 'ok' },
        }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.skippedRowReasons).toEqual([]);
  });

  it('falls back to the log file name outside a session directory', async () => {
    const root = await createTempRoot('dsh-file-fallback-');
    const logPath = resolveDshSessionLogPath(path.join(root, 'snapshot'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        usageLine({ seq: 1, time: SESSION_HEADER.createdAt + 70, inputTokens: 4, outputTokens: 2 }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ sessionId: 'session.v3.jsonl', totalTokens: 6 });
  });

  it('ignores assistant messages without a usage block', async () => {
    const root = await createTempRoot('dsh-usage-less-');
    const logPath = resolveDshSessionLogPath(path.join(root, 'session-usage-less'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        JSON.stringify({
          type: 'assistant/message',
          seq: 1,
          time: SESSION_HEADER.createdAt + 80,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [], source: { kind: 'model' } },
          },
        }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.skippedRowReasons).toEqual([]);
  });

  it('exposes parseFile as a thin wrapper over diagnostics', async () => {
    const root = await createTempRoot('dsh-wrapper-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-wrapper'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        usageLine({ seq: 1, time: SESSION_HEADER.createdAt + 60, inputTokens: 1, outputTokens: 1 }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const events = await adapter.parseFile(logPath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: SESSION_HEADER.id, totalTokens: 2 });
  });

  it('keeps usage events ordered by their log position', async () => {
    const root = await createTempRoot('dsh-order-');
    const logPath = resolveDshSessionLogPath(path.join(root, '--proj--', 'session-order'));

    await writeDshSessionLog({
      filePath: logPath,
      lines: [
        sessionHeaderLine(),
        usageLine({
          seq: 1,
          time: SESSION_HEADER.createdAt + 100,
          inputTokens: 1,
          outputTokens: 1,
        }),
        usageLine({
          seq: 2,
          time: SESSION_HEADER.createdAt + 200,
          inputTokens: 2,
          outputTokens: 2,
        }),
        usageLine({
          seq: 3,
          time: SESSION_HEADER.createdAt + 300,
          inputTokens: 3,
          outputTokens: 3,
        }),
      ],
    });

    const adapter = new DshSourceAdapter();
    const result = await adapter.parseFileWithDiagnostics(logPath);

    expect(result.events.map((event) => event.timestamp)).toEqual([
      new Date(SESSION_HEADER.createdAt + 100).toISOString(),
      new Date(SESSION_HEADER.createdAt + 200).toISOString(),
      new Date(SESSION_HEADER.createdAt + 300).toISOString(),
    ]);
    expect(result.events.map((event) => event.inputTokens)).toEqual([1, 2, 3]);
  });
});
