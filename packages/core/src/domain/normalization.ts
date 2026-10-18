import { stripVTControlCharacters } from 'node:util';

/** A count or amount as a source may log it. Constructors treat null, undefined and non-finite values as missing. */
export type NumberLike = number | string | null | undefined;

// C0/C1 controls, plus bidi controls and line/paragraph separators, which can reorder
// or break terminal output (Trojan Source-style spoofing) while looking invisible.
const CONTROL_CHARACTER_CLASS = String.raw`[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]`;
const CONTROL_CHARACTERS_PATTERN = new RegExp(CONTROL_CHARACTER_CLASS, 'gu');
const CONTROL_CHARACTER_TEST_PATTERN = new RegExp(CONTROL_CHARACTER_CLASS, 'u');

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS_PATTERN, '');
}

/** Text from another machine or process, made safe to print on one terminal line. */
export function toTerminalLine(value: string): string {
  return stripControlCharacters(stripVTControlCharacters(value).replaceAll(/\s+/gu, ' ')).trim();
}

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTER_TEST_PATTERN.test(value);
}

export function normalizeNonNegativeInteger(value: NumberLike): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.trunc(parsed));
}

export function normalizeUsdCost(value: NumberLike): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(0, parsed);
}

// An ISO 8601 date and time with no offset, which `Date` would read in the machine's zone.
const ZONELESS_ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u;

/**
 * Parses timestamp text as `Date` does, except that an ISO date and time with no offset
 * reads as UTC. Events then do not depend on the zone of the machine that parsed them.
 */
export function parseTimestampText(value: string): Date {
  const text = value.trim();
  return new Date(ZONELESS_ISO_DATE_TIME_PATTERN.test(text) ? `${text}Z` : text);
}

/**
 * Parses a timestamp into an ISO 8601 UTC string; text with no offset reads as UTC. Throws
 * on a value `Date` cannot parse.
 */
export function normalizeTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : parseTimestampText(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }

  return date.toISOString();
}
