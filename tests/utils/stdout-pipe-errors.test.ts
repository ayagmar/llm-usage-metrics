import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { exitQuietlyOnBrokenPipe } from '../../src/utils/stdout-pipe-errors.js';

function createErrnoError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('exitQuietlyOnBrokenPipe', () => {
  it('exits quietly when the reader closes the pipe', () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);

    stream.emit('error', createErrnoError('EPIPE'));

    expect(exit).toHaveBeenCalledOnce();
  });

  it('rethrows other stream errors', () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);

    expect(() => stream.emit('error', createErrnoError('EIO'))).toThrow('write EIO');
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits the process by default, keeping its exit code', () => {
    const stream = new EventEmitter();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      exitQuietlyOnBrokenPipe(stream);
      stream.emit('error', createErrnoError('EPIPE'));

      expect(exit).toHaveBeenCalledWith();
    } finally {
      exit.mockRestore();
    }
  });
});
