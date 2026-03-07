import type { NumberLike } from '../domain/normalization.js';

const MIN_PLAUSIBLE_UNIX_SECONDS_ABS = 100_000_000;
const UNIX_SECONDS_ABS_CUTOFF = 10_000_000_000;

export function asTrimmedText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

export function isBlankText(value: string): boolean {
  return value.trim().length === 0;
}

export function toNumberLike(value: unknown): NumberLike {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  return undefined;
}

export function normalizeTimestampCandidate(candidate: unknown): string | undefined {
  if (candidate instanceof Date) {
    return Number.isNaN(candidate.getTime()) ? undefined : candidate.toISOString();
  }

  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    if (Math.abs(candidate) < MIN_PLAUSIBLE_UNIX_SECONDS_ABS) {
      return undefined;
    }

    const timestampMs =
      Math.abs(candidate) <= UNIX_SECONDS_ABS_CUTOFF ? candidate * 1000 : candidate;
    const date = new Date(timestampMs);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    return date.toISOString();
  }

  const normalizedText = asTrimmedText(candidate);

  if (!normalizedText) {
    return undefined;
  }

  const numericTimestamp =
    /^-?\d+$/u.test(normalizedText) && normalizedText.length >= 9 ? Number(normalizedText) : NaN;

  if (Number.isFinite(numericTimestamp)) {
    return normalizeTimestampCandidate(numericTimestamp);
  }

  if (/^-?\d+$/u.test(normalizedText)) {
    return undefined;
  }

  const date = new Date(normalizedText);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}
