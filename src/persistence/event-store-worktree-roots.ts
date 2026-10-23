import { runTransaction, toText, type EventStore } from './event-store-database.js';

// The git worktrees runs have found on disk, by project key, with the repository each
// belongs to. A worktree's `.git` file names its repository, so once the worktree is
// deleted only this record still does.

/** Added without a schema version bump: older builds ignore it. */
export function createWorktreeRootsSql(): string {
  return `
CREATE TABLE IF NOT EXISTS worktree_roots (
  worktree_key TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL
);`;
}

/** Every recorded worktree's key and the key of the repository it belongs to. */
export function readWorktreeRoots(store: EventStore): Map<string, string> {
  const roots = new Map<string, string>();

  for (const row of store.database
    .prepare('SELECT worktree_key, repo_key FROM worktree_roots')
    .all()) {
    const worktreeKey = toText(row.worktree_key);
    const repoKey = toText(row.repo_key);

    if (worktreeKey && repoKey) {
      roots.set(worktreeKey, repoKey);
    }
  }

  return roots;
}

/** Records worktrees found on disk, replacing what was recorded for the same keys. */
export function recordWorktreeRoots(store: EventStore, roots: ReadonlyMap<string, string>): void {
  if (roots.size === 0) {
    return;
  }

  runTransaction(store.database, () => {
    const upsert = store.database.prepare(
      [
        'INSERT INTO worktree_roots (worktree_key, repo_key) VALUES (?, ?)',
        'ON CONFLICT(worktree_key) DO UPDATE SET repo_key = excluded.repo_key',
      ].join('\n'),
    );

    for (const [worktreeKey, repoKey] of roots) {
      upsert.run(worktreeKey, repoKey);
    }
  });
}
