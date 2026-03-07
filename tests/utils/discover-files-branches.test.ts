import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: fsMocks.readdir,
  realpath: fsMocks.realpath,
  stat: fsMocks.stat,
}));

import { discoverFiles } from '../../src/utils/discover-files.js';

type MockDirent = {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
};

function createDirent(name: string, kind: 'directory' | 'file' | 'symlink'): MockDirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

afterEach(() => {
  fsMocks.readdir.mockReset();
  fsMocks.realpath.mockReset();
  fsMocks.stat.mockReset();
});

describe('discoverFiles branch coverage', () => {
  it('returns empty when the root disappears before realpath resolves', async () => {
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.realpath.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(discoverFiles('/tmp/root', { extension: '.json' })).resolves.toEqual([]);
  });

  it('skips root realpath permission errors when allowPermissionSkip is enabled', async () => {
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.realpath.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 'EPERM' }));

    await expect(discoverFiles('/tmp/root', { extension: '.json' })).resolves.toEqual([]);
  });

  it('rethrows unexpected root realpath failures', async () => {
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.realpath.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EIO' }));

    await expect(discoverFiles('/tmp/root', { extension: '.json' })).rejects.toThrow('boom');
  });

  it('skips symlink inspection permission errors when allowPermissionSkip is enabled', async () => {
    fsMocks.readdir.mockResolvedValue([createDirent('alias.json', 'symlink')]);
    fsMocks.realpath.mockResolvedValue('/tmp/root');
    fsMocks.stat.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 'EACCES' }));

    await expect(discoverFiles('/tmp/root', { extension: '.json' })).resolves.toEqual([]);
  });

  it('rethrows unexpected symlink inspection failures', async () => {
    fsMocks.readdir.mockResolvedValue([createDirent('alias.json', 'symlink')]);
    fsMocks.realpath.mockResolvedValue('/tmp/root');
    fsMocks.stat.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EIO' }));

    await expect(discoverFiles('/tmp/root', { extension: '.json' })).rejects.toThrow('boom');
  });
});
