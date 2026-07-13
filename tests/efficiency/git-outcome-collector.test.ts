import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  collectGitOutcomes,
  parseGitLogShortstatLines,
} from '../../src/efficiency/git-outcome-collector.js';

const marker = '\u001f';

describe('parseGitLogShortstatLines', () => {
  it('parses commit boundaries and shortstat lines', () => {
    const { events } = parseGitLogShortstatLines([
      `${marker}1760090400${marker}abcdef1${marker}dev@example.com`,
      ' 1 file changed, 12 insertions(+), 3 deletions(-)',
      '',
      `${marker}1760094000${marker}abcdef2${marker}dev@example.com`,
      ' 2 files changed, 5 deletions(-)',
      `${marker}1760097600${marker}abcdef3${marker}dev@example.com`,
    ]);

    expect(events).toEqual([
      {
        sha: 'abcdef1',
        timestamp: '2025-10-10T10:00:00.000Z',
        linesAdded: 12,
        linesDeleted: 3,
        linesChanged: 15,
      },
      {
        sha: 'abcdef2',
        timestamp: '2025-10-10T11:00:00.000Z',
        linesAdded: 0,
        linesDeleted: 5,
        linesChanged: 5,
      },
      {
        sha: 'abcdef3',
        timestamp: '2025-10-10T12:00:00.000Z',
        linesAdded: 0,
        linesDeleted: 0,
        linesChanged: 0,
      },
    ]);
  });

  it('filters out commits that do not match the configured author email', () => {
    const { events } = parseGitLogShortstatLines(
      [
        `${marker}1760090400${marker}abcdef1${marker}dev.test+tools@example.com`,
        ' 1 file changed, 2 insertions(+)',
        `${marker}1760094000${marker}abcdef2${marker}devXtest+tools@exampleXcom`,
        ' 1 file changed, 9 insertions(+)',
      ],
      'dev.test+tools@example.com',
    );

    expect(events).toEqual([
      {
        sha: 'abcdef1',
        timestamp: '2025-10-10T10:00:00.000Z',
        linesAdded: 2,
        linesDeleted: 0,
        linesChanged: 2,
      },
    ]);
  });

  it('ignores non-commit lines before the first boundary', () => {
    const { events } = parseGitLogShortstatLines([
      'noise before first commit',
      `${marker}1760090400${marker}abcdef1${marker}dev@example.com`,
      ' 1 file changed, 2 insertions(+)',
    ]);

    expect(events).toEqual([
      {
        sha: 'abcdef1',
        timestamp: '2025-10-10T10:00:00.000Z',
        linesAdded: 2,
        linesDeleted: 0,
        linesChanged: 2,
      },
    ]);
  });

  it('skips a malformed commit boundary and keeps surrounding commits', () => {
    const { events, malformedCommitLines } = parseGitLogShortstatLines([
      `${marker}1760090400${marker}abcdef1${marker}dev@example.com`,
      ' 1 file changed, 2 insertions(+)',
      `${marker}1760094000${marker}abcdef2${marker}evil${marker}@example.com`,
      ' 1 file changed, 9 insertions(+)',
      `${marker}1760097600${marker}abcdef3${marker}dev@example.com`,
      ' 1 file changed, 4 insertions(+)',
    ]);

    expect(events.map((event) => event.sha)).toEqual(['abcdef1', 'abcdef3']);
    expect(events[0]?.linesAdded).toBe(2);
    expect(events[1]?.linesAdded).toBe(4);
    expect(malformedCommitLines).toBe(1);
  });

  it('throws when commit timestamp cannot be converted to ISO date', () => {
    expect(() =>
      parseGitLogShortstatLines([
        `${marker}9999999999999999${marker}abcdef1${marker}dev@example.com`,
      ]),
    ).toThrow('Invalid git commit timestamp');
  });
});

