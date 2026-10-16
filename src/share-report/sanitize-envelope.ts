import { toProjectKey } from '../aggregate/project-key.js';
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

export type EnvelopeLabelMaps = {
  /** The share label (redacted with --redact) of a project key; undefined for unknown keys. */
  projectLabelForKey: (key: string | undefined) => string | undefined;
  /** The share label of a project label the invoking command printed, when it differs. */
  projectLabelForLabel: (label: string) => string | undefined;
  /** The share label of a machine name. */
  machineLabel: (name: string) => string;
  /** Removes paths from any other string (see `createPathScrubber`). */
  scrub: (value: string) => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, maps: EnvelopeLabelMaps): unknown {
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

function sanitizeProject(record: Record<string, unknown>, maps: EnvelopeLabelMaps): string {
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

function sanitizeRecord(
  record: Record<string, unknown>,
  maps: EnvelopeLabelMaps,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (PATH_FIELDS.has(key)) {
      continue;
    }

    if (key === 'project' && typeof value === 'string') {
      sanitized[key] = sanitizeProject(record, maps);
    } else if (key === 'machine' && typeof value === 'string') {
      sanitized[key] = maps.machineLabel(value);
    } else if (key === 'machines' && Array.isArray(value)) {
      sanitized[key] = value.map((name) =>
        typeof name === 'string' ? maps.machineLabel(name) : sanitizeValue(name, maps),
      );
    } else {
      sanitized[key] = sanitizeValue(value, maps);
    }
  }

  return sanitized;
}

/**
 * The invoking command's report JSON made safe to embed: path fields dropped (`repoRoot` and
 * the like), `project` and `machine` mapped through the file's label and redaction maps, and
 * every other string scrubbed of paths.
 */
export function sanitizeEmbeddedEnvelope(
  envelope: Pick<ShareEmbeddedEnvelope, 'report' | 'data'>,
  maps: EnvelopeLabelMaps,
): ShareEmbeddedEnvelope {
  const data = Array.isArray(envelope.data)
    ? envelope.data.map((item) => sanitizeValue(item, maps))
    : sanitizeRecord(envelope.data, maps);
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
