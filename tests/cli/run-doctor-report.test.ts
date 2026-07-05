import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDoctorResults,
  runDoctorReport,
  type DoctorSourceResult,
} from '../../src/cli/run-doctor-report.js';
import type { DoctorCommandOptions } from '../../src/cli/usage-data-contracts.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

async function createDoctorFixtureOptions(): Promise<DoctorCommandOptions> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-fixtures-'));
  tempDirs.push(rootDir);

  const piDir = path.join(rootDir, 'pi');
  const codexDir = path.join(rootDir, 'codex');
  const copilotDir = path.join(rootDir, 'copilot');
  const geminiDir = path.join(rootDir, 'gemini');
  const droidDir = path.join(rootDir, 'droid');
  const claudeDir = path.join(rootDir, 'claude');
  const openclawDir = path.join(rootDir, 'openclaw');
  const opencodeDb = path.join(rootDir, 'opencode.db');

  await mkdir(path.join(geminiDir, 'tmp', 'project', 'chats'), { recursive: true });
  await mkdir(path.join(claudeDir, 'project'), { recursive: true });
  await mkdir(piDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await mkdir(copilotDir, { recursive: true });
  await mkdir(droidDir, { recursive: true });
  await mkdir(openclawDir, { recursive: true });

  await writeFile(path.join(piDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(codexDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(copilotDir, 'otel.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(geminiDir, 'tmp', 'project', 'chats', 'session.json'), '{}', 'utf8');
  await writeFile(path.join(droidDir, 'session.settings.json'), '{}', 'utf8');
  await writeFile(path.join(claudeDir, 'project', 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(openclawDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(opencodeDb, '', 'utf8');

  return {
    piDir,
    codexDir,
    copilotDir,
    geminiDir,
    droidDir,
    claudeDir,
    openclawDir,
    opencodeDb,
  };
}

function sourceById(results: DoctorSourceResult[]): Map<string, DoctorSourceResult> {
  return new Map(results.map((result) => [result.id, result]));
}

function captureStdout(): {
  getOutput: () => string;
  restore: () => void;
} {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });

  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      writeSpy.mockRestore();
    },
  };
}

describe('run-doctor-report', () => {
  it('discovers all sources in registration order', async () => {
    const options = await createDoctorFixtureOptions();

    const results = await buildDoctorResults(options);

    expect(results).toEqual([
      { id: 'pi', status: 'ok', itemsFound: 1 },
      { id: 'codex', status: 'ok', itemsFound: 1 },
      { id: 'gemini', status: 'ok', itemsFound: 1 },
      { id: 'droid', status: 'ok', itemsFound: 1 },
      { id: 'opencode', status: 'ok', itemsFound: 1 },
      { id: 'openclaw', status: 'ok', itemsFound: 1 },
      { id: 'claude', status: 'ok', itemsFound: 1 },
      { id: 'copilot', status: 'ok', itemsFound: 1 },
    ]);
  });

  it('reports one source error without stopping other source checks', async () => {
    const options = await createDoctorFixtureOptions();
    const missingClaudeDir = path.join(os.tmpdir(), `missing-claude-${Date.now()}`);

    const results = await buildDoctorResults({
      ...options,
      claudeDir: missingClaudeDir,
    });
    const resultsBySource = sourceById(results);
    const claudeResult = resultsBySource.get('claude');
    const nonClaudeResults = results.filter((result) => result.id !== 'claude');

    expect(claudeResult?.id).toBe('claude');
    expect(claudeResult?.status).toBe('error');
    expect(claudeResult?.error).toContain(missingClaudeDir);
    expect(nonClaudeResults.every((result) => result.status === 'ok')).toBe(true);
  });

  it('filters doctor results with comma-separated source filters', async () => {
    const options = await createDoctorFixtureOptions();

    const results = await buildDoctorResults({
      ...options,
      source: 'gemini,claude',
    });

    expect(results.map((result) => result.id)).toEqual(['gemini', 'claude']);
  });

  it('rejects unknown source filters with the shared error wording', async () => {
    await expect(buildDoctorResults({ source: 'unknown' })).rejects.toThrow(
      'Unknown --source value(s): unknown. Allowed values:',
    );
  });

  it('prints plain text output to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const stdout = captureStdout();

    try {
      await runDoctorReport({
        ...options,
        source: 'gemini',
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.getOutput()).toContain('gemini  ok');
    expect(stdout.getOutput()).toContain('1/1 sources healthy');
  });

  it('prints plain text error details to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const missingClaudeDir = path.join(os.tmpdir(), `missing-claude-${Date.now()}`);
    const stdout = captureStdout();

    try {
      await runDoctorReport({
        ...options,
        claudeDir: missingClaudeDir,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.getOutput()).toContain('claude');
    expect(stdout.getOutput()).toContain('error');
    expect(stdout.getOutput()).toContain(missingClaudeDir);
    expect(stdout.getOutput()).toContain('7/8 sources healthy');
  });

  it('prints JSON output to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const stdout = captureStdout();

    try {
      await runDoctorReport({
        ...options,
        source: 'gemini',
        json: true,
      });
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.getOutput())).toEqual({
      sources: [{ id: 'gemini', status: 'ok', itemsFound: 1 }],
    });
  });
});
