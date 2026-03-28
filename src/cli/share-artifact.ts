import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeShareSvgFile(fileName: string, svgContent: string): Promise<string> {
  const outputPath = path.resolve(process.cwd(), fileName);
  await writeFile(outputPath, svgContent, 'utf8');
  return outputPath;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

type OpenShareSvgFileDeps = {
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

export async function openShareSvgFile(
  filePath: string,
  deps: OpenShareSvgFileDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const runDetached = deps.spawnDetached ?? spawnDetached;
  const { command, args } = await resolveOpenCommand(filePath, platform);
  await runDetached(command, args);
}

type WriteAndOpenShareSvgFileDeps = {
  writeShareSvgFileFn?: (fileName: string, svgContent: string) => Promise<string>;
  openShareSvgFileFn?: (filePath: string) => Promise<void>;
};

export type ShareSvgArtifactResult = {
  outputPath: string;
  opened: boolean;
  openErrorMessage?: string;
};

export async function writeAndOpenShareSvgFile(
  fileName: string,
  svgContent: string,
  deps: WriteAndOpenShareSvgFileDeps = {},
): Promise<ShareSvgArtifactResult> {
  const writeShareSvg = deps.writeShareSvgFileFn ?? writeShareSvgFile;
  const openShareSvg = deps.openShareSvgFileFn ?? openShareSvgFile;

  const outputPath = await writeShareSvg(fileName, svgContent);

  try {
    await openShareSvg(outputPath);
    return {
      outputPath,
      opened: true,
    };
  } catch (error) {
    return {
      outputPath,
      opened: false,
      openErrorMessage: stringifyError(error),
    };
  }
}
