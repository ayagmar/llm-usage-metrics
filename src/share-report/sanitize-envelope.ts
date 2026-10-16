import { toProjectKey } from '../aggregate/project-key.js';
import { createNameReplacer, toShareModelLabel } from './redact.js';
import type { ShareEmbeddedEnvelope } from './types.js';

/** Fields whose values are paths; they are dropped, never scrubbed. */
const PATH_FIELDS: ReadonlySet<string> = new Set([
  'repoRoot',
  'repoRoots',
  'repoDir',
  'cwd',
  'path',
  'filePath',
  'configPath',
]);

/** Fields whose values are model names; they get the labels the rest of the file gives them. */
const MODEL_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'candidateModel',
  'candidateResolvedModel',
]);

/** Fields holding lists of models: names, or records naming one (`{ name, … }`). */
const MODEL_LIST_FIELDS: ReadonlySet<string> = new Set(['models', 'topModels']);

/**
 * Fields holding identifiers and the tool's own words (source and provider ids, period keys,
 * metric keys and labels, note codes, the top sources): paths are scrubbed from them, but a
 * project or machine that shares a name with one (a repo called `codex`) never replaces it.
 */
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  'source',
  'provider',
  'periodKey',
  'rowType',
  'key',
  'label',
  'valueType',
  'grouping',
  'level',
  'notes',
  'timezone',
  'topSources',
]);

export type EnvelopeLabelMaps = {
  /** The share label (redacted with --redact) of a project key; undefined for unknown keys. */
  projectLabelForKey: (key: string | undefined) => string | undefined;
  /** The share label of a project label the invoking command printed, when it differs. */
  projectLabelForLabel: (label: string) => string | undefined;
  /** The share label of a machine name. */
  machineLabel: (name: string) => string;
  /** Removes paths from any other string (see `createPathScrubber`). */
  scrub: (value: string) => string;
  /**
   * Names free text may mention, each as the file shows it: the project labels the command
   * printed and, with --redact, every project label and machine name. The envelope's own
   * `project` and `machine` values are added to them.
   */
  names: ReadonlyMap<string, string>;
};

/** The maps while sanitizing: `scrub` also replaces names, `scrubPaths` only paths. */
type SanitizeMaps = EnvelopeLabelMaps & { scrubPaths: (value: string) => string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, maps: SanitizeMaps): unknown {
  if (typeof value === 'string') {
    return maps.scrub(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, maps));
  }

  if (isRecord(value)) {
    return sanitizeRecord(value, maps);
  }

  return value;
}

function sanitizeProject(record: Record<string, unknown>, maps: SanitizeMaps): string {
  const project = record.project;
  const repoRoot = record.repoRoot;

  // A row with its key gets the label of that key, so labels match the rest of the file.
  if (repoRoot === null || typeof repoRoot === 'string') {
    const fromKey = maps.projectLabelForKey(toProjectKey(repoRoot ?? undefined));

    if (fromKey !== undefined) {
      return fromKey;
    }
  }

  const label = String(project);
  return maps.projectLabelForLabel(label) ?? maps.scrub(label);
}

function sanitizeModel(value: unknown, maps: SanitizeMaps): unknown {
  if (typeof value === 'string') {
    return toShareModelLabel(value);
  }

  if (isRecord(value) && typeof value.name === 'string') {
    return { ...sanitizeRecord(value, maps), name: toShareModelLabel(value.name) };
  }

  return sanitizeValue(value, maps);
}

function sanitizeRecord(
  record: Record<string, unknown>,
  maps: SanitizeMaps,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (PATH_FIELDS.has(key)) {
      continue;
    }

    if (key === 'project' && typeof value === 'string') {
      sanitized[key] = sanitizeProject(record, maps);
    } else if (MODEL_FIELDS.has(key) && typeof value === 'string') {
      sanitized[key] = toShareModelLabel(value);
    } else if (MODEL_LIST_FIELDS.has(key) && Array.isArray(value)) {
      sanitized[key] = value.map((model) => sanitizeModel(model, maps));
    } else if (key === 'machine' && typeof value === 'string') {
      sanitized[key] = maps.machineLabel(value);
    } else if (key === 'machines' && Array.isArray(value)) {
      sanitized[key] = value.map((name) =>
        typeof name === 'string' ? maps.machineLabel(name) : sanitizeValue(name, maps),
      );
    } else if (IDENTIFIER_FIELDS.has(key)) {
      sanitized[key] = sanitizeValue(value, { ...maps, scrub: maps.scrubPaths });
    } else {
      sanitized[key] = sanitizeValue(value, maps);
    }
  }

  return sanitized;
}

/** Each `project` and `machine` value in `value` that the file shows otherwise, with its label. */
function collectFieldNames(value: unknown, maps: SanitizeMaps, names: Map<string, string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectFieldNames(item, maps, names);
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.project === 'string') {
    names.set(value.project, sanitizeProject(value, maps));
  }

  const listed: unknown[] = Array.isArray(value.machines) ? value.machines : [];

  for (const machine of [value.machine, ...listed]) {
    if (typeof machine === 'string') {
      names.set(machine, maps.machineLabel(machine));
    }
  }

  Object.values(value).forEach((field) => {
    collectFieldNames(field, maps, names);
  });
}

/**
 * The invoking command's report JSON made safe to embed: path fields dropped (`repoRoot` and
 * the like), `project` and `machine` mapped through the file's label and redaction maps, model
 * names labelled as the file labels them, and every other string scrubbed of paths and of the
 * names the file shows otherwise.
 */
export function sanitizeEmbeddedEnvelope(
  envelope: Pick<ShareEmbeddedEnvelope, 'report' | 'data'>,
  maps: EnvelopeLabelMaps,
): ShareEmbeddedEnvelope {
  const pathMaps: SanitizeMaps = { ...maps, scrubPaths: maps.scrub };
  const names = new Map(maps.names);
  collectFieldNames(envelope.data, pathMaps, names);
  const replaceNames = createNameReplacer(names);
  const textMaps: SanitizeMaps = { ...pathMaps, scrub: (value) => replaceNames(maps.scrub(value)) };
  const data = Array.isArray(envelope.data)
    ? envelope.data.map((item) => sanitizeValue(item, textMaps))
    : sanitizeRecord(envelope.data, textMaps);
  return { schemaVersion: 1, report: envelope.report, data };
}

/** Every `repoRoot` in the envelope, as project keys, so they get labels with the file's own. */
export function collectEnvelopeProjectKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    if (typeof node.repoRoot === 'string') {
      keys.push(toProjectKey(node.repoRoot) ?? node.repoRoot);
    }

    Object.values(node).forEach(visit);
  };

  visit(value);
  return keys;
}
