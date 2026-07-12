import { parentPort, Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';

import type { SourceId } from '../domain/usage-event.js';
import { CodexSourceAdapter } from '../sources/codex/codex-source-adapter.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../sources/source-adapter.js';
import { asRecord } from '../utils/as-record.js';

export type ParseWorkerTask = {
  sourceId: SourceId;
  filePath: string;
};

export type ParseWorkerRequestMessage = ParseWorkerTask & {
  taskId: number;
};

export type ParseWorkerResponseMessage =
  | {
      taskId: number;
      ok: true;
      diagnostics: SourceParseFileDiagnostics;
    }
  | {
      taskId: number;
      ok: false;
      error: string;
    };

export type ParseWorkerLike = {
  postMessage(message: ParseWorkerRequestMessage): void;
  terminate(): Promise<unknown>;
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): ParseWorkerLike;
};

export type ParseWorkerSpawner = (entryUrl: URL, options: WorkerOptions) => ParseWorkerLike;

export type ParseWorkerPool = {
  parse(
    task: ParseWorkerTask,
    inlineParse: () => Promise<SourceParseFileDiagnostics>,
  ): Promise<SourceParseFileDiagnostics>;
  status(): 'ready' | 'fallback';
  terminate(): Promise<void>;
};

type PendingParseTask = {
  id: number;
  task: ParseWorkerTask;
  inlineParse: () => Promise<SourceParseFileDiagnostics>;
  resolve: (diagnostics: SourceParseFileDiagnostics) => void;
  reject: (error: unknown) => void;
};

type WorkerSlot = {
  worker: ParseWorkerLike;
  currentTask?: PendingParseTask;
};

type WorkerSourceFactory = () => SourceAdapter;

const parseWorkerSourceRegistry = new Map<SourceId, WorkerSourceFactory>([
  ['codex', () => new CodexSourceAdapter()],
]);

/* v8 ignore start -- Worker-entry helpers run only inside the built CLI bundle. */
function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getDefaultParseFileDiagnostics(events: SourceParseFileDiagnostics['events']) {
  return { events, skippedRows: 0, skippedRowReasons: [] } satisfies SourceParseFileDiagnostics;
}
/* v8 ignore stop */

function isSourceParseFileDiagnostics(value: unknown): value is SourceParseFileDiagnostics {
  const diagnostics = asRecord(value);

  if (!diagnostics || !Array.isArray(diagnostics.events)) {
    return false;
  }

  if (typeof diagnostics.skippedRows !== 'number') {
    return false;
  }

  return (
    diagnostics.skippedRowReasons === undefined || Array.isArray(diagnostics.skippedRowReasons)
  );
}

/* v8 ignore next -- Vitest uses a fake spawner; dist e2e covers real Worker spawn. */
function createWorker(entryUrl: URL, options: WorkerOptions): ParseWorkerLike {
  return new Worker(entryUrl, options);
}

function normalizeWorkerCount(workerCount: number): number {
  if (!Number.isFinite(workerCount) || workerCount <= 0) {
    return 0;
  }

  return Math.floor(workerCount);
}

function readWorkerResponse(message: unknown): ParseWorkerResponseMessage | undefined {
  const response = asRecord(message);

  if (!response || typeof response.taskId !== 'number' || !Number.isInteger(response.taskId)) {
    return undefined;
  }

  if (response.ok === true && isSourceParseFileDiagnostics(response.diagnostics)) {
    return {
      taskId: response.taskId,
      ok: true,
      diagnostics: response.diagnostics,
    };
  }

  if (response.ok === false) {
    return {
      taskId: response.taskId,
      ok: false,
      error: typeof response.error === 'string' ? response.error : 'Worker parse failed',
    };
  }

  return undefined;
}

/* v8 ignore start -- Worker-entry parsing runs only inside the built CLI bundle. */
function readWorkerRequest(message: unknown): ParseWorkerRequestMessage | undefined {
  const request = asRecord(message);

  if (
    !request ||
    typeof request.taskId !== 'number' ||
    !Number.isInteger(request.taskId) ||
    typeof request.sourceId !== 'string' ||
    typeof request.filePath !== 'string'
  ) {
    return undefined;
  }

  return {
    taskId: request.taskId,
    sourceId: request.sourceId,
    filePath: request.filePath,
  };
}
/* v8 ignore stop */

function resolveInline(task: PendingParseTask): void {
  void (async () => {
    try {
      task.resolve(await task.inlineParse());
    } catch (error) {
      task.reject(error);
    }
  })();
}

function createFallbackParseWorkerPool(): ParseWorkerPool {
  return {
    parse: async (_task, inlineParse) => inlineParse(),
    status: () => 'fallback',
    terminate: async () => undefined,
  };
}

export function isParseWorkerRequest(workerData: unknown): boolean {
  return asRecord(workerData)?.llmUsageParseWorker === true;
}

