import {
  getIsoDayOfWeek,
  getIsoWeekKey,
  getMonthKey,
  parseDateKey,
} from '../../../utils/date-key.js';
import type {
  ShareCostMode,
  ShareCube,
  ShareDictionaries,
  ShareGranularity,
  ShareReportData,
} from '../../types.js';

/** The id of the `<script type="application/json">` element that holds the report payload. */
export const REPORT_DATA_ELEMENT_ID = 'report-data';

export const COST_MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];

export const GRANULARITIES: readonly ShareGranularity[] = ['hour', 'day', 'week', 'month'];

/** A period key of the cube, parsed once: its date, roll-up keys and local hour. */
export type SharePeriod = {
  key: string;
  dateKey: string;
  weekKey: string;
  monthKey: string;
  /** ISO day of week: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** The local hour for an hourly key; null for a daily key (before `meta.hourlyFrom`). */
  hour: number | null;
};

/** A decoded payload: the data as embedded plus its parsed period keys, by period index. */
export type ShareReport = {
  data: ShareReportData;
  periods: SharePeriod[];
  cellCount: number;
};

export type DecodeResult = { ok: true; report: ShareReport } | { ok: false; error: string };

/** Parses the embedded payload text; returns undefined when it is missing or not JSON. */
export function parseReportData(text: string | null | undefined): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDictionaries(value: Json): value is ShareDictionaries {
  return ['periods', 'sources', 'models', 'projects', 'machines'].every((name) =>
    isStringArray(value[name]),
  );
}

function isOptionalDateKey(value: unknown): boolean {
  return value === null || (typeof value === 'string' && parseDateKey(value) !== undefined);
}

