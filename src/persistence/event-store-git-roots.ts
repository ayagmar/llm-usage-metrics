import { runTransaction, toText, type EventStore } from './event-store-database.js';

// The git roots runs have found on disk, by project key, with the repository each belongs
// to: a repository belongs to itself, a worktree to the repository its `.git` file names.
// Once a worktree is deleted only this record still names its repository, and recorded
// repositories keep the names worktree folders are matched against the same whatever a
// run's window or sources.

/** Added without a schema version bump: older builds ignore it. */
export function createGitRootsSql(): string {
  return `
CREATE TABLE IF NOT EXISTS git_roots (
  root_key TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL
);`;
}

/** Every recorded git root's key and the key of the repository it belongs to. */
export function readGitRoots(store: EventStore): Map<string, string> {
  const roots = new Map<string, string>();

  for (const row of store.database.prepare('SELECT root_key, repo_key FROM git_roots').all()) {
    const rootKey = toText(row.root_key);
    const repoKey = toText(row.repo_key);

    if (rootKey && repoKey) {
      roots.set(rootKey, repoKey);
    }
  }

  return roots;
}

/**
 * Records git roots found on disk. A root already recorded keeps its first record, so a
 * path reused for another repository does not move the usage logged there before.
 */
export function recordGitRoots(store: EventStore, roots: ReadonlyMap<string, string>): void {
  if (roots.size === 0) {
    return;
  }

  runTransaction(store.database, () => {
    const insert = store.database.prepare(
      'INSERT INTO git_roots (root_key, repo_key) VALUES (?, ?) ON CONFLICT(root_key) DO NOTHING',
    );

    for (const [rootKey, repoKey] of roots) {
      insert.run(rootKey, repoKey);
    }
  });
}
