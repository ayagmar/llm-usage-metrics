import { describe, expect, it, vi } from 'vitest';

import type { ProjectsDataResult } from '../../src/cli/build-projects-data.js';

const totals = {
  inputTokens: 30,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 30,
  costUsd: 3,
};

const projectsData: ProjectsDataResult = {
  totals: { ...totals, projects: 2, events: 3, activeDays: 1 },
  projects: [
    {
      ...totals,
      totalTokens: 20,
      inputTokens: 20,
      costUsd: 2,
      repoRoot: '/w/api',
      project: 'api',
      costShare: 2 / 3,
      events: 2,
      activeDays: 1,
      topModels: ['gpt-5'],
    },
  ],
  limitNote: 'Showing the top 1 of 2 projects by cost over the whole window.',
  diagnostics: {
    sessionStats: [],
    sourceFailures: [],
    skippedRows: [],
    pricingOrigin: 'none',
    activeEnvOverrides: [],
    timezone: 'UTC',
  },
};

vi.mock('../../src/cli/build-projects-data.js', () => ({
  buildProjectsData: vi.fn(async () => projectsData),
}));

import { runProjectsReport } from '../../src/cli/run-projects-report.js';

describe('runProjectsReport', () => {
  it('prints only the report on stdout and the --top note on stderr', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runProjectsReport({ json: true, top: '1' });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(stdoutBody) as {
        report: string;
        data: { projects: { project: string }[]; totals: { projects: number } };
      };

      expect(parsed.report).toBe('projects');
      expect(parsed.data.projects.map((project) => project.project)).toEqual(['api']);
      expect(parsed.data.totals.projects).toBe(2);
      expect(stdoutBody).not.toContain('Showing the top');

      const stderrBody = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderrBody).toContain(
        'Showing the top 1 of 2 projects by cost over the whole window.',
      );
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
