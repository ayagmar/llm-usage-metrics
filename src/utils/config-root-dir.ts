import os from 'node:os';
import path from 'node:path';

export function getUserConfigRootDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  const xdgConfigDir = env.XDG_CONFIG_HOME;

  // The XDG spec says a relative path is invalid and must be ignored.
  if (xdgConfigDir && path.isAbsolute(xdgConfigDir)) {
    return xdgConfigDir;
  }

  if (platform === 'win32') {
    const appData = env.APPDATA;

    if (appData) {
      return appData;
    }
  }

  return path.join(homedir, '.config');
}
