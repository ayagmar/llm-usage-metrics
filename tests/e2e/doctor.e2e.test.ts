import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctorReport } from '../../src/cli/run-doctor-report.js';

type DoctorJsonReport = {
  sources: Array<{
    id: string;
    status: 'ok' | 'error';
    itemsFound?: number;
    error?: string;
  }>;
};

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const selectedSources = ['pi', 'codex', 'gemini', 'droid', 'openclaw', 'claude'] as const;

function createDoctorOptions() {
  return {
    source: selectedSources.join(','),
    piDir,
    codexDir,
    geminiDir,
    droidDir,
    openclawDir,
    claudeDir,
    json: true,
  };
}

async function captureDoctorJson(options: Parameters<typeof runDoctorReport>[0]) {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.join(' ')}\n`);
  });

  try {
    await runDoctorReport(options);
  } finally {
    logSpy.mockRestore();
  }

  return JSON.parse(chunks.join('')) as DoctorJsonReport;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('doctor report e2e', () => {
  it('reports every selected fixture source as healthy', async () => {
    const report = await captureDoctorJson(createDoctorOptions());
    const sourcesById = new Map(report.sources.map((source) => [source.id, source]));

    for (const sourceId of selectedSources) {
      expect(sourcesById.get(sourceId)).toMatchObject({
        id: sourceId,
        status: 'ok',
      });
      expect(sourcesById.get(sourceId)?.itemsFound ?? 0).toBeGreaterThanOrEqual(1);
    }

    expect(sourcesById.has('event-store')).toBe(false);
  });

  it('returns an error row for a missing override directory', async () => {
    const report = await captureDoctorJson({
      ...createDoctorOptions(),
      source: 'pi',
      piDir: '/nonexistent-e2e',
    });

    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]).toMatchObject({
      id: 'pi',
      status: 'error',
    });
    expect(report.sources[0]?.error).toContain('/nonexistent-e2e');
  });
});
