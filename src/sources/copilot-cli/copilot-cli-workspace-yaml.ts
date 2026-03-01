import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathIsFile } from '../../utils/fs-helpers.js';

export type CopilotCliWorkspaceMetadata = {
  id?: string;
  cwd?: string;
};

function parseWorkspaceScalar(value: string): string | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unwrapped = trimmed.slice(1, -1).trim();
    return unwrapped || undefined;
  }

  return trimmed;
}

export function parseCopilotCliWorkspaceYaml(content: string): CopilotCliWorkspaceMetadata {
  const metadata: CopilotCliWorkspaceMetadata = {};

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/u.exec(trimmed);

    if (!match) {
      continue;
    }

    const key = match[1];
    const scalar = parseWorkspaceScalar(match[2]);

    if (!scalar) {
      continue;
    }

    if (key === 'id') {
      metadata.id = scalar;
      continue;
    }

    if (key === 'cwd') {
      metadata.cwd = scalar;
    }
  }

  return metadata;
}

export async function loadCopilotCliWorkspaceMetadata(
  eventsFilePath: string,
): Promise<CopilotCliWorkspaceMetadata> {
  if (path.basename(eventsFilePath) !== 'events.jsonl') {
    return {};
  }

  const workspaceYamlPath = path.join(path.dirname(eventsFilePath), 'workspace.yaml');

  if (!(await pathIsFile(workspaceYamlPath))) {
    return {};
  }

  try {
    const workspaceContent = await readFile(workspaceYamlPath, 'utf8');
    return parseCopilotCliWorkspaceYaml(workspaceContent);
  } catch {
    return {};
  }
}
