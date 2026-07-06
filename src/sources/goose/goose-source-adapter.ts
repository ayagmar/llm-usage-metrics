import { createUsageEvent, type UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { pathExists, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, isBlankText, normalizeTimestampCandidate } from '../parsing-utils.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import { getDefaultGooseDbPathCandidates } from './goose-db-path-resolver.js';
import { loadNodeSqliteModule, type SqliteModule } from '../opencode/node-sqlite-loader.js';

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

type GooseParsedRow = {
  event?: UsageEvent;
  skippedReason?: 'invalid_model_config' | 'invalid_timestamp' | 'no_token_usage';
};

export type GooseSourceAdapterOptions = {
  dbPath?: string;
  resolveDefaultDbPaths?: () => string[];
  pathExists?: PathPredicate;
  pathReadable?: PathPredicate;
  pathIsFile?: PathPredicate;
  loadSqliteModule?: () => Promise<SqliteModule>;
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
    const sqliteDateTimeMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u.exec(normalized);

    if (sqliteDateTimeMatch) {
      return normalizeTimestampCandidate(`${sqliteDateTimeMatch[1]}T${sqliteDateTimeMatch[2]}Z`);
    }

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
  const reasoningTokens =
    resolvedTotalTokens === undefined
      ? 0
      : Math.max(0, resolvedTotalTokens - inputTokens - outputTokens);

  return {
    event: createUsageEvent({
      source: 'goose',
      sessionId: sessionId ?? 'goose-session',
      timestamp,
      provider: asTrimmedText(row.provider_name),
      model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: resolvedTotalTokens,
      costMode: 'estimated',
    }),
    skippedReason: invalidModelConfig ? 'invalid_model_config' : undefined,
  };
}

export class GooseSourceAdapter implements SourceAdapter {
  public readonly id = 'goose' as const;

  private readonly explicitDbPath?: string;
  private readonly resolveDefaultDbPaths: () => string[];
  private readonly pathExists: PathPredicate;
  private readonly pathReadable: PathPredicate;
  private readonly pathIsFile: PathPredicate;
  private readonly loadSqliteModule: () => Promise<SqliteModule>;

  public constructor(options: GooseSourceAdapterOptions = {}) {
    this.explicitDbPath = options.dbPath;
    this.resolveDefaultDbPaths = options.resolveDefaultDbPaths ?? getDefaultGooseDbPathCandidates;
    this.pathExists = options.pathExists ?? pathExists;
    this.pathReadable = options.pathReadable ?? pathReadable;
    this.pathIsFile = options.pathIsFile ?? pathIsFile;
    this.loadSqliteModule = options.loadSqliteModule ?? loadNodeSqliteModule;
  }

  public async discoverFiles(): Promise<string[]> {
    if (this.explicitDbPath !== undefined) {
      if (isBlankText(this.explicitDbPath)) {
        throw new Error('--goose-db must be a non-empty path');
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

  public async parseFile(dbPath: string): Promise<UsageEvent[]> {
    const parseDiagnostics = await this.parseFileWithDiagnostics(dbPath);
    return parseDiagnostics.events;
  }

  public async parseFileWithDiagnostics(dbPath: string): Promise<SourceParseFileDiagnostics> {
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

    const sqlite = await this.loadSqliteModule();
    const database = new sqlite.DatabaseSync(normalizedDbPath, { readOnly: true, timeout: 0 });

    try {
      const rows = database.prepare(gooseSessionsQuery).all() as GooseSqliteRow[];
      const events: UsageEvent[] = [];
      let skippedRows = 0;
      const skippedRowReasons = new Map<string, number>();

      for (const row of rows) {
        const parsedRow = parseGooseRow(row);

        if (parsedRow.event) {
          events.push(parsedRow.event);
        }

        if (parsedRow.skippedReason) {
          skippedRows++;
          incrementSkippedReason(skippedRowReasons, parsedRow.skippedReason);
        }
      }

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    } finally {
      database.close();
    }
  }
}
