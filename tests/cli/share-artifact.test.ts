import { describe, expect, it, vi } from 'vitest';

import {
  openShareSvgFile,
  resolveOpenCommand,
  writeAndOpenShareSvgFile,
} from '../../src/cli/share-artifact.js';

describe('share-artifact', () => {
  describe('resolveOpenCommand', () => {
    it('uses open on macOS', () => {
      expect(resolveOpenCommand('/tmp/share.svg', 'darwin')).toEqual({
        command: 'open',
        args: ['/tmp/share.svg'],
      });
    });

    it('uses cmd start on Windows', () => {
      expect(resolveOpenCommand('C:\\temp\\share.svg', 'win32')).toEqual({
        command: 'cmd',
        args: ['/c', 'start', '', 'C:\\temp\\share.svg'],
      });
    });

    it('uses xdg-open on Linux and other Unix-like platforms', () => {
      expect(resolveOpenCommand('/tmp/share.svg', 'linux')).toEqual({
        command: 'xdg-open',
        args: ['/tmp/share.svg'],
      });
      expect(resolveOpenCommand('/tmp/share.svg', 'freebsd')).toEqual({
        command: 'xdg-open',
        args: ['/tmp/share.svg'],
      });
    });
  });

  describe('openShareSvgFile', () => {
    it('delegates to injected detached opener with resolved command', async () => {
      const previousVitest = process.env.VITEST;
      const previousNodeEnv = process.env.NODE_ENV;
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      const spawnDetached = vi.fn(async () => undefined);

      try {
        await openShareSvgFile('/tmp/share.svg', {
          platform: 'darwin',
          spawnDetached,
        });
      } finally {
        if (previousVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = previousVitest;
        }

        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previousNodeEnv;
        }
      }

      expect(spawnDetached).toHaveBeenCalledWith('open', ['/tmp/share.svg']);
    });

    it('no-ops in automated test environment', async () => {
      const previousVitest = process.env.VITEST;
      process.env.VITEST = 'true';

      const spawnDetached = vi.fn(async () => undefined);
      try {
        await openShareSvgFile('/tmp/share.svg', {
          platform: 'darwin',
          spawnDetached,
        });
      } finally {
        if (previousVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = previousVitest;
        }
      }

      expect(spawnDetached).not.toHaveBeenCalled();
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
  });
});
