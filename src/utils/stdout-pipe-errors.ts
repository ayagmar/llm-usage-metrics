type ErrorEmitter = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

function isBrokenPipeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPIPE';
}

/**
 * When a reader closes the pipe early (`llm-usage events | head`), further writes fail
 * with EPIPE. The reader already has all the output it wants, so exit quietly with
 * success instead of crashing with an unhandled stream error.
 */
export function exitQuietlyOnBrokenPipe(
  stream: ErrorEmitter,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      exit(0);
      return;
    }

    throw error;
  });
}
