import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hasErrorCode } from '@ayagmar/agent-sessions/internal';

/** What a `--share` run writes: one self-contained HTML report in the current directory. */
export type ShareArtifact = {
  /** The `.html` file name. */
  fileName: string;
  /** Names the report in the stderr lines, e.g. `usage`. */
  logLabel: string;
  render: () => string;
};

/**
 * Writes the report to `fileName` in the current directory, replacing an earlier one. The old
 * entry is unlinked and the file created anew, readable by its owner only, so a symlink placed
 * at that name (in a shared directory, say) is replaced rather than followed.
 */
export async function writeShareFile(fileName: string, content: string): Promise<string> {
  const outputPath = path.resolve(process.cwd(), fileName);

  try {
    await unlink(outputPath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  await writeFile(outputPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return outputPath;
}

type OpenShareFileDeps = {
  platform?: NodeJS.Platform;
  spawnDetached?: (command: string, args: string[]) => Promise<void>;
};

type OpenCommand = {
  command: string;
  args: string[];
};

const WINDOWS_OPEN_COMMAND = 'C:\\Windows\\System32\\rundll32.exe';
const DARWIN_OPEN_COMMAND = '/usr/bin/open';
const UNIX_OPEN_COMMAND = '/usr/bin/xdg-open';

const WINDOWS_FALLBACK_COMMANDS = ['rundll32.exe'];
const DARWIN_FALLBACK_COMMANDS = ['open'];
const UNIX_FALLBACK_COMMANDS = ['xdg-open'];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinaryPath(
  primaryPath: string,
  fallbackNames: string[],
): Promise<string | undefined> {
  if (await fileExists(primaryPath)) {
    return primaryPath;
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  for (const fallbackName of fallbackNames) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, fallbackName);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export async function resolveOpenCommand(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<OpenCommand> {
  if (platform === 'win32') {
    const resolvedPath = await resolveBinaryPath(WINDOWS_OPEN_COMMAND, WINDOWS_FALLBACK_COMMANDS);
    if (!resolvedPath) {
      throw new Error(
        'Could not find rundll32.exe. Please ensure Windows System32 is accessible or rundll32.exe is available on PATH.',
      );
    }
    return {
      command: resolvedPath,
      args: ['shell32.dll,ShellExec_RunDLL', filePath],
    };
  }

  if (platform === 'darwin') {
    const resolvedPath = await resolveBinaryPath(DARWIN_OPEN_COMMAND, DARWIN_FALLBACK_COMMANDS);
    if (!resolvedPath) {
      throw new Error(
        'Could not find open command. Please ensure macOS is properly configured or open is available on PATH.',
      );
    }
    return {
      command: resolvedPath,
      args: [filePath],
    };
  }

  const resolvedPath = await resolveBinaryPath(UNIX_OPEN_COMMAND, UNIX_FALLBACK_COMMANDS);
  if (!resolvedPath) {
    throw new Error(
      'Could not find xdg-open. Please install xdg-utils or ensure it is in your PATH.',
    );
  }
  return {
    command: resolvedPath,
    args: [filePath],
  };
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    const cleanup = (): void => {
      child.removeListener('error', onError);
      child.removeListener('spawn', onSpawn);
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onSpawn = (): void => {
      cleanup();
      child.unref();
      resolve();
    };

    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

export async function openShareFile(filePath: string, deps: OpenShareFileDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const runDetached = deps.spawnDetached ?? spawnDetached;
  const { command, args } = await resolveOpenCommand(filePath, platform);
  await runDetached(command, args);
}
