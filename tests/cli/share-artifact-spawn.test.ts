import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { openShareSvgFile } from '../../src/cli/share-artifact.js';

type EventName = 'spawn' | 'error' | 'close';
type EventHandler = (value?: Error | number | null) => void;

function createMockChildProcess(): {
  child: {
    once: (event: string, cb: EventHandler) => unknown;
    removeListener: (event: string, cb: EventHandler) => unknown;
    unref: () => void;
  };
  emit: (event: EventName, value?: Error | number | null) => void;
  removeListenerSpy: ReturnType<typeof vi.fn>;
  unrefSpy: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<EventName, EventHandler>();
  const removeListenerSpy = vi.fn();
  const unrefSpy = vi.fn();

  const child = {
    once: (event: string, cb: EventHandler): unknown => {
      if (event === 'spawn' || event === 'error' || event === 'close') {
        handlers.set(event, cb);
      }

      return child;
    },
    removeListener: (event: string, cb: EventHandler): unknown => {
      removeListenerSpy(event, cb);
      return child;
    },
    unref: unrefSpy,
  };

  const emit = (event: EventName, value?: Error | number | null): void => {
    const handler = handlers.get(event);
    if (handler) {
      handler(value);
    }
  };

  return {
    child,
    emit,
    removeListenerSpy,
    unrefSpy,
  };
}

describe('share-artifact spawn integration', () => {
  it('resolves as soon as the opener process spawns successfully', async () => {
    const { child, emit, unrefSpy, removeListenerSpy } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const openPromise = openShareSvgFile('/tmp/share.svg', {
      platform: 'darwin',
    });
    emit('spawn');
    await openPromise;

    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/open', ['/tmp/share.svg'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
    expect(removeListenerSpy).toHaveBeenNthCalledWith(1, 'error', expect.any(Function));
    expect(removeListenerSpy).toHaveBeenNthCalledWith(2, 'spawn', expect.any(Function));
  });

  it('rejects when spawn emits error', async () => {
    const { child, emit, removeListenerSpy } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const openPromise = openShareSvgFile('/tmp/share.svg', {
      platform: 'linux',
    });
    emit('error', new Error('spawn failed'));

    await expect(openPromise).rejects.toThrow('spawn failed');
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores close after a successful spawn because the process is detached', async () => {
    const { child, emit, removeListenerSpy } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const openPromise = openShareSvgFile('/tmp/share.svg', {
      platform: 'linux',
    });
    emit('spawn');
    emit('close', 3);

    await expect(openPromise).resolves.toBeUndefined();
    expect(removeListenerSpy).toHaveBeenCalledTimes(2);
  });
});
