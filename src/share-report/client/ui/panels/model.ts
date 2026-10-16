// What the panels share: reading an embedded envelope, which is untyped JSON, and the view
// shapes the panel renderer lays out. Pure: no DOM, so Node tests cover every panel model.

import type { ShareEmbeddedEnvelope } from '../../../types.js';
import { formatUsdOrNone, NO_VALUE, type ShareReport } from '../../core/index.js';
import { formatCount, formatPercent } from '../shell/format.js';

/** A labelled figure: the recap's facts and the panels' headline numbers. */
export type PanelFact = {
  label: string;
  value: string;
  /** A second line: the exact figure or what the value means. */
  detail?: string;
};

export type PanelCell = {
  text: string;
  /** Why the value reads as it does, e.g. a lower-bound cost; shown as a tooltip. */
  note?: string;
};

export type PanelColumn = { label: string; numeric: boolean };

/** A table: the first cell of each row heads it. */
export type PanelTable = {
  title: string;
  columns: PanelColumn[];
  rows: PanelCell[][];
  /** Total rows, under a rule. */
  foot: PanelCell[][];
};

/** A panel's body, top to bottom; `note` says where the figures come from. */
export type PanelView = {
  facts: PanelFact[];
  tables: PanelTable[];
  note: string;
};

/** The envelope's data when the file embeds that command's report, else undefined. */
export function getEnvelopeData(
  report: ShareReport,
  kind: ShareEmbeddedEnvelope['report'],
): ShareEmbeddedEnvelope['data'] | undefined {
  const { envelope } = report.data;
  return envelope?.report === kind ? envelope.data : undefined;
}

/** A panel's `appliesTo`: the file embeds that command's report. */
export function embeds(kind: ShareEmbeddedEnvelope['report']): (report: ShareReport) => boolean {
  return (report) => report.data.envelope?.report === kind;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, else undefined: the CLI omits a value it could not compute. */
export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** `1,234`, or {@link NO_VALUE} when the CLI left the figure out. */
export function formatCountOrNone(value: number | undefined): string {
  return value === undefined ? NO_VALUE : formatCount(value);
}

const LOWER_BOUND_NOTE = 'Some events had no price, so this is a lower bound';

/** `$1.23`, `~$1.23` when some events had no price (as the terminal marks it), or `—`. */
export function formatEnvelopeCost(costUsd: number | undefined, incomplete = false): PanelCell {
  if (costUsd === undefined) {
    return { text: NO_VALUE };
  }

  const text = formatUsdOrNone(costUsd);
  return incomplete ? { text: `~${text}`, note: LOWER_BOUND_NOTE } : { text };
}

// A true minus sign: it lines up with `+` in tabular figures.
const MINUS = '−';

function signOf(value: number): string {
  return value > 0 ? '+' : value < 0 ? MINUS : '';
}

/** `+1,570`, `−16`, `0` */
export function formatSignedCount(value: number | undefined): string {
  return value === undefined ? NO_VALUE : `${signOf(value)}${formatCount(Math.abs(value))}`;
}

/** `+$0.06`, `−$0.01`, `~+$0.06` when either side is a lower bound. */
export function formatSignedCost(value: number | undefined, incomplete = false): PanelCell {
  if (value === undefined) {
    return { text: NO_VALUE };
  }

  const text = `${signOf(value)}${formatUsdOrNone(Math.abs(value))}`;
  return incomplete ? { text: `~${text}`, note: LOWER_BOUND_NOTE } : { text };
}

/** `+9,100.0%` from a ratio of 91; `—` when the baseline was zero and the CLI left it out. */
export function formatSignedRatio(ratio: number | undefined): string {
  return ratio === undefined ? NO_VALUE : `${signOf(ratio)}${formatPercent(Math.abs(ratio))}`;
}
