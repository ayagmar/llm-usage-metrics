import { describe, expect, it, vi } from 'vitest';

import {
  openShareSvgFile,
  resolveOpenCommand,
  writeAndOpenShareSvgFile,
} from '../../src/cli/share-artifact.js';

describe('share-artifact', () => {
  describe('resolveOpenCommand', () => {
    it('uses the system open binary on macOS', () => {
      expect(resolveOpenCommand('/tmp/share.svg', 'darwin')).toEqual({
        command: '/usr/bin/open',
        args: ['/tmp/share.svg'],
      });
    });

    it('uses rundll32 ShellExec on Windows', () => {
      expect(resolveOpenCommand('C:\\temp\\share.svg', 'win32')).toEqual({
        command: 'C:\\Windows\\System32\\rundll32.exe',
        args: ['shell32.dll,ShellExec_RunDLL', 'C:\\temp\\share.svg'],
      });
    });

    it('uses the system xdg-open binary on Linux and other Unix-like platforms', () => {
      expect(resolveOpenCommand('/tmp/share.svg', 'linux')).toEqual({
        command: '/usr/bin/xdg-open',
        args: ['/tmp/share.svg'],
      });
      expect(resolveOpenCommand('/tmp/share.svg', 'freebsd')).toEqual({
        command: '/usr/bin/xdg-open',
        args: ['/tmp/share.svg'],
      });
    });
  });

  describe('openShareSvgFile', () => {
    it('delegates to injected detached opener with resolved command', async () => {
      const spawnDetached = vi.fn(async () => undefined);

      await openShareSvgFile('/tmp/share.svg', {
        platform: 'darwin',
        spawnDetached,
      });

      expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/open', ['/tmp/share.svg']);
    });

    it('uses the non-shell Windows opener when requested', async () => {
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
  });
});
