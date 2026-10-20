import { describe, expect, it } from 'vitest';

import type { ProjectRow, ProjectsData } from '../../src/cli/build-projects-data.js';
import { renderProjectsReportWithNotes } from '../../src/render/render-projects-report.js';

function projectRow(project: string, totalTokens: number, costUsd: number): ProjectRow {
  return {
    repoRoot: `/home/user/${project}`,
    project,
    inputTokens: totalTokens / 2,
    outputTokens: totalTokens / 4,
    reasoningTokens: 0,
    cacheReadTokens: totalTokens / 4,
    cacheWriteTokens: 0,
    totalTokens,
    costUsd,
    costShare: 1,
    events: 154_460,
    activeDays: 20,
    topModels: ['claude-opus-5-5', 'claude-sonnet-4-5', 'gpt-5'],
  };
}

function createProjectsData(): ProjectsData {
  const projects = [
    projectRow('clients/acme-corporation/monorepo/services/billing-api', 26_109_906_746, 10_543.08),
  ];
  const [row] = projects;

  return {
    totals: { ...row, projects: 1 },
    projects,
  };
}

describe('renderProjectsReportWithNotes', () => {
  const notesAt = (terminalWidth: number) =>
    renderProjectsReportWithNotes(createProjectsData(), 'terminal', {
      useColor: false,
      terminalWidth,
    });

  it('says rows were listed on an 80-column terminal, outside stdout', () => {
    const { output, notes } = notesAt(80);

    expect(notes).toEqual([
      'Listed rows instead of a table to fit the terminal. Widen the terminal to see the table.',
    ]);
    expect(output).not.toContain('╭');
    expect(output).not.toContain(notes[0]);
  });

  it('has no note when the table fits, or for markdown and json', () => {
    expect(notesAt(400).notes).toEqual([]);

    for (const format of ['markdown', 'json'] as const) {
      expect(
        renderProjectsReportWithNotes(createProjectsData(), format, { terminalWidth: 44 }).notes,
      ).toEqual([]);
    }
  });
});