describe('collectGitOutcomes', () => {
  it('fails fast when repo dir is not a git repository', async () => {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), 'git-outcomes-non-git-'));

    try {
      await expect(
        collectGitOutcomes({
          repoDir: nonGitDir,
          granularity: 'daily',
          timezone: 'UTC',
        }),
      ).rejects.toThrow(`Repository is not a git repository: ${nonGitDir}`);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('collects and aggregates outcomes with date filtering and default no-merges', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['Dev.Test+Tools@Example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [
          `${marker}1770681600${marker}abcdef1${marker}devXtest+tools@exampleXcom`,
          ' 1 file changed, 9 insertions(+), 1 deletion(-)',
          `${marker}1770681600${marker}abcdef2${marker}dev.test+tools@example.com`,
          ' 1 file changed, 1 insertion(+), 1 deletion(-)',
          `${marker}1770771600${marker}abcdef3${marker}dev.test+tools@example.com`,
          ' 2 files changed, 4 insertions(+), 2 deletions(-)',
        ],
        stderr: '',
        exitCode: 0,
      };
    });

    const result = await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
        since: '2026-02-11',
        until: '2026-02-11',
      },
      { runGitCommand },
    );

    expect(runGitCommand).toHaveBeenCalledTimes(2);
    const configArgs = (runGitCommand.mock.calls[0]?.[1] as string[] | undefined) ?? [];
    const args = (runGitCommand.mock.calls[1]?.[1] as string[] | undefined) ?? [];

    expect(configArgs).toEqual(['config', '--get', 'user.email']);

    expect(args).toContain('--no-merges');
    expect(args).toContain('--regexp-ignore-case');
    expect(args).toContain('--author=<Dev\\.Test\\+Tools@Example\\.com>');
    expect(args).toContain(`--pretty=format:${marker}%ct${marker}%H${marker}%ae`);
    expect(args).toContain('--since=2026-02-10T00:00:00Z');
    expect(args).toContain('--until=2026-02-12T23:59:59Z');
    expect(args).toContain('--shortstat');

    expect([...result.periodOutcomes.entries()]).toEqual([
      [
        '2026-02-11',
        {
          commitCount: 1,
          linesAdded: 4,
          linesDeleted: 2,
          linesChanged: 6,
        },
      ],
    ]);

    expect(result.totalOutcomes).toEqual({
      commitCount: 1,
      linesAdded: 4,
      linesDeleted: 2,
      linesChanged: 6,
    });
    expect(result.diagnostics.includeMergeCommits).toBe(false);
    expect(result.diagnostics.commitsCollected).toBe(1);
  });

  it('omits --no-merges when includeMergeCommits is enabled', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [`${marker}1770771600${marker}abcdef2${marker}dev@example.com`],
        stderr: '',
        exitCode: 0,
      };
    });

    await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
        includeMergeCommits: true,
      },
      { runGitCommand },
    );

    const args = (runGitCommand.mock.calls[1]?.[1] as string[] | undefined) ?? [];
    expect(args).not.toContain('--no-merges');
    expect(args).toContain('--author=<dev@example\\.com>');
  });

  it('fails when user.email is missing', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async () => ({
      lines: [],
      stderr: '',
      exitCode: 1,
    }));

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow('Git user.email is not configured for');
  });

  it('falls back to global git user.email when local repo user.email is unset', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config' && args[1] === '--get') {
        return {
          lines: [],
          stderr: '',
          exitCode: 1,
        };
      }

      if (args[0] === 'config' && args[1] === '--global') {
        return {
          lines: ['global@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [`${marker}1770771600${marker}abcdef2${marker}global@example.com`],
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).resolves.toMatchObject({
      diagnostics: {
        commitsCollected: 1,
      },
    });

    const gitLogArgs = runGitCommand.mock.calls.at(-1)?.[1] ?? [];
    expect(gitLogArgs).toContain('--author=<global@example\\.com>');
  });

  it('falls back to git author identity when config user.email is unavailable', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: [],
          stderr: '',
          exitCode: 1,
        };
      }

      if (args[0] === 'var') {
        return {
          lines: ['Dev Test <ident@example.com> 1770771600 +0000'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [`${marker}1770771600${marker}abcdef2${marker}ident@example.com`],
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).resolves.toMatchObject({
      diagnostics: {
        commitsCollected: 1,
      },
    });

    const gitLogArgs = runGitCommand.mock.calls.at(-1)?.[1] ?? [];
    expect(gitLogArgs).toContain('--author=<ident@example\\.com>');
  });

  it('requires configured git user.email when commits exist', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: [],
          stderr: '',
          exitCode: 1,
        };
      }

      if (args[0] === 'rev-parse') {
        return {
          lines: ['deadbeef'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [],
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow('Git user.email is not configured for /tmp/repo');
  });

  it('fails with git stderr when resolving user.email errors for unexpected exit codes', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async () => ({
      lines: [],
      stderr: 'fatal: unable to read config file',
      exitCode: 2,
    }));

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow(
      'Failed to resolve git user.email from /tmp/repo: fatal: unable to read config file',
    );
  });

  it('fails when user.email resolves to blank output', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['   '],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [],
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow('Git user.email is not configured for /tmp/repo');
  });

  it('includes fallback exit-code reason when git log fails without stderr', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [],
        stderr: '',
        exitCode: 3,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow('Failed to collect git outcomes from /tmp/repo: git exited with code 3');
  });

  it('fails fast on invalid date literals when building git log args', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [`${marker}1770771600${marker}abcdef2${marker}dev@example.com`],
        stderr: '',
        exitCode: 0,
      };
    });

    await expect(
      collectGitOutcomes(
        {
          repoDir: '/tmp/repo',
          granularity: 'daily',
          timezone: 'UTC',
          since: 'not-a-date',
          until: 'still-not-a-date',
        },
        { runGitCommand },
      ),
    ).rejects.toThrow('Invalid date value: not-a-date');
    expect(runGitCommand).toHaveBeenCalledTimes(1);
  });

  it('counts only commits that fall on days with attributed usage', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [
          `${marker}1770681600${marker}abcdef1${marker}dev@example.com`,
          ' 1 file changed, 9 insertions(+), 1 deletion(-)',
          `${marker}1770771600${marker}abcdef2${marker}dev@example.com`,
          ' 1 file changed, 1 insertion(+), 1 deletion(-)',
        ],
        stderr: '',
        exitCode: 0,
      };
    });

    const result = await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
        activeUsageDays: new Set(['2026-02-11']),
      },
      { runGitCommand },
    );

    expect([...result.periodOutcomes.entries()]).toEqual([
      [
        '2026-02-11',
        {
          commitCount: 1,
          linesAdded: 1,
          linesDeleted: 1,
          linesChanged: 2,
        },
      ],
    ]);
    expect(result.totalOutcomes.commitCount).toBe(1);
  });

  it('uses active usage day window to bound git log when explicit since/until are not provided', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [],
        stderr: '',
        exitCode: 0,
      };
    });

    await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
        activeUsageDays: new Set(['2026-02-11', '2026-02-13']),
      },
      { runGitCommand },
    );

    const args = (runGitCommand.mock.calls[1]?.[1] as string[] | undefined) ?? [];
    expect(args).toContain('--since=2026-02-10T00:00:00Z');
    expect(args).toContain('--until=2026-02-14T23:59:59Z');
  });

  it('returns zero outcomes when active usage day set is empty', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [`${marker}1770771600${marker}abcdef2${marker}dev@example.com`],
        stderr: '',
        exitCode: 0,
      };
    });

    const result = await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
        activeUsageDays: new Set(),
      },
      { runGitCommand },
    );

    expect(runGitCommand).not.toHaveBeenCalled();
    expect(result.totalOutcomes).toEqual({
      commitCount: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesChanged: 0,
    });
  });

  it('returns zero outcomes when git reports no commit history', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: ['dev@example.com'],
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        lines: [],
        stderr: "fatal: your current branch 'master' does not have any commits yet",
        exitCode: 128,
      };
    });

    const result = await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
      },
      { runGitCommand },
    );

    expect(result.periodOutcomes.size).toBe(0);
    expect(result.totalOutcomes).toEqual({
      commitCount: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesChanged: 0,
    });
  });

  it('returns zero outcomes when user.email is missing but repo has no commits', async () => {
    const runGitCommand = vi.fn<
      (
        repoDir: string,
        args: string[],
      ) => Promise<{ lines: string[]; stderr: string; exitCode: number }>
    >(async (_repoDir, args) => {
      if (args[0] === 'config') {
        return {
          lines: [],
          stderr: '',
          exitCode: 1,
        };
      }

      return {
        lines: [],
        stderr: 'fatal: Needed a single revision',
        exitCode: 128,
      };
    });

    const result = await collectGitOutcomes(
      {
        repoDir: '/tmp/repo',
        granularity: 'daily',
        timezone: 'UTC',
      },
      { runGitCommand },
    );

    expect(result.totalOutcomes.commitCount).toBe(0);
    expect(runGitCommand).toHaveBeenCalledWith('/tmp/repo', ['rev-parse', '--verify', 'HEAD']);
  });

  it('rejects blank --repo-dir values', async () => {
    await expect(
      collectGitOutcomes({
        repoDir: '   ',
        granularity: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toThrow('--repo-dir must be a non-empty path');
  });

  it('fails fast when the configured repo path does not exist', async () => {
    const missingRepoPath = `/tmp/llm-usage-metrics-missing-repo-${Date.now()}`;

    await expect(
      collectGitOutcomes({
        repoDir: missingRepoPath,
        granularity: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(`Repository path does not exist: ${missingRepoPath}`);
  });
});
