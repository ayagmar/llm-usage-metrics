import { getEventSessionKey, type ToolCallEvent } from '@ayagmar/agent-sessions';

import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import { toProjectKey } from '../aggregate/project-key.js';

/** Call counts shared by a tool row and the totals. */
export type ToolCallCounts = {
  calls: number;
  /** Calls whose result records an error. */
  errors: number;
  /** Calls without a result in their file, or with a status the source does not map. */
  unknown: number;
  /** `errors` over the calls with a known status; null when none has one. */
  errorRate: number | null;
  /** Distinct sessions that made at least one of the calls. */
  sessions: number;
};

export type ToolRow = ToolCallCounts & {
  name: string;
  /** With --by-source. */
  source?: string;
  /** With --by-repo: the project key, null for sessions without a repository root. */
  repoRoot?: string | null;
  /** The project key that made most of the calls, null for sessions without a root. */
  topRepoRoot: string | null;
};

export type ToolTotals = ToolCallCounts & {
  /** Distinct tool names. */
  tools: number;
};

export type AggregateToolsOptions = {
  /** Session key (`getEventSessionKey`) to repository root; a session missing here has none. */
  sessionRepoRoots: ReadonlyMap<string, string | undefined>;
  bySource?: boolean;
  byRepo?: boolean;
};

type CountAccumulator = {
  calls: number;
  errors: number;
  unknown: number;
  sessions: Set<string>;
};

type RowAccumulator = CountAccumulator & {
  name: string;
  source?: string;
  repoRoot?: string | null;
  callsByRepoRoot: Map<string | null, number>;
};

function createCountAccumulator(): CountAccumulator {
  return { calls: 0, errors: 0, unknown: 0, sessions: new Set() };
}

function addCall(accumulator: CountAccumulator, call: ToolCallEvent, sessionKey: string): void {
  accumulator.calls += 1;
  accumulator.errors += call.status === 'error' ? 1 : 0;
  accumulator.unknown += call.status === 'unknown' ? 1 : 0;
  accumulator.sessions.add(sessionKey);
}

function toCounts(accumulator: CountAccumulator): ToolCallCounts {
  const known = accumulator.calls - accumulator.unknown;

  return {
    calls: accumulator.calls,
    errors: accumulator.errors,
    unknown: accumulator.unknown,
    errorRate: known === 0 ? null : accumulator.errors / known,
    sessions: accumulator.sessions.size,
  };
}

/** Most calls, then the key in code-point order with no root last. */
function findTopRepoRoot(callsByRepoRoot: ReadonlyMap<string | null, number>): string | null {
  let top: [string | null, number] | undefined;

  for (const entry of callsByRepoRoot) {
    if (
      top === undefined ||
      entry[1] > top[1] ||
      (entry[1] === top[1] && compareRepoRoots(entry[0], top[0]) < 0)
    ) {
      top = entry;
    }
  }

  return top?.[0] ?? null;
}

function compareRepoRoots(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null || right === null) {
    return left === null ? 1 : -1;
  }

  return compareByCodePoint(left, right);
}

/**
 * One row per tool name (split by source and project when asked), most calls first, then
 * by name, source and project; and the totals over every call.
 */
export function aggregateTools(
  calls: readonly ToolCallEvent[],
  options: AggregateToolsOptions,
): { rows: ToolRow[]; totals: ToolTotals } {
  const rows = new Map<string, RowAccumulator>();
  const totals = createCountAccumulator();
  const names = new Set<string>();

  for (const call of calls) {
    const sessionKey = getEventSessionKey(call);
    const repoRoot = toProjectKey(options.sessionRepoRoots.get(sessionKey)) ?? null;
    const source = options.bySource ? call.source : undefined;
    const rowRepoRoot = options.byRepo ? repoRoot : undefined;
    const key = [call.name, source ?? '', rowRepoRoot ?? ''].join('\0');
    let row = rows.get(key);

    if (!row) {
      row = {
        ...createCountAccumulator(),
        name: call.name,
        ...(source === undefined ? {} : { source }),
        ...(rowRepoRoot === undefined ? {} : { repoRoot: rowRepoRoot }),
        callsByRepoRoot: new Map(),
      };
      rows.set(key, row);
    }

    addCall(row, call, sessionKey);
    row.callsByRepoRoot.set(repoRoot, (row.callsByRepoRoot.get(repoRoot) ?? 0) + 1);
    addCall(totals, call, sessionKey);
    names.add(call.name);
  }

  const toolRows = [...rows.values()].map((row): ToolRow => ({
    name: row.name,
    ...(row.source === undefined ? {} : { source: row.source }),
    ...(row.repoRoot === undefined ? {} : { repoRoot: row.repoRoot }),
    ...toCounts(row),
    topRepoRoot: findTopRepoRoot(row.callsByRepoRoot),
  }));

  toolRows.sort(
    (left, right) =>
      right.calls - left.calls ||
      compareByCodePoint(left.name, right.name) ||
      compareByCodePoint(left.source ?? '', right.source ?? '') ||
      compareRepoRoots(left.repoRoot ?? null, right.repoRoot ?? null),
  );

  return { rows: toolRows, totals: { ...toCounts(totals), tools: names.size } };
}
