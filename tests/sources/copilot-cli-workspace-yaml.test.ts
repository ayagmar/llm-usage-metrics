import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCopilotCliWorkspaceMetadata,
  parseCopilotCliWorkspaceYaml,
} from '../../src/sources/copilot-cli/copilot-cli-workspace-yaml.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('copilot-cli-workspace-yaml', () => {
  it('parses id and cwd scalar values from yaml-like content', () => {
    const result = parseCopilotCliWorkspaceYaml(
      ['# comment', 'id:  cli-123  ', 'cwd:  "/workspace/repo"', 'ignored: value'].join('\n'),
    );

    expect(result).toEqual({
      id: 'cli-123',
      cwd: '/workspace/repo',
    });
  });

  it('ignores blank and non-scalar values', () => {
    const result = parseCopilotCliWorkspaceYaml(
      ['id:', 'cwd: "   "', 'nested:', '  child: value'].join('\n'),
    );

    expect(result).toEqual({});
  });

  it('loads workspace metadata for events.jsonl files only', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-workspace-'));
    tempDirs.push(sessionDir);

    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const yamlPath = path.join(sessionDir, 'workspace.yaml');
    await writeFile(eventsPath, '{}\n', 'utf8');
    await writeFile(yamlPath, 'id: from-workspace\ncwd: /workspace/from-yaml\n', 'utf8');

    await expect(loadCopilotCliWorkspaceMetadata(eventsPath)).resolves.toEqual({
      id: 'from-workspace',
      cwd: '/workspace/from-yaml',
    });

    await expect(
      loadCopilotCliWorkspaceMetadata(path.join(sessionDir, 'flat.jsonl')),
    ).resolves.toEqual({});
  });

  it('returns empty metadata when workspace.yaml is missing or unreadable', async () => {
    const missingDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-workspace-missing-'));
    tempDirs.push(missingDir);
    const missingEventsPath = path.join(missingDir, 'events.jsonl');
    await writeFile(missingEventsPath, '{}\n', 'utf8');

    await expect(loadCopilotCliWorkspaceMetadata(missingEventsPath)).resolves.toEqual({});

    const unreadableDir = await mkdtemp(
      path.join(os.tmpdir(), 'copilot-cli-workspace-unreadable-'),
    );
    tempDirs.push(unreadableDir);
    const unreadableEventsPath = path.join(unreadableDir, 'events.jsonl');
    const workspacePath = path.join(unreadableDir, 'workspace.yaml');
    await writeFile(unreadableEventsPath, '{}\n', 'utf8');
    await mkdir(workspacePath);

    await expect(loadCopilotCliWorkspaceMetadata(unreadableEventsPath)).resolves.toEqual({});
  });
});
