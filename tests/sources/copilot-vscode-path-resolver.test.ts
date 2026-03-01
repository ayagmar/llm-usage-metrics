import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverCopilotVscodeSessionFiles,
  getDefaultCopilotVscodeWorkspaceStorageRoots,
} from '../../src/sources/copilot-vscode/copilot-vscode-path-resolver.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('copilot-vscode-path-resolver', () => {
  it('generates deterministic default root candidates for Linux/macOS/Windows', () => {
    const linux = getDefaultCopilotVscodeWorkspaceStorageRoots({
      platform: 'linux',
      homeDir: '/home/test',
      env: {},
    });
    expect(linux).toEqual([
      '/home/test/.config/Code/User/workspaceStorage',
      '/home/test/.config/Code - Insiders/User/workspaceStorage',
    ]);

    const mac = getDefaultCopilotVscodeWorkspaceStorageRoots({
      platform: 'darwin',
      homeDir: '/Users/test',
      env: {},
    });
    expect(mac).toEqual([
      '/Users/test/Library/Application Support/Code/User/workspaceStorage',
      '/Users/test/Library/Application Support/Code - Insiders/User/workspaceStorage',
    ]);

    const windows = getDefaultCopilotVscodeWorkspaceStorageRoots({
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    });
    expect(windows).toEqual([
      'C:\\Users\\test\\AppData\\Roaming/Code/User/workspaceStorage',
      'C:\\Users\\test\\AppData\\Roaming/Code - Insiders/User/workspaceStorage',
      'C:\\Users\\test/.config/Code/User/workspaceStorage',
      'C:\\Users\\test/.config/Code - Insiders/User/workspaceStorage',
    ]);
  });

  it('supports APPDATA fallbacks for Windows candidates', () => {
    const localFallback = getDefaultCopilotVscodeWorkspaceStorageRoots({
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    });
    expect(localFallback[0]).toBe('C:\\Users\\test\\AppData\\Roaming/Code/User/workspaceStorage');

    const userProfileFallback = getDefaultCopilotVscodeWorkspaceStorageRoots({
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
      env: { USERPROFILE: 'C:\\Users\\test' },
    });
    expect(userProfileFallback[0]).toBe(
      'C:\\Users\\test/AppData/Roaming/Code/User/workspaceStorage',
    );
  });

  it('merges files from multiple existing default roots', async () => {
    const tempHomeDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-vscode-home-'));
    tempDirs.push(tempHomeDir);

    const stableDir = path.join(tempHomeDir, '.config', 'Code', 'User', 'workspaceStorage');
    const insidersDir = path.join(
      tempHomeDir,
      '.config',
      'Code - Insiders',
      'User',
      'workspaceStorage',
    );

    const stableSession = path.join(stableDir, 'hash-a', 'chatSessions', 'stable.json');
    const insidersSession = path.join(insidersDir, 'hash-b', 'chatSessions', 'insiders.json');
    await mkdir(path.dirname(stableSession), { recursive: true });
    await mkdir(path.dirname(insidersSession), { recursive: true });
    await writeFile(stableSession, '{"requests":[]}', 'utf8');
    await writeFile(insidersSession, '{"requests":[]}', 'utf8');

    const files = await discoverCopilotVscodeSessionFiles({
      platform: 'linux',
      homeDir: tempHomeDir,
      env: {},
    });

    expect(files).toEqual([insidersSession, stableSession].sort());
  });

  it('scans only explicit workspaceStorageDir when provided', async () => {
    const explicitDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-vscode-explicit-'));
    tempDirs.push(explicitDir);

    const explicitSession = path.join(explicitDir, 'hash-a', 'chatSessions', 'explicit.json');
    await mkdir(path.dirname(explicitSession), { recursive: true });
    await writeFile(explicitSession, '{"requests":[]}', 'utf8');

    const files = await discoverCopilotVscodeSessionFiles({
      workspaceStorageDir: explicitDir,
      platform: 'linux',
      homeDir: '/nonexistent-home',
      env: {},
    });

    expect(files).toEqual([explicitSession]);
  });
});
