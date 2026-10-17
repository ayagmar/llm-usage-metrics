import { markdownTable } from 'markdown-table';

import type { SessionRow } from '../session/session-row.js';
import type {
  SessionTimelineRow,
  TimelineMessageRow,
  TimelineToolCallRow,
  TimelineUsageRow,
} from '../session/session-timeline.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { formatDuration } from './format-duration.js';
import { formatLocalDateTime, formatLocalDateTimeSpan } from './format-local-date-time.js';
import { formatApproxUsd, formatInteger, formatUsd, pluralize } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';
import { columnKindsFromAlign, renderUnicodeTable } from './unicode-table.js';

export type RenderSessionTimelineOptions = {
  timezone: string;
  useColor: boolean;
  projectLabel: string;
};

const EVENT_COLUMN_INDEX = 1;
const EVENT_COLUMN_WIDTH = 40;

const timelineHeaders = [
  'Time',
  'Event',
  'Input',
  'Cache Read',
  'Cache Write',
  'Output',
  'Cost',
  'Running',
] as const;

const timelineAlign: ('l' | 'r')[] = ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'];

type LiveRow = TimelineToolCallRow | TimelineMessageRow;

/** A request, or the live rows between two requests folded into one line. */
type DisplayRow = TimelineUsageRow | { kind: 'folded'; rows: LiveRow[] };

function foldLiveRows(rows: readonly SessionTimelineRow[]): DisplayRow[] {
  const displayRows: DisplayRow[] = [];

  for (const row of rows) {
    // Turn counts are user and assistant turns; system messages are not turns.
    if (row.kind === 'message' && row.role === 'system') {
      continue;
    }

    if (row.kind === 'usage') {
      displayRows.push(row);
      continue;
    }

    const last = displayRows.at(-1);

    if (last?.kind === 'folded') {
      last.rows.push(row);
    } else {
      displayRows.push({ kind: 'folded', rows: [row] });
    }
  }

  return displayRows;
}

/** `Bash ×7, Read ×5`: most-called first, then by name. */
function formatToolNameCounts(toolCalls: readonly TimelineToolCallRow[]): string {
  const counts = new Map<string, number>();

  for (const toolCall of toolCalls) {
    counts.set(toolCall.name, (counts.get(toolCall.name) ?? 0) + 1);
  }

  return [...counts]
    .sort(
      ([leftName, left], [rightName, right]) =>
        right - left || compareByCodePoint(leftName, rightName),
    )
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
}

/** `1 user turn · 12 tool calls: Bash ×7, Read ×5, 1 error`. */
function formatFoldedRows(rows: readonly LiveRow[]): string {
  const toolCalls = rows.filter((row): row is TimelineToolCallRow => row.kind === 'tool_call');
  const messages = rows.filter((row): row is TimelineMessageRow => row.kind === 'message');
  const userTurns = messages.filter((row) => row.role === 'user').length;
  const assistantTurns = messages.filter((row) => row.role === 'assistant').length;
  const errors = toolCalls.filter((row) => row.status === 'error').length;
  const parts: string[] = [];

  if (userTurns > 0) {
    parts.push(pluralize(userTurns, 'user turn'));
  }

  if (assistantTurns > 0) {
    parts.push(pluralize(assistantTurns, 'assistant turn'));
  }

  if (toolCalls.length > 0) {
    const errorText = errors > 0 ? `, ${pluralize(errors, 'error')}` : '';
    parts.push(
      `${pluralize(toolCalls.length, 'tool call')}: ${formatToolNameCounts(toolCalls)}${errorText}`,
    );
  }

  return parts.join(' · ');
}

function toTableCells(row: DisplayRow, timezone: string): string[] {
  if (row.kind === 'folded') {
    return [
      formatLocalDateTime(row.rows[0].timestamp, timezone),
      formatFoldedRows(row.rows),
      '',
      '',
      '',
      '',
      '',
      '',
    ];
  }

  return [
    formatLocalDateTime(row.timestamp, timezone),
    row.model ?? '-',
    formatInteger(row.inputTokens),
    formatInteger(row.cacheReadTokens),
    formatInteger(row.cacheWriteTokens),
    formatInteger(row.outputTokens),
    formatUsd(row.costUsd),
    formatApproxUsd(row.runningCostUsd, row.runningCostIncomplete),
  ];
}

function buildBodyRows(rows: readonly SessionTimelineRow[], timezone: string): string[][] {
  return foldLiveRows(rows).map((row) => toTableCells(row, timezone));
}

/** `claude · <id> · <project>` and the span, request count and cost. */
function formatSessionLines(session: SessionRow, options: RenderSessionTimelineOptions): string[] {
  const span = formatLocalDateTimeSpan(
    session.firstActivity,
    session.lastActivity,
    options.timezone,
  );

  return [
    `${session.source} · ${session.sessionId} · ${options.projectLabel}`,
    [
      `${span} (${formatDuration(session.durationMs)})`,
      pluralize(session.eventCount, 'request'),
      formatApproxUsd(session.costUsd, session.costIncomplete),
    ].join(' · '),
  ];
}

export function renderTerminalSessionTimeline(
  session: SessionRow,
  rows: readonly SessionTimelineRow[],
  options: RenderSessionTimelineOptions,
): string {
  const bodyRows = wrapTableColumn(buildBodyRows(rows, options.timezone), {
    columnIndex: EVENT_COLUMN_INDEX,
    width: EVENT_COLUMN_WIDTH,
  });

  return [
    renderReportHeader({ title: 'Session Timeline', useColor: options.useColor }),
    '',
    ...formatSessionLines(session, options),
    '',
    renderUnicodeTable({
      headerCells: timelineHeaders,
      bodyRows,
      measureHeaderCells: timelineHeaders,
      measureBodyRows: bodyRows,
      rowMetas: bodyRows.map(() => ({ periodKey: '', rowKind: 'detail' })),
      layout: 'top_aligned',
      columnKinds: columnKindsFromAlign(timelineAlign),
      multilineColumnIndex: EVENT_COLUMN_INDEX,
      multilineColumnWidth: EVENT_COLUMN_WIDTH,
      terminalWidth: resolveTtyColumns(process.stdout),
      stackedTitleColumnCount: 2,
    }),
  ].join('\n');
}

export function renderMarkdownSessionTimeline(
  rows: readonly SessionTimelineRow[],
  timezone: string,
): string {
  const bodyRows = buildBodyRows(rows, timezone).map((row) => row.map(toMarkdownSafeCell));

  return markdownTable([[...timelineHeaders], ...bodyRows], { align: timelineAlign });
}
