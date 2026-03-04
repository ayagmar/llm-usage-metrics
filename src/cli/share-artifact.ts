import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeShareSvgFile(fileName: string, svgContent: string): Promise<string> {
  const outputPath = path.resolve(process.cwd(), fileName);
  await writeFile(outputPath, svgContent, 'utf8');
  return outputPath;
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

export async function openShareSvgFile(
  filePath: string,
  deps: OpenShareSvgFileDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const runDetached = deps.spawnDetached ?? spawnDetached;
  const { command, args } = resolveOpenCommand(filePath, platform);
  await runDetached(command, args);
}
