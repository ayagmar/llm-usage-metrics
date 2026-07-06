import type { UsageTotals } from '../domain/usage-report-row.js';
import type { SourceId } from '../domain/usage-event.js';

export type SessionRow = UsageTotals & {
  rowType: 'session';
  source: SourceId;
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  eventCount: number;
  models: string[];
};
