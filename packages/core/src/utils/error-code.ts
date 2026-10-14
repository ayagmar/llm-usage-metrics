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
