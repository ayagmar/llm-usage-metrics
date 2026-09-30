import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

/**
 * Materialize a committed `tests/fixtures/e2e/dsh` text fixture as the
 * compressed session logs the harness writes on disk. Fixtures stay text so
 * they are reviewable; only the encoding used by the real source is generated
 * at test time.
 */
export async function createDshSessionsFixture(targetDir: string): Promise<void> {
  const fixtureRoot = path.resolve('tests/fixtures/e2e/dsh');
  const sessionDirs = await collectSessionDirs(fixtureRoot);

  for (const sessionDir of sessionDirs) {
    const relativeDir = path.relative(fixtureRoot, sessionDir);
    const logPath = path.join(targetDir, relativeDir, 'session.v3.jsonl.zstd');
    const logText = await readFile(path.join(sessionDir, 'session.v3.jsonl'), 'utf8');

    await mkdir(path.dirname(logPath), { recursive: true });
    // One frame per line, the way the harness appends.
    await writeFile(
      logPath,
      Buffer.concat(
        logText
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => zstdCompressSync(Buffer.from(`${line.trim()}\n`, 'utf8'))),
      ),
    );
  }
}

async function collectSessionDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sessionDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(dir, entry.name);
    if (entry.name.startsWith('session-')) {
      sessionDirs.push(entryPath);
      continue;
    }

    sessionDirs.push(...(await collectSessionDirs(entryPath)));
  }

  return sessionDirs;
}
