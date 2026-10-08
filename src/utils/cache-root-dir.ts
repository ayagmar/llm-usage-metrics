import os from 'node:os';
import path from 'node:path';

export function getUserCacheRootDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  const xdgCacheDir = env.XDG_CACHE_HOME;

  // The XDG spec says a relative path is invalid and must be ignored.
  if (xdgCacheDir && path.isAbsolute(xdgCacheDir)) {
    return xdgCacheDir;
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;

    if (localAppData) {
      return localAppData;
    }
  }

  return path.join(homedir, '.cache');
}
