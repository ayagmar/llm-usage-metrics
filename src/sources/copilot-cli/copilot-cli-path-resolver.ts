import os from 'node:os';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { pathIsDirectory, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { isBlankText } from '../parsing-utils.js';

const defaultCopilotCliSessionsDir = path.join(os.homedir(), '.copilot', 'session-state');

export type CopilotCliPathResolverOptions = {
  sessionsDir?: string;
  requireSessionsDir?: boolean;
};

function isSkippableDirectoryReadError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
}

export async function discoverCopilotCliSessionFiles(
  options: CopilotCliPathResolverOptions = {},
): Promise<string[]> {
  const sessionsDir = options.sessionsDir ?? defaultCopilotCliSessionsDir;
  const requireSessionsDir = options.requireSessionsDir ?? false;

  if (isBlankText(sessionsDir)) {
    throw new Error('Copilot CLI sessions directory must be a non-empty path');
  }

  const normalizedDir = sessionsDir.trim();

  if (requireSessionsDir && !(await pathReadable(normalizedDir))) {
    throw new Error(`Copilot CLI sessions directory is missing or unreadable: ${normalizedDir}`);
  }

  if (requireSessionsDir && !(await pathIsDirectory(normalizedDir))) {
    throw new Error(`Copilot CLI sessions directory is not a directory: ${normalizedDir}`);
  }

  let entries: Dirent[];

  try {
    entries = await readdir(normalizedDir, {
      withFileTypes: true,
      encoding: 'utf8',
    });
  } catch (error) {
    if (!requireSessionsDir && isSkippableDirectoryReadError(error)) {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      files.push(path.join(normalizedDir, entry.name));
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const eventsPath = path.join(normalizedDir, entry.name, 'events.jsonl');

    if (await pathIsFile(eventsPath)) {
      files.push(eventsPath);
    }
  }

  files.sort(compareByCodePoint);
  return files;
}

export function getDefaultCopilotCliSessionsDir(): string {
  return defaultCopilotCliSessionsDir;
}
