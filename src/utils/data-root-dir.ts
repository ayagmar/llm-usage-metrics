import os from 'node:os';
import path from 'node:path';

export function getUserDataRootDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  const xdgDataDir = env.XDG_DATA_HOME;

  // The XDG spec says a relative path is invalid and must be ignored.
  if (xdgDataDir && path.isAbsolute(xdgDataDir)) {
    return xdgDataDir;
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;

    if (localAppData) {
      return localAppData;
    }
  }

  return path.join(homedir, '.local', 'share');
}
