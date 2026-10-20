import type { UsageTotals } from '../domain/usage-report-row.js';
import type { SourceId } from '@ayagmar/agent-sessions';

export type SessionRow = UsageTotals & {
  rowType: 'session';
  source: SourceId;
  sessionId: string;
  repoRoot?: string;
  firstActivity: string;
  lastActivity: string;
  durationMs: number;
  activeMs: number;
  eventCount: number;
  models: string[];
  /** Part of `costUsd` the source logged; undefined when no logged cost counts. */
  costExplicitUsd?: number;
  /** Part of `costUsd` priced from tokens; undefined when no priced estimate counts. */
  costEstimatedUsd?: number;
  /** With --json: the local files holding the session's usage, from the event store. */
  filePaths?: string[];
  /** With --json, for sources that log tool calls: the session's calls, counted as `tools` counts them. */
  toolCalls?: number;
  /** With --json, alongside `toolCalls`: those whose result records an error. */
  toolErrors?: number;
};

export type SessionRepoRow = UsageTotals & {
  rowType: 'repo';
  repoRoot?: string;
  sessionCount: number;
  firstActivity: string;
  lastActivity: string;
  sources: string[];
};
