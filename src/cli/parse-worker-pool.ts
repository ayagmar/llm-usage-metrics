import { parentPort, Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';

import type { SourceId } from '../domain/usage-event.js';
import {
  canParseSourceOnWorker,
  createWorkerParseAdapter,
  getParseWorkerRoots,
} from '@ayagmar/agent-sessions/registry';
import { collectFile, type SourceAdapter } from '@ayagmar/agent-sessions';
import { asRecord } from '@ayagmar/agent-sessions/internal';
import { getErrorReason } from '../utils/get-error-reason.js';
import {
  collectFileForEventStore,
  withStoreCostModes,
  type ParsedFileForEventStore,
  type StoreParseFileDiagnostics,
} from './parse/stored-session-events.js';

export type ParseWorkerTask = {
  sourceId: SourceId;
  filePath: string;
  /** The resolved roots of the adapter that owns the file; the worker never resolves its own. */
  roots: readonly string[];
  /** Read the file for the event store, with the tool calls and messages it keeps. */
  forEventStore: boolean;
};

export type ParseWorkerRequestMessage = ParseWorkerTask & {
  taskId: number;
};

export type ParseWorkerResponseMessage =
  | {
      taskId: number;
      ok: true;
      diagnostics: StoreParseFileDiagnostics;
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
    inlineParse: () => Promise<ParsedFileForEventStore>,
  ): Promise<ParsedFileForEventStore>;
  status(): 'ready' | 'fallback';
  terminate(): Promise<void>;
};

type PendingParseTask = {
  id: number;
  task: ParseWorkerTask;
  inlineParse: () => Promise<ParsedFileForEventStore>;
  resolve: (diagnostics: ParsedFileForEventStore) => void;
  reject: (error: unknown) => void;
};

type WorkerSlot = {
  worker: ParseWorkerLike;
  currentTask?: PendingParseTask;
};

function isStoreParseFileDiagnostics(value: unknown): value is StoreParseFileDiagnostics {
  const diagnostics = asRecord(value);

  if (!diagnostics || !Array.isArray(diagnostics.events)) {
    return false;
  }

  if (typeof diagnostics.skippedRows !== 'number') {
    return false;
  }

  return (
    (diagnostics.skippedRowReasons === undefined || Array.isArray(diagnostics.skippedRowReasons)) &&
    (diagnostics.sessionEvents === undefined || Array.isArray(diagnostics.sessionEvents))
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

  if (response.ok === true && isStoreParseFileDiagnostics(response.diagnostics)) {
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

export function readWorkerRequest(message: unknown): ParseWorkerRequestMessage | undefined {
  const request = asRecord(message);

  if (
    !request ||
    typeof request.taskId !== 'number' ||
    !Number.isInteger(request.taskId) ||
    typeof request.sourceId !== 'string' ||
    typeof request.filePath !== 'string' ||
    !Array.isArray(request.roots) ||
    !request.roots.every((root): root is string => typeof root === 'string') ||
    typeof request.forEventStore !== 'boolean'
  ) {
    return undefined;
  }

  return {
    taskId: request.taskId,
    sourceId: request.sourceId,
    filePath: request.filePath,
    roots: request.roots,
    forEventStore: request.forEventStore,
  };
}

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

export { canParseSourceOnWorker, getParseWorkerRoots };

export function isParseWorkerRequest(workerData: unknown): boolean {
  return asRecord(workerData)?.llmUsageParseWorker === true;
}

/**
 * One pool serves every worker-eligible source of a run: tasks carry their source and
 * roots. Workers are spawned as tasks are dispatched, never more than `workerCount`.
 */
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

  function spawnSlot(): WorkerSlot {
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
    return slot;
  }

  /** Finds an idle worker, spawning one only while the pool is below its size. */
  function takeIdleSlot(): WorkerSlot | undefined {
    const idleSlot = slots.find((slot) => !slot.currentTask);

    if (idleSlot || slots.length >= workerCount) {
      return idleSlot;
    }

    return spawnSlot();
  }

  function dispatch(): void {
    while (!disabled && queue.length > 0) {
      let slot: WorkerSlot | undefined;

      try {
        slot = takeIdleSlot();
      } catch {
        disablePool();
        return;
      }

      if (!slot) {
        return;
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
          roots: task.task.roots,
          forEventStore: task.task.forEventStore,
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
      currentTask.resolve(withStoreCostModes(response.diagnostics));
    } else {
      resolveInline(currentTask);
    }

    dispatch();
  }

  return {
    parse: async (task, inlineParse) => {
      if (disabled) {
        return inlineParse();
      }

      return new Promise<ParsedFileForEventStore>((resolve, reject) => {
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

/**
 * Parses one request the way a worker does. Adapters are cached per source and roots for
 * the worker's lifetime, so Claude reads a fork parent's keys once across tasks.
 */
export async function handleParseWorkerRequest(
  request: ParseWorkerRequestMessage,
  adapterCache: Map<string, SourceAdapter>,
): Promise<ParseWorkerResponseMessage> {
  const cacheKey = JSON.stringify([request.sourceId, request.roots]);
  let adapter = adapterCache.get(cacheKey);

  if (!adapter) {
    adapter = createWorkerParseAdapter(request.sourceId, request.roots);

    if (!adapter) {
      return {
        taskId: request.taskId,
        ok: false,
        error: `Source ${request.sourceId} is not registered for parse workers`,
      };
    }

    adapterCache.set(cacheKey, adapter);
  }

  try {
    return {
      taskId: request.taskId,
      ok: true,
      diagnostics: request.forEventStore
        ? await collectFileForEventStore(adapter, request.filePath)
        : await collectFile(adapter, request.filePath),
    };
  } catch (error) {
    return {
      taskId: request.taskId,
      ok: false,
      error: getErrorReason(error),
    };
  }
}

/* v8 ignore start -- The worker entry is exercised by built-binary e2e, not in-process Vitest. */
export async function runParseWorker(): Promise<never> {
  const port = parentPort;

  if (!port) {
    throw new Error('Parse worker requires a parent port');
  }

  const adapterCache = new Map<string, SourceAdapter>();

  port.on('message', (message: unknown) => {
    void (async () => {
      const request = readWorkerRequest(message);

      if (!request) {
        return;
      }

      port.postMessage(await handleParseWorkerRequest(request, adapterCache));
    })();
  });

  return new Promise<never>(() => undefined);
}
/* v8 ignore stop */
