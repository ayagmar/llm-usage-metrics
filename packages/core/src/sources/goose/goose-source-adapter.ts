import { setTimeout as sleep } from 'node:timers/promises';

import { createUsageEvent, type UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { pathExists, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import { asTrimmedText, isBlankText, normalizeTimestampCandidate } from '../parsing-utils.js';
import type { SourceAdapter, SourceReadOptions } from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';
import { getDefaultGooseDbPathCandidates } from './goose-db-path-resolver.js';
import { iterateRows } from '../sqlite/iterate-rows.js';
import { loadNodeSqliteModule, type SqliteModule } from '../sqlite/node-sqlite-loader.js';
import {
  resolveMaxBusyRetries,
  runWithBusyRetries,
  toSqliteDbReadError,
  type SleepFn,
} from '../sqlite/retry-policy.js';

const DEFAULT_BUSY_RETRY_COUNT = 2;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;

type PathPredicate = (filePath: string) => Promise<boolean>;

type GooseSqliteRow = {
  id?: unknown;
  model_config_json?: unknown;
  provider_name?: unknown;
  created_at?: unknown;
  total_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  accumulated_total_tokens?: unknown;
  accumulated_input_tokens?: unknown;
  accumulated_output_tokens?: unknown;
};

type GooseSessionRows = {
  database: InstanceType<SqliteModule['DatabaseSync']>;
  rows: IterableIterator<GooseSqliteRow>;
};

type GooseParsedRow = {
  event?: UsageEvent;
  skippedReason?:
    'invalid_model_config' | 'invalid_timestamp' | 'no_token_usage' | 'event_creation_failed';
};

/** Options for `GooseSourceAdapter`. */
export type GooseSourceAdapterOptions = {
  /** The database to read; the platform's default locations when omitted. */
  dbPath?: string;
  /** Test seam: default database paths tried when no dbPath is given. @internal */
  resolveDefaultDbPaths?: () => string[];
  /** Test seam: replaces the file system check. @internal */
  pathExists?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathReadable?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathIsFile?: PathPredicate;
  /** Test seam: replaces the node:sqlite loader. @internal */
  loadSqliteModule?: (consumerLabel: string) => Promise<SqliteModule>;
  /** Retries of a read that finds the database busy or locked. */
  maxBusyRetries?: number;
  /** Delay between those retries. */
  busyRetryDelayMs?: number;
  /** Test seam: replaces the busy-retry delay. @internal */
  sleep?: SleepFn;
  context?: SourceContext;
};

const gooseSessionsQuery = `
  SELECT id, model_config_json, provider_name, created_at,
         total_tokens, input_tokens, output_tokens,
         accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
  FROM sessions
  WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
`;

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.trunc(parsed);
}

function resolveTokenValue(primary: unknown, fallback: unknown): number | undefined {
  return toNonNegativeInteger(primary) ?? toNonNegativeInteger(fallback);
}

function normalizeGooseTimestamp(candidate: unknown): string | undefined {
  if (typeof candidate === 'string') {
    const normalized = candidate.trim();

    if (/^-?\d+(?:\.\d+)?$/u.test(normalized)) {
      return normalizeTimestampCandidate(Number(normalized));
    }
  }

  return normalizeTimestampCandidate(candidate);
}

function parseModelName(modelConfigJson: unknown): {
  model: string | undefined;
  invalidModelConfig: boolean;
} {
  const modelConfigText = asTrimmedText(modelConfigJson);

  if (!modelConfigText) {
    return { model: undefined, invalidModelConfig: false };
  }

  try {
    const modelConfig = asRecord(JSON.parse(modelConfigText));
    return {
      model: asTrimmedText(modelConfig?.model_name),
      invalidModelConfig: false,
    };
  } catch {
    return { model: undefined, invalidModelConfig: true };
  }
}

function parseGooseRow(row: GooseSqliteRow): GooseParsedRow {
  const sessionId = asTrimmedText(row.id);
  const timestamp = normalizeGooseTimestamp(row.created_at);
  const inputTokens = resolveTokenValue(row.accumulated_input_tokens, row.input_tokens) ?? 0;
  const outputTokens = resolveTokenValue(row.accumulated_output_tokens, row.output_tokens) ?? 0;
  const resolvedTotalTokens = resolveTokenValue(row.accumulated_total_tokens, row.total_tokens);
  const totalForSkipCheck = resolvedTotalTokens ?? inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && totalForSkipCheck === 0) {
    return { skippedReason: 'no_token_usage' };
  }

  if (!timestamp) {
    return { skippedReason: 'invalid_timestamp' };
  }

  const { model, invalidModelConfig } = parseModelName(row.model_config_json);
  // Goose's output count can exclude thinking tokens that its total includes (e.g. Gemini's
  // candidatesTokenCount), so the remainder is reasoning and belongs inside output.
  const reasoningTokens =
    resolvedTotalTokens === undefined
      ? 0
      : Math.max(0, resolvedTotalTokens - inputTokens - outputTokens);

  try {
    return {
      event: createUsageEvent({
        source: 'goose',
        sessionId: sessionId ?? 'goose-session',
        timestamp,
        provider: asTrimmedText(row.provider_name),
        model,
        inputTokens,
        outputTokens: outputTokens + reasoningTokens,
        reasoningTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: resolvedTotalTokens,
      }),
      skippedReason: invalidModelConfig ? 'invalid_model_config' : undefined,
    };
  } catch {
    return { skippedReason: 'event_creation_failed' };
  }
}

