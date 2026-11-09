/**
 * Appends `items` to `target` one at a time. `target.push(...items)` passes each item as an
 * argument and overflows the stack past about 125k of them.
 */
export function appendAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) {
    target.push(item);
  }
}
