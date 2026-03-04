import { describe, expect, it, vi } from 'vitest';

import { openShareSvgFile, resolveOpenCommand } from '../../src/cli/share-artifact.js';

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
      const spawnDetached = vi.fn(async () => undefined);

      await openShareSvgFile('/tmp/share.svg', {
        platform: 'darwin',
        spawnDetached,
      });

      expect(spawnDetached).toHaveBeenCalledWith('open', ['/tmp/share.svg']);
    });
  });
});
