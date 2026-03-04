import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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

export function resolveOpenCommand(filePath: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '', filePath],
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: [filePath],
    };
  }

  return {
    command: 'xdg-open',
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

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function isAutomatedTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test';
}

export async function openShareSvgFile(
  filePath: string,
  deps: OpenShareSvgFileDeps = {},
): Promise<void> {
  if (isAutomatedTestEnvironment(process.env)) {
    return;
  }

  const platform = deps.platform ?? process.platform;
  const runDetached = deps.spawnDetached ?? spawnDetached;
  const { command, args } = resolveOpenCommand(filePath, platform);
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