/**
 * Goose's sessions database (SQLite), from `dbPath` or the platform's default locations
 * (`$GOOSE_PATH_ROOT`, `$XDG_DATA_HOME`, Application Support or `%APPDATA%`). Needs `node:sqlite`.
 */
export class GooseSourceAdapter implements SourceAdapter {
  public readonly id = 'goose' as const;
  public readonly capabilities = { kinds: ['usage'] } as const;
  public readonly parserVersion = 2;

  private readonly explicitDbPath?: string;
  private readonly resolveDefaultDbPaths: () => string[];
  private readonly pathExists: PathPredicate;
  private readonly pathReadable: PathPredicate;
  private readonly pathIsFile: PathPredicate;
  private readonly loadSqliteModule: (consumerLabel: string) => Promise<SqliteModule>;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private readonly sleep: SleepFn;

  public constructor(options: GooseSourceAdapterOptions = {}) {
    const context = options.context ?? createSourceContext();

    this.explicitDbPath = options.dbPath;
    this.resolveDefaultDbPaths =
      options.resolveDefaultDbPaths ?? (() => getDefaultGooseDbPathCandidates(context));
    this.pathExists = options.pathExists ?? pathExists;
    this.pathReadable = options.pathReadable ?? pathReadable;
    this.pathIsFile = options.pathIsFile ?? pathIsFile;
    this.loadSqliteModule = options.loadSqliteModule ?? loadNodeSqliteModule;
    this.maxBusyRetries = resolveMaxBusyRetries(
      'Goose',
      options.maxBusyRetries,
      DEFAULT_BUSY_RETRY_COUNT,
    );
    this.busyRetryDelayMs = Math.max(1, options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? sleep;
  }

  public getSearchPaths(): string[] {
    return this.explicitDbPath !== undefined
      ? [this.explicitDbPath.trim()]
      : this.resolveDefaultDbPaths();
  }

  public async discoverFiles(): Promise<string[]> {
    if (this.explicitDbPath !== undefined) {
      if (isBlankText(this.explicitDbPath)) {
        throw new Error('dbPath must be a non-empty path');
      }

      const explicitDbPath = this.explicitDbPath.trim();
      const readable = await this.pathReadable(explicitDbPath);

      if (!readable) {
        throw new Error(`Goose DB path is missing or unreadable: ${explicitDbPath}`);
      }

      if ((await this.pathExists(explicitDbPath)) && !(await this.pathIsFile(explicitDbPath))) {
        throw new Error(`Goose DB path is not a file: ${explicitDbPath}`);
      }

      return [explicitDbPath];
    }

    let firstUnreadableCandidatePath: string | undefined;

    for (const candidatePath of this.resolveDefaultDbPaths()) {
      if (await this.pathReadable(candidatePath)) {
        if ((await this.pathExists(candidatePath)) && !(await this.pathIsFile(candidatePath))) {
          throw new Error(`Goose DB path is not a file: ${candidatePath}`);
        }

        return [candidatePath];
      }

      if (!firstUnreadableCandidatePath && (await this.pathExists(candidatePath))) {
        firstUnreadableCandidatePath = candidatePath;
      }
    }

    if (firstUnreadableCandidatePath) {
      throw new Error(`Goose DB path is unreadable: ${firstUnreadableCandidatePath}`);
    }

    return [];
  }

  public async getParseDependencies(dbPath: string): Promise<string[]> {
    if (isBlankText(dbPath)) {
      return [];
    }

    const normalizedDbPath = dbPath.trim();
    return [`${normalizedDbPath}-wal`, `${normalizedDbPath}-journal`];
  }

  public async *read(dbPath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();

    if (isBlankText(dbPath)) {
      throw new Error('Goose DB path must be a non-empty path');
    }

    const normalizedDbPath = dbPath.trim();
    const readable = await this.pathReadable(normalizedDbPath);

    if (!readable) {
      throw new Error(`Goose DB path is unreadable: ${normalizedDbPath}`);
    }

    if ((await this.pathExists(normalizedDbPath)) && !(await this.pathIsFile(normalizedDbPath))) {
      throw new Error(`Goose DB path is not a file: ${normalizedDbPath}`);
    }

    let attempts = 0;
    const { database, rows } = await runWithBusyRetries(
      (attempt) => {
        attempts = attempt + 1;
        return this.openSessionRows(normalizedDbPath);
      },
      {
        source: 'Goose',
        dbPath: normalizedDbPath,
        maxBusyRetries: this.maxBusyRetries,
        busyRetryDelayMs: this.busyRetryDelayMs,
        sleep: this.sleep,
      },
    );

    try {
      try {
        for (const row of rows) {
          const parsedRow = parseGooseRow(row);

          if (parsedRow.skippedReason) {
            recordSkippedRow(diagnostics, parsedRow.skippedReason);
          }

          if (parsedRow.event) {
            yield parsedRow.event;
          }
        }
      } finally {
        database.close();
      }
    } catch (error) {
      throw toSqliteDbReadError(error, 'Goose', normalizedDbPath, attempts);
    }
  }

  // Opens the database and pulls the first row, so a busy database fails here, inside
  // the retry, rather than after a row was yielded.
  private async openSessionRows(dbPath: string): Promise<GooseSessionRows> {
    const sqlite = await this.loadSqliteModule('Goose');
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 0 });

    try {
      return { database, rows: iterateRows(database.prepare(gooseSessionsQuery)) };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
