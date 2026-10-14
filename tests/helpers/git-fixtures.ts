import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GIT_FIXTURE_AUTHOR_EMAIL = 'golden@example.com';

export type GitFixtureCommit = {
  /** ISO timestamp used as both author and committer date. */
  date: string;
  message: string;
  files: Record<string, string>;
};

/**
 * Environment that keeps git away from the machine's and the user's config, so `git log`
 * output never depends on them. Stub these into `process.env` while a report reads the
 * repo too: the efficiency report runs git with the inherited environment.
 */
export function isolatedGitEnv(emptyGlobalConfigPath: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfigPath,
  };
}

async function runGit(repoDir: string, args: string[], env: Record<string, string>): Promise<void> {
  await execFileAsync('git', ['-C', repoDir, ...args], { env: { ...process.env, ...env } });
}

/**
 * Creates `<parentDir>/repo` with the given commits, authored by
 * `GIT_FIXTURE_AUTHOR_EMAIL` at fixed dates, and `<parentDir>/empty-gitconfig` for
 * `isolatedGitEnv`. Returns the repo path.
 */
export async function createGitFixtureRepo(
  parentDir: string,
  commits: readonly GitFixtureCommit[],
): Promise<{ repoDir: string; globalConfigPath: string }> {
  const repoDir = path.join(parentDir, 'repo');
  const globalConfigPath = path.join(parentDir, 'empty-gitconfig');
  await mkdir(repoDir, { recursive: true });
  await writeFile(globalConfigPath, '');
  const env = isolatedGitEnv(globalConfigPath);

  await runGit(repoDir, ['init', '--quiet', '--initial-branch=main'], env);
  await runGit(repoDir, ['config', 'user.name', 'Golden Author'], env);
  await runGit(repoDir, ['config', 'user.email', GIT_FIXTURE_AUTHOR_EMAIL], env);
  await runGit(repoDir, ['config', 'commit.gpgsign', 'false'], env);

  for (const commit of commits) {
    for (const [relativePath, content] of Object.entries(commit.files)) {
      const filePath = path.join(repoDir, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }

    await runGit(repoDir, ['add', '--all'], env);
    await runGit(repoDir, ['commit', '--quiet', '-m', commit.message], {
      ...env,
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    });
  }

  return { repoDir, globalConfigPath };
}
