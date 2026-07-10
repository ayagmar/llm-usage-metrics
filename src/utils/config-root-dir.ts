import os from 'node:os';
import path from 'node:path';

export function getUserConfigRootDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  const xdgConfigDir = env.XDG_CONFIG_HOME;

  if (xdgConfigDir) {
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
