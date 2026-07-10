import { compareByCodePoint } from '../utils/compare-by-code-point.js';

export type NumberLike = number | string | null | undefined;

const CONTROL_CHARACTERS_PATTERN = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F]`, 'gu');

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS_PATTERN, '');
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

export function normalizeTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }

  return date.toISOString();
}

export function normalizeModelList(models: Iterable<string | null | undefined>): string[] {
  const deduplicated = new Set<string>();

  for (const model of models) {
    if (!model) {
      continue;
    }

    const normalized = stripControlCharacters(model).trim();

    if (!normalized) {
      continue;
    }

    deduplicated.add(normalized);
  }

  return [...deduplicated].sort(compareByCodePoint);
}
