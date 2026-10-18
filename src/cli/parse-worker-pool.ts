import { parentPort, Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';

import type { SourceId } from '@ayagmar/agent-sessions';
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
  /** Tasks posted to the worker, oldest first; it answers them in that order. */
  tasks: PendingParseTask[];
};

/**
 * Tasks a worker holds at once: the one it parses and the next, so it starts the next
 * file while the main thread is still busy (writing the event store) and has not read the
 * last answer yet. A worker parses its tasks one at a time, so its heap holds one file.
 */
const WORKER_TASK_DEPTH = 2;

/**
 * Each worker's young generation. V8's default lets it grow to 128 MB per worker. On a
 * 5.9 GiB synthetic Claude corpus, 2 MB cut a cold run's peak from about 840 to 550 MB
 * with 4 workers and from 850 to 770 MB with 8, at the same parse time within noise.
 */
const WORKER_YOUNG_GENERATION_MB = 2;

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
      pendingTasks.push(...slot.tasks.splice(0));
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
      resourceLimits: { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB },
    });
    const slot: WorkerSlot = { worker, tasks: [] };
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

  /**
   * Finds an idle worker, spawning one only while the pool is below its size; with every
   * worker busy, the least loaded one below its depth takes the task next.
   */
  function takeIdleSlot(): WorkerSlot | undefined {
    const idleSlot = slots.find((slot) => slot.tasks.length === 0);

    if (idleSlot) {
      return idleSlot;
    }

    if (slots.length < workerCount) {
      return spawnSlot();
    }

    let slotWithRoom: WorkerSlot | undefined;

    for (const slot of slots) {
      if (
        slot.tasks.length < WORKER_TASK_DEPTH &&
        (!slotWithRoom || slot.tasks.length < slotWithRoom.tasks.length)
      ) {
        slotWithRoom = slot;
      }
    }

    return slotWithRoom;
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

      slot.tasks.push(task);

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
    const currentTask = slot.tasks.at(0);

    if (!response || response.taskId !== currentTask?.id) {
      disablePool();
      return;
    }

    slot.tasks.shift();

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
  // The pool posts the next task before this one is answered: parse one at a time, in
  // order, so the worker holds one file and answers in the order the pool expects.
  let previousTask = Promise.resolve();

  port.on('message', (message: unknown) => {
    previousTask = previousTask.then(async () => {
      const request = readWorkerRequest(message);

      if (!request) {
        return;
      }

      port.postMessage(await handleParseWorkerRequest(request, adapterCache));
    });
  });

  return new Promise<never>(() => undefined);
}
/* v8 ignore stop */
