import type { EventKind } from '../domain/session-event.js';
import { asRecord } from '../utils/as-record.js';
import { ResumeConflict, type ReplacedEventCounts } from './cursor.js';

// Helpers for the state a stateful adapter keeps in a cursor (`readJsonlFromStatefulCursor`).

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over a string's UTF-16 code units: the form a cursor state keeps ids in. */
export function hashCursorId(id: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), FNV_PRIME);
  }

  return hash >>> 0;
}

function encodeHashes(hashes: ReadonlySet<number>): string {
  const bytes = Buffer.allocUnsafe(hashes.size * 4);
  let offset = 0;

  for (const hash of hashes) {
    bytes.writeUInt32LE(hash, offset);
    offset += 4;
  }

  return bytes.toString('base64');
}

/** The hashes `encodeIdHashes` stored, or undefined when the value is not such a list. */
export function decodeIdHashes(value: unknown): Set<number> | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const bytes = Buffer.from(value, 'base64');

  if (bytes.length % 4 !== 0) {
    return undefined;
  }

  const hashes = new Set<number>();

  for (let offset = 0; offset < bytes.length; offset += 4) {
    hashes.add(bytes.readUInt32LE(offset));
  }

  return hashes;
}

/**
 * The ids a file has used, for a parser that must notice a repeat (first wins, keep last,
 * duplicates). Ids added in this pass are kept exactly; the ids of the passes before the
 * cursor are kept as hashes, so the state stays small. A hash match cannot tell a repeat
 * from a collision, so it throws `ResumeConflict` and the read restarts from byte 0.
 */
export class ResumableIdSet {
  private readonly ids = new Set<string>();

  public constructor(private readonly earlierHashes: ReadonlySet<number> = new Set()) {}

  /** Whether `id` was added; throws `ResumeConflict` when only an earlier hash matches. */
  public has(id: string): boolean {
    if (this.ids.has(id)) {
      return true;
    }

    if (this.earlierHashes.size > 0 && this.earlierHashes.has(hashCursorId(id))) {
      throw new ResumeConflict();
    }

    return false;
  }

  public add(id: string): void {
    this.ids.add(id);
  }

  /** Every id seen so far, as the hashes a cursor state stores. */
  public toState(): string {
    return encodeIdHashes(this.earlierHashes, this.ids);
  }

  public static fromState(value: unknown): ResumableIdSet | undefined {
    const hashes = decodeIdHashes(value);
    return hashes ? new ResumableIdSet(hashes) : undefined;
  }
}

/** `earlierHashes` plus the hashes of `ids`, encoded for a cursor state. */
export function encodeIdHashes(earlierHashes: ReadonlySet<number>, ids: Iterable<string>): string {
  const hashes = new Set(earlierHashes);

  for (const id of ids) {
    hashes.add(hashCursorId(id));
  }

  return encodeHashes(hashes);
}

/** Whether the value is a string, or absent. */
export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Whether the value is a count: a non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isReplacedEventCounts(value: unknown): value is ReplacedEventCounts {
  const counts = asRecord(value);
  return counts !== undefined && Object.values(counts).every(isCount);
}

/**
 * The read's options as a cursor state records them: the kinds, then each option that
 * changes what the parse keeps. A cursor from a read with another key restarts.
 */
export function getReadPlanKey(kinds: ReadonlySet<EventKind>, ...options: boolean[]): string {
  return JSON.stringify([[...kinds].sort(), ...options]);
}
