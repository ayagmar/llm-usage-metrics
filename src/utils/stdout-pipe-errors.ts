import { hasErrorCode } from './error-code.js';

type ErrorEmitter = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

/**
 * When a reader closes the pipe early (`llm-usage events | head`), further writes fail
 * with EPIPE. The reader already has all the output it wants, so exit quietly instead
 * of crashing with an unhandled stream error. `process.exit()` without a code keeps any
 * failure code the command already set.
 */
export function exitQuietlyOnBrokenPipe(
  stream: ErrorEmitter,
  exit: () => void = () => process.exit(),
): void {
  stream.on('error', (error) => {
    if (hasErrorCode(error, 'EPIPE')) {
      exit();
      return;
    }

    throw error;
  });
}