export function canParseSourceOnWorker(sourceId: SourceId): boolean {
  return parseWorkerSourceRegistry.has(sourceId);
}

export function createParseWorkerPool(options: {
  entryUrl: URL;
  workerCount: number;
  spawnWorker?: ParseWorkerSpawner;
}): ParseWorkerPool {
  const workerCount = normalizeWorkerCount(options.workerCount);

  if (workerCount === 0) {
    return createFallbackParseWorkerPool();
  }

  const spawnWorker = options.spawnWorker ?? createWorker;
  const slots: WorkerSlot[] = [];
  const queue: PendingParseTask[] = [];
  let disabled = false;
  let nextTaskId = 1;

  function takePendingTasks(): PendingParseTask[] {
    const pendingTasks = queue.splice(0);

    for (const slot of slots) {
      if (slot.currentTask) {
        pendingTasks.push(slot.currentTask);
        slot.currentTask = undefined;
      }
    }

    return pendingTasks;
  }

  async function terminateWorkers(): Promise<void> {
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  function disablePool(): void {
    if (disabled) {
      return;
    }

    disabled = true;

    for (const task of takePendingTasks()) {
      resolveInline(task);
    }

    void terminateWorkers();
  }

  function dispatch(): void {
    if (disabled) {
      return;
    }

    for (const slot of slots) {
      if (queue.length === 0) {
        return;
      }

      if (slot.currentTask) {
        continue;
      }

      const task = queue.shift();

      if (!task) {
        return;
      }

      slot.currentTask = task;

      try {
        slot.worker.postMessage({
          taskId: task.id,
          sourceId: task.task.sourceId,
          filePath: task.task.filePath,
        });
      } catch {
        disablePool();
        return;
      }
    }
  }

  function handleWorkerMessage(slot: WorkerSlot, message: unknown): void {
    if (disabled) {
      return;
    }

    const response = readWorkerResponse(message);
    const currentTask = slot.currentTask;

    if (!response || response.taskId !== currentTask?.id) {
      disablePool();
      return;
    }

    slot.currentTask = undefined;

    if (response.ok) {
      currentTask.resolve(response.diagnostics);
    } else {
      resolveInline(currentTask);
    }

    dispatch();
  }

  try {
    for (let index = 0; index < workerCount; index += 1) {
      const worker = spawnWorker(options.entryUrl, {
        workerData: {
          llmUsageParseWorker: true,
        },
      });
      const slot: WorkerSlot = { worker };
      worker.on('message', (message) => {
        handleWorkerMessage(slot, message);
      });
      worker.on('error', () => {
        disablePool();
      });
      worker.on('exit', () => {
        disablePool();
      });
      slots.push(slot);
    }
  } catch {
    void terminateWorkers();
    return createFallbackParseWorkerPool();
  }

  return {
    parse: async (task, inlineParse) => {
      if (disabled) {
        return inlineParse();
      }

      return new Promise<SourceParseFileDiagnostics>((resolve, reject) => {
        queue.push({
          id: nextTaskId,
          task,
          inlineParse,
          resolve,
          reject,
        });
        nextTaskId += 1;
        dispatch();
      });
    },
    status: () => (disabled ? 'fallback' : 'ready'),
    terminate: async () => {
      disabled = true;

      for (const task of takePendingTasks()) {
        resolveInline(task);
      }

      await terminateWorkers();
    },
  };
}

/* v8 ignore start -- The worker entry is exercised by built-binary e2e, not in-process Vitest. */
export async function runParseWorker(): Promise<never> {
  const port = parentPort;

  if (!port) {
    throw new Error('Parse worker requires a parent port');
  }

  port.on('message', (message: unknown) => {
    void (async () => {
      const request = readWorkerRequest(message);

      if (!request) {
        return;
      }

      const adapterFactory = parseWorkerSourceRegistry.get(request.sourceId);

      if (!adapterFactory) {
        port.postMessage({
          taskId: request.taskId,
          ok: false,
          error: `Source ${request.sourceId} is not registered for parse workers`,
        } satisfies ParseWorkerResponseMessage);
        return;
      }

      const adapter = adapterFactory();

      try {
        const diagnostics = adapter.parseFileWithDiagnostics
          ? await adapter.parseFileWithDiagnostics(request.filePath)
          : getDefaultParseFileDiagnostics(await adapter.parseFile(request.filePath));

        port.postMessage({
          taskId: request.taskId,
          ok: true,
          diagnostics,
        } satisfies ParseWorkerResponseMessage);
      } catch (error) {
        port.postMessage({
          taskId: request.taskId,
          ok: false,
          error: getErrorReason(error),
        } satisfies ParseWorkerResponseMessage);
      }
    })();
  });

  return new Promise<never>(() => undefined);
}
/* v8 ignore stop */
