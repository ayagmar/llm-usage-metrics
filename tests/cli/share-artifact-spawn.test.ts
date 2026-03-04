import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { openShareSvgFile } from '../../src/cli/share-artifact.js';

type EventName = 'spawn' | 'error';
type EventHandler = (error?: Error) => void;

function createMockChildProcess(): {
  child: { once: (event: string, cb: EventHandler) => unknown; unref: () => void };
  emit: (event: EventName, error?: Error) => void;
  unrefSpy: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<EventName, EventHandler>();
  const unrefSpy = vi.fn();

  const child = {
    once: (event: string, cb: EventHandler): unknown => {
      if (event === 'spawn' || event === 'error') {
        handlers.set(event, cb);
      }

      return child;
    },
    unref: unrefSpy,
  };

  const emit = (event: EventName, error?: Error): void => {
    const handler = handlers.get(event);
    if (handler) {
      handler(error);
    }
  };

  return {
    child,
    emit,
    unrefSpy,
  };
}

describe('share-artifact spawn integration', () => {
  it('uses default spawnDetached path and resolves on spawn event', async () => {
    const { child, emit, unrefSpy } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const openPromise = openShareSvgFile('/tmp/share.svg', {
      platform: 'darwin',
    });
    emit('spawn');
    await openPromise;

    expect(spawnMock).toHaveBeenCalledWith('open', ['/tmp/share.svg'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when spawn emits error', async () => {
    const { child, emit } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const openPromise = openShareSvgFile('/tmp/share.svg', {
      platform: 'linux',
    });
    emit('error', new Error('spawn failed'));

    await expect(openPromise).rejects.toThrow('spawn failed');
  });
});