function isDateRange(value: Json): boolean {
  return isOptionalDateKey(value.since) && isOptionalDateKey(value.until);
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function isIndexArray(value: unknown, length: number, dictionarySize: number): value is number[] {
  return (
    isNumberArray(value, length) &&
    value.every((index) => Number.isInteger(index) && index >= 0 && index < dictionarySize)
  );
}

/** Parses a `YYYY-MM-DD` or `YYYY-MM-DD HH:00` period key. */
export function parsePeriodKey(key: string): SharePeriod | undefined {
  const dateKey = key.slice(0, 10);
  const parts = parseDateKey(dateKey);

  if (!parts) {
    return undefined;
  }

  let hour: number | null = null;

  if (key.length !== 10) {
    hour = Number(key.slice(11, 13));

    if (
      key.length !== 16 ||
      key[10] !== ' ' ||
      key.slice(13) !== ':00' ||
      !/^\d\d$/u.test(key.slice(11, 13)) ||
      hour > 23
    ) {
      return undefined;
    }
  }

  return {
    key,
    dateKey,
    weekKey: getIsoWeekKey(parts),
    monthKey: getMonthKey(parts),
    weekday: getIsoDayOfWeek(parts),
    hour,
  };
}

function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the cube cannot be read, or undefined when every column has one value per cell, every
 * index is inside its dictionary and every cost column belongs to an available mode.
 */
function findCubeError(
  cube: Json,
  dictionaries: ShareReportData['dictionaries'],
): string | undefined {
  if (!Array.isArray(cube.period)) {
    return 'cube.period is missing';
  }

  const cellCount = cube.period.length;
  const indexColumns = [
    ['period', dictionaries.periods.length],
    ['source', dictionaries.sources.length],
    ['model', dictionaries.models.length],
    ['project', dictionaries.projects.length],
    ['machine', dictionaries.machines.length],
  ] as const;

  for (const [column, size] of indexColumns) {
    if (!isIndexArray(cube[column], cellCount, size)) {
      return `cube.${column} does not index its dictionary for every cell`;
    }
  }

  const measureColumns = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
    'eventCount',
    'activeMs',
  ] as const satisfies readonly (keyof ShareCube)[];

  for (const column of measureColumns) {
    if (!isNumberArray(cube[column], cellCount)) {
      return `cube.${column} does not hold a number for every cell`;
    }
  }

  if (!isRecord(cube.costs)) {
    return 'cube.costs is missing';
  }

  for (const [mode, columns] of Object.entries(cube.costs)) {
    if (
      !COST_MODES.some((costMode) => costMode === mode) ||
      !isRecord(columns) ||
      !Array.isArray(columns.costUsd) ||
      columns.costUsd.length !== cellCount ||
      !columns.costUsd.every(
        (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
      ) ||
      !isNumberArray(columns.incompleteEvents, cellCount)
    ) {
      return `cube.costs.${mode} does not hold a cost for every cell`;
    }
  }

  return undefined;
}

/**
 * Checks the parts of a payload the page computes from, so a hand-edited or truncated file
 * fails with a message instead of drawing wrong numbers. It is not the full schema check.
 */
export function decodeShareReport(value: unknown): DecodeResult {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.report !== 'share') {
    return { ok: false, error: 'Not a version 1 share report' };
  }

  const data = value.data;

  if (
    !isRecord(data) ||
    !isRecord(data.meta) ||
    !isRecord(data.dictionaries) ||
    !isRecord(data.cube)
  ) {
    return { ok: false, error: 'The report data is incomplete' };
  }

  const dictionaries = data.dictionaries;

  if (!isDictionaries(dictionaries)) {
    return { ok: false, error: 'dictionaries are not lists of labels' };
  }

  const meta = data.meta;
  const initialView = meta.initialView;

  if (!isValidTimezone(meta.timezone)) {
    return { ok: false, error: 'meta.timezone is not a known timezone' };
  }

  if (
    !isRecord(meta.window) ||
    !isDateRange(meta.window) ||
    !isRecord(initialView) ||
    !isDateRange(initialView) ||
    !GRANULARITIES.some((granularity) => granularity === initialView.granularity) ||
    !isRecord(meta.filters) ||
    !isOptionalDateKey(meta.hourlyFrom) ||
    !(meta.costMode === null || COST_MODES.some((mode) => mode === meta.costMode))
  ) {
    return { ok: false, error: 'meta is incomplete' };
  }

  if (!Array.isArray(meta.unavailableCostModes)) {
    return { ok: false, error: 'meta.unavailableCostModes is missing' };
  }

  const cubeError = findCubeError(data.cube, dictionaries);

  if (cubeError) {
    return { ok: false, error: cubeError };
  }

  const periods: SharePeriod[] = [];

  for (const key of dictionaries.periods) {
    const period = parsePeriodKey(key);

    if (!period) {
      return { ok: false, error: `Invalid period key: ${key}` };
    }

    periods.push(period);
  }

  if (!isRecord(data.sessions) || !Array.isArray(data.sessions.rows)) {
    return { ok: false, error: 'sessions are missing' };
  }

  const { sources, projects } = dictionaries;

  if (
    !data.sessions.rows.every(
      (row) =>
        isRecord(row) &&
        isIndexArray([row.source], 1, sources.length) &&
        isIndexArray([row.project], 1, projects.length) &&
        Array.isArray(row.machines) &&
        isIndexArray(row.machines, row.machines.length, dictionaries.machines.length) &&
        Array.isArray(row.models) &&
        isIndexArray(row.models, row.models.length, dictionaries.models.length),
    )
  ) {
    return { ok: false, error: 'A session refers to an unknown source or project' };
  }

  if (
    !isRecord(data.blocks) ||
    !Array.isArray(data.blocks.rows) ||
    !data.blocks.rows.every((row) => isRecord(row) && isIndexArray([row.source], 1, sources.length))
  ) {
    return { ok: false, error: 'blocks are missing or refer to an unknown source' };
  }

  // Every part the page computes from was checked above; the rest is display text.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const report = data as ShareReportData;
  return { ok: true, report: { data: report, periods, cellCount: report.cube.period.length } };
}
