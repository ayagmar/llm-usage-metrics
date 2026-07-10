import { describe, expect, it, vi } from 'vitest';

import {
  createParseWorkerPool,
  type ParseWorkerLike,
  type ParseWorkerRequestMessage,
} from '../../src/cli/parse-worker-pool.js';
import type { SourceParseFileDiagnostics } from '../../src/sources/source-adapter.js';

const entryUrl = new URL('file:///tmp/dist/index.js');

class FakeWorker implements ParseWorkerLike {
  public readonly postedMessages: ParseWorkerRequestMessage[] = [];
  public terminateCalls = 0;

  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly errorListeners: Array<(error: unknown) => void> = [];

  public postMessage(message: ParseWorkerRequestMessage): void {
    this.postedMessages.push(message);
  }

  public async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  public on(event: 'message' | 'error', listener: (value: unknown) => void): ParseWorkerLike {
    if (event === 'message') {
      this.messageListeners.push(listener);
      return this;
    }

    this.errorListeners.push(listener);
    return this;
  }

  public emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  public emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

class ThrowingPostWorker extends FakeWorker {
  public override postMessage(message: ParseWorkerRequestMessage): void {
    void message;
    throw new Error('post failed');
  }
}

function createDiagnostics(skippedRows: number): SourceParseFileDiagnostics {
  return {
    events: [],
    skippedRows,
    skippedRowReasons: skippedRows > 0 ? [{ reason: 'file_parse_failed', count: skippedRows }] : [],
  };
}

describe('parse-worker-pool', () => {
  it('uses inline parsing when worker count is disabled', async () => {
    const inlineParse = vi.fn(async () => createDiagnostics(0));
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 0,
      spawnWorker: () => {
        throw new Error('should not spawn');
      },
    });

    await expect(
      pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, inlineParse),
    ).resolves.toEqual(createDiagnostics(0));
    await expect(pool.terminate()).resolves.toBeUndefined();
    expect(inlineParse).toHaveBeenCalledTimes(1);
    expect(pool.status()).toBe('fallback');
  });

  it('fans out tasks to available workers and preserves task results', async () => {
    const workers: FakeWorker[] = [];
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 2,
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });

    const firstResult = pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, async () =>
      createDiagnostics(99),
    );
    const secondResult = pool.parse({ sourceId: 'codex', filePath: '/tmp/b.jsonl' }, async () =>
      createDiagnostics(99),
    );

    expect(workers).toHaveLength(2);
    expect(workers[0].postedMessages).toEqual([
      { taskId: 1, sourceId: 'codex', filePath: '/tmp/a.jsonl' },
    ]);
    expect(workers[1].postedMessages).toEqual([
      { taskId: 2, sourceId: 'codex', filePath: '/tmp/b.jsonl' },
    ]);

    workers[1].emitMessage({
      taskId: 2,
      ok: true,
      diagnostics: createDiagnostics(2),
    });
    workers[0].emitMessage({
      taskId: 1,
      ok: true,
      diagnostics: createDiagnostics(1),
    });

    await expect(firstResult).resolves.toEqual(createDiagnostics(1));
    await expect(secondResult).resolves.toEqual(createDiagnostics(2));
  });

  it('ignores malformed worker messages before a valid response arrives', async () => {
    const worker = new FakeWorker();
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const result = pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, async () =>
      createDiagnostics(99),
    );

    worker.emitMessage({
      taskId: 99,
      ok: true,
      diagnostics: createDiagnostics(99),
    });
    worker.emitMessage({
      taskId: 1,
      ok: true,
      diagnostics: { events: [], skippedRows: 'bad' },
    });
    worker.emitMessage({
      taskId: 1,
      ok: true,
      diagnostics: createDiagnostics(0),
    });

    await expect(result).resolves.toEqual(createDiagnostics(0));
  });

  it('reruns a failed worker task inline', async () => {
    const worker = new FakeWorker();
    const inlineParse = vi.fn(async () => createDiagnostics(3));
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const result = pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, inlineParse);

    worker.emitMessage({
      taskId: 1,
      ok: false,
      error: 'worker parse failed',
    });

    await expect(result).resolves.toEqual(createDiagnostics(3));
    expect(inlineParse).toHaveBeenCalledTimes(1);
    expect(pool.status()).toBe('ready');
  });

  it('rejects when inline fallback parsing also fails', async () => {
    const worker = new FakeWorker();
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const result = pool.parse(
      { sourceId: 'codex', filePath: '/tmp/a.jsonl' },
      async (): Promise<SourceParseFileDiagnostics> => {
        throw new Error('inline failed');
      },
    );

    worker.emitMessage({
      taskId: 1,
      ok: false,
      error: 'worker parse failed',
    });

    await expect(result).rejects.toThrow('inline failed');
  });

  it('disables the pool after a worker error and falls back inline', async () => {
    const worker = new FakeWorker();
    const firstInlineParse = vi.fn(async () => createDiagnostics(1));
    const secondInlineParse = vi.fn(async () => createDiagnostics(2));
    const thirdInlineParse = vi.fn(async () => createDiagnostics(3));
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const firstResult = pool.parse(
      { sourceId: 'codex', filePath: '/tmp/a.jsonl' },
      firstInlineParse,
    );
    const secondResult = pool.parse(
      { sourceId: 'codex', filePath: '/tmp/b.jsonl' },
      secondInlineParse,
    );

    worker.emitError(new Error('worker crashed'));

    await expect(firstResult).resolves.toEqual(createDiagnostics(1));
    await expect(secondResult).resolves.toEqual(createDiagnostics(2));
    await expect(
      pool.parse({ sourceId: 'codex', filePath: '/tmp/c.jsonl' }, thirdInlineParse),
    ).resolves.toEqual(createDiagnostics(3));

    expect(worker.postedMessages).toEqual([
      { taskId: 1, sourceId: 'codex', filePath: '/tmp/a.jsonl' },
    ]);
    expect(firstInlineParse).toHaveBeenCalledTimes(1);
    expect(secondInlineParse).toHaveBeenCalledTimes(1);
    expect(thirdInlineParse).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
    expect(pool.status()).toBe('fallback');
  });

  it('disables the pool when posting a task fails', async () => {
    const worker = new ThrowingPostWorker();
    const inlineParse = vi.fn(async () => createDiagnostics(5));
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    await expect(
      pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, inlineParse),
    ).resolves.toEqual(createDiagnostics(5));

    expect(inlineParse).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
    expect(pool.status()).toBe('fallback');
  });

  it('falls back inline when worker creation fails', async () => {
    const firstWorker = new FakeWorker();
    const inlineParse = vi.fn(async () => createDiagnostics(4));
    let spawnCount = 0;
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 2,
      spawnWorker: vi.fn(() => {
        spawnCount += 1;

        if (spawnCount === 1) {
          return firstWorker;
        }

        throw new Error('spawn failed');
      }),
    });

    await expect(
      pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, inlineParse),
    ).resolves.toEqual(createDiagnostics(4));
    expect(inlineParse).toHaveBeenCalledTimes(1);
    expect(firstWorker.terminateCalls).toBe(1);
    expect(pool.status()).toBe('fallback');
  });

  it('falls back queued work when terminated before completion', async () => {
    const worker = new FakeWorker();
    const inlineParse = vi.fn(async () => createDiagnostics(6));
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const result = pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, inlineParse);
    await pool.terminate();

    await expect(result).resolves.toEqual(createDiagnostics(6));
    expect(inlineParse).toHaveBeenCalledTimes(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it('terminates workers after successful parsing', async () => {
    const worker = new FakeWorker();
    const pool = createParseWorkerPool({
      entryUrl,
      workerCount: 1,
      spawnWorker: () => worker,
    });

    const result = pool.parse({ sourceId: 'codex', filePath: '/tmp/a.jsonl' }, async () =>
      createDiagnostics(99),
    );

    worker.emitMessage({
      taskId: 1,
      ok: true,
      diagnostics: createDiagnostics(0),
    });

    await expect(result).resolves.toEqual(createDiagnostics(0));
    await pool.terminate();

    expect(worker.terminateCalls).toBe(1);
  });
});
