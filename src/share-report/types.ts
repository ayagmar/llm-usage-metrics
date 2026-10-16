// The payload embedded in a --share report, `schema/report-share.v1.schema.json`.
// Type-only: the CLI builds it and the page reads it, so neither side may hold
// logic here.

/** Which cost a column holds; `both` decides per event, so it is its own column. */
export type ShareCostMode = 'explicit' | 'estimated' | 'both';

/** The commands that write a share report; the page opens on each one's own view. */
export type ShareCommand =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'summary'
  | 'compare'
  | 'trends'
  | 'efficiency'
  | 'optimize'
  | 'wrapped';

/** The page's period granularities; `hour` is only available from `meta.hourlyFrom`. */
export type ShareGranularity = 'hour' | 'day' | 'week' | 'month';

export type ShareTokenBuckets = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

/** One mode's cost: `costUsd` is null when no event had a cost, as `costUsd` is omitted in report JSON. */
export type ShareCost = {
  costUsd: number | null;
  /** Events without a cost in this mode; above 0, `costUsd` is a lower bound. */
  incompleteEvents: number;
};

/** One entry per available mode; empty with --no-cost. */
export type ShareCosts = Partial<Record<ShareCostMode, ShareCost>>;

/** A `YYYY-MM-DD` to `YYYY-MM-DD` window of local dates, both inclusive; null ends are open. */
export type ShareDateRange = {
  since: string | null;
  until: string | null;
};

export type ShareReportMeta = {
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** The llm-usage-metrics version that wrote the file. */
  toolVersion: string;
  command: ShareCommand;
  /** IANA timezone every key and date is in; fixed at generation. */
  timezone: string;
  /** The data the file holds: the command's resolved window (compare: baseline start to current end). */
  window: ShareDateRange;
  /** What the page shows on open. */
  initialView: ShareDateRange & { granularity: ShareGranularity };
  /**
   * First local date (`YYYY-MM-DD`) with hourly cells; earlier cells are daily. Null when every
   * cell is hourly.
   */
  hourlyFrom: string | null;
  /** The command's cost mode; null with --no-cost, when the file holds no cost. */
  costMode: ShareCostMode | null;
  /** Modes whose cost could not be computed (pricing failed to load); absent from every `costs`. */
  unavailableCostModes: ShareCostMode[];
  /** True with --redact: project and machine labels are `project-N` and `machine-N`. */
  redacted: boolean;
  /** The command's filters, as values (labels after redaction), never paths. */
  filters: {
    sources: string[];
    providers: string[];
    models: string[];
    machines: string[];
    /** True when --repo narrowed the projects; the values are not embedded. */
    repo: boolean;
  };
};

/** The labels the cube, sessions and blocks refer to by index. */
export type ShareDictionaries = {
  /**
   * Local period keys: `YYYY-MM-DD HH:00` from `meta.hourlyFrom`, `YYYY-MM-DD` before it. The
   * repeated hour when clocks go back keeps one key.
   */
  periods: string[];
  sources: string[];
  models: string[];
  /** Project labels, never full paths; `(unattributed)` for usage outside a repository. */
  projects: string[];
  machines: string[];
};

/**
 * Usage by (period, source, model, project, machine), one cell per array position: every array
 * has the same length.
 */
export type ShareCube = {
  period: number[];
  source: number[];
  model: number[];
  project: number[];
  machine: number[];
  inputTokens: number[];
  outputTokens: number[];
  reasoningTokens: number[];
  cacheReadTokens: number[];
  cacheWriteTokens: number[];
  totalTokens: number[];
  eventCount: number[];
  /** Active time; sums over any dimension equal the per-session value (an approximation). */
  activeMs: number[];
  /** Columns per available mode; empty with --no-cost. */
  costs: Partial<Record<ShareCostMode, ShareCubeCostColumns>>;
};

export type ShareCubeCostColumns = {
  costUsd: (number | null)[];
  incompleteEvents: number[];
};

export type ShareSession = ShareTokenBuckets & {
  /** `source · start time`, with `#n` on collisions; never the session ID. */
  label: string;
  source: number;
  project: number;
  machines: number[];
  firstActivityAt: string;
  lastActivityAt: string;
  eventCount: number;
  activeMs: number;
  models: number[];
  costs: ShareCosts;
};

export type ShareSessions = {
  /** The newest sessions of each project, newest first. */
  rows: ShareSession[];
  /** Projects with sessions left out by the per-project cap, and how many. */
  omitted: { project: number; count: number }[];
};

/** One estimated 5-hour block, as in `blocks --json`, per source across machines. */
export type ShareBlock = ShareTokenBuckets & {
  source: number;
  start: string;
  end: string;
  startUncertain: boolean;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  models: number[];
  costs: ShareCosts;
};

export type ShareBlocks = {
  blockHours: number;
  rows: ShareBlock[];
};

/** The invoking command's report JSON, after path scrubbing and label mapping. */
export type ShareEmbeddedEnvelope = {
  schemaVersion: 1;
  report: 'compare' | 'efficiency' | 'optimize' | 'summary' | 'trends' | 'wrapped';
  /**
   * A sanitized copy of the command's `--json` data (optimize's is an array of rows, the
   * others objects): path fields such as `repoRoot` are dropped and names mapped to the
   * file's labels, so it may not validate against the command's own report schema.
   */
  data: Record<string, unknown> | unknown[];
};

export type ShareReportData = {
  meta: ShareReportMeta;
  dictionaries: ShareDictionaries;
  cube: ShareCube;
  sessions: ShareSessions;
  blocks: ShareBlocks;
  envelope?: ShareEmbeddedEnvelope;
};
