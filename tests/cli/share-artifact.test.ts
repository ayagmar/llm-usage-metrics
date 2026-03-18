import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  openShareSvgFile,
  resolveOpenCommand,
  writeAndOpenShareSvgFile,
} from '../../src/cli/share-artifact.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  writeFile: vi.fn(),
}));

describe('share-artifact', () => {
  describe('resolveOpenCommand', () => {
    it('uses the system open binary on macOS when it exists', async () => {
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('/tmp/share.svg', 'darwin');

      expect(result).toEqual({
        command: '/usr/bin/open',
        args: ['/tmp/share.svg'],
      });
    });

    it('falls back to PATH lookup on macOS when system binary is missing', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('not found')).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('/tmp/share.svg', 'darwin');

      expect(result.command).toMatch(/\bopen$/);
      expect(result.args).toEqual(['/tmp/share.svg']);
    });

    it('uses rundll32 ShellExec on Windows when it exists', async () => {
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('C:\\temp\\share.svg', 'win32');

      expect(result).toEqual({
        command: 'C:\\Windows\\System32\\rundll32.exe',
        args: ['shell32.dll,ShellExec_RunDLL', 'C:\\temp\\share.svg'],
      });
    });

    it('falls back to PATH lookup on Windows when system binary is missing', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('not found')).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('C:\\temp\\share.svg', 'win32');

      expect(result.command).toMatch(/\brundll32\.exe$/);
      expect(result.args).toEqual(['shell32.dll,ShellExec_RunDLL', 'C:\\temp\\share.svg']);
    });

    it('uses the system xdg-open binary on Linux when it exists', async () => {
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('/tmp/share.svg', 'linux');

      expect(result).toEqual({
        command: '/usr/bin/xdg-open',
        args: ['/tmp/share.svg'],
      });
    });

    it('falls back to PATH lookup on Linux when system binary is missing', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('not found')).mockResolvedValue(undefined);

      const result = await resolveOpenCommand('/tmp/share.svg', 'linux');

      expect(result.command).toMatch(/\bxdg-open$/);
      expect(result.args).toEqual(['/tmp/share.svg']);
    });

    it('throws a clear error when no opener is found', async () => {
      vi.mocked(access).mockRejectedValue(new Error('not found'));

      await expect(resolveOpenCommand('/tmp/share.svg', 'linux')).rejects.toThrow(
        'Could not find xdg-open. Please install xdg-utils or ensure it is in your PATH.',
      );
    });
  });

  describe('openShareSvgFile', () => {
    it('delegates to injected detached opener with resolved command', async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      const spawnDetached = vi.fn(async () => undefined);

      await openShareSvgFile('/tmp/share.svg', {
        platform: 'darwin',
        spawnDetached,
      });

      expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/open', ['/tmp/share.svg']);
    });

    it('uses the non-shell Windows opener when requested', async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      const spawnDetached = vi.fn(async () => undefined);

      await openShareSvgFile('C:\\temp\\share.svg', {
        platform: 'win32',
        spawnDetached,
      });

      expect(spawnDetached).toHaveBeenCalledWith('C:\\Windows\\System32\\rundll32.exe', [
        'shell32.dll,ShellExec_RunDLL',
        'C:\\temp\\share.svg',
      ]);
    });
  });

  describe('writeAndOpenShareSvgFile', () => {
    it('writes then opens and reports success', async () => {
      const writeShareSvgFileFn = vi.fn(async () => '/tmp/share.svg');
      const openShareSvgFileFn = vi.fn(async () => undefined);

      const result = await writeAndOpenShareSvgFile('usage-monthly-share.svg', '<svg/>', {
        writeShareSvgFileFn,
        openShareSvgFileFn,
      });

      expect(writeShareSvgFileFn).toHaveBeenCalledWith('usage-monthly-share.svg', '<svg/>');
      expect(openShareSvgFileFn).toHaveBeenCalledWith('/tmp/share.svg');
      expect(result).toEqual({
        outputPath: '/tmp/share.svg',
        opened: true,
      });
    });

    it('returns non-fatal open failure details', async () => {
      const writeShareSvgFileFn = vi.fn(async () => '/tmp/share.svg');
      const openShareSvgFileFn = vi.fn(async () => {
        throw new Error('open failed');
      });

      const result = await writeAndOpenShareSvgFile('usage-monthly-share.svg', '<svg/>', {
        writeShareSvgFileFn,
        openShareSvgFileFn,
      });

      expect(result).toEqual({
        outputPath: '/tmp/share.svg',
        opened: false,
        openErrorMessage: 'open failed',
      });
    });

    it('stringifies non-Error open failures', async () => {
      const writeShareSvgFileFn = vi.fn(async () => '/tmp/share.svg');
      const nonErrorRejection = 'open failed as string' as unknown as Error;
      const openShareSvgFileFn = vi.fn(() => Promise.reject(nonErrorRejection));

      const result = await writeAndOpenShareSvgFile('usage-monthly-share.svg', '<svg/>', {
        writeShareSvgFileFn,
        openShareSvgFileFn,
      });

      expect(result).toEqual({
        outputPath: '/tmp/share.svg',
        opened: false,
        openErrorMessage: 'open failed as string',
      });
    });

    it('returns pre-flight error when opener binary is not found', async () => {
      vi.mocked(access).mockRejectedValue(new Error('not found'));
      const writeShareSvgFileFn = vi.fn(async () => '/tmp/share.svg');

      const result = await writeAndOpenShareSvgFile('usage-monthly-share.svg', '<svg/>', {
        writeShareSvgFileFn,
      });

      expect(result.outputPath).toBe('/tmp/share.svg');
      expect(result.opened).toBe(false);
      expect(result.openErrorMessage).toContain('Could not find xdg-open');
    });
  });
});
