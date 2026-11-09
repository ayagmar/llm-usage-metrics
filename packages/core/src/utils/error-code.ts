/** Whether a thrown value is a Node error with one of these `code`s (ENOENT, EEXIST, ...). */
export function hasErrorCode(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

/**
 * Whether a failed create, rename or replace may be a short-lived Windows refusal: EPERM or
 * EACCES while a file is being deleted or another process holds it open, EBUSY while a
 * scanner holds it without delete sharing. Each clears when that handle closes.
 *
 * The platform rule: on POSIX these codes mean a lasting permission problem, so a caller that
 * knows the platform (the CLI's file lock) also checks for win32. `writeFileAtomic` does not:
 * core reads no host state, and passing the platform in would add it to every writer and the
 * pricing fetcher's options. It retries these codes everywhere instead, which only delays a
 * lasting POSIX failure by its short retry budget.
 */
export function isShortLivedWindowsRefusal(error: unknown): error is NodeJS.ErrnoException {
  return hasErrorCode(error, 'EPERM', 'EACCES', 'EBUSY');
}
