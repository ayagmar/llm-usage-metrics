// Negative control for tests/tsdoc-presence.test.ts: only `documented` and `internalOnly`
// count as documented.

/** A described export. */
export const documented = 1;

/** @internal */
export const internalOnly = 2;

export const undocumented = 3;

/** */
export const emptyComment = 4;

/** @experimental */
export type tagOnly = string;
