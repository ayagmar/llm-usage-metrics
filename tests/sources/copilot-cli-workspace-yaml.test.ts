import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCopilotCliWorkspaceMetadata,
  parseCopilotCliWorkspaceYaml,
} from '../../src/sources/copilot-cli/copilot-cli-workspace-yaml.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((tempDir) => fsPromises.rm(tempDir, { recursive: true, force: true })),
  );
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
    const sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'copilot-cli-workspace-'));
    tempDirs.push(sessionDir);

    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const yamlPath = path.join(sessionDir, 'workspace.yaml');
    await fsPromises.writeFile(eventsPath, '{}\n', 'utf8');
    await fsPromises.writeFile(yamlPath, 'id: from-workspace\ncwd: /workspace/from-yaml\n', 'utf8');

    await expect(loadCopilotCliWorkspaceMetadata(eventsPath)).resolves.toEqual({
      id: 'from-workspace',
      cwd: '/workspace/from-yaml',
    });

    await expect(
      loadCopilotCliWorkspaceMetadata(path.join(sessionDir, 'flat.jsonl')),
    ).resolves.toEqual({});
  });

  it('returns empty metadata when workspace.yaml is missing or unreadable', async () => {
    const missingDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'copilot-cli-workspace-missing-'),
    );
    tempDirs.push(missingDir);
    const missingEventsPath = path.join(missingDir, 'events.jsonl');
    await fsPromises.writeFile(missingEventsPath, '{}\n', 'utf8');

    await expect(loadCopilotCliWorkspaceMetadata(missingEventsPath)).resolves.toEqual({});

    const unreadableDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'copilot-cli-workspace-unreadable-'),
    );
    tempDirs.push(unreadableDir);
    const unreadableEventsPath = path.join(unreadableDir, 'events.jsonl');
    const workspacePath = path.join(unreadableDir, 'workspace.yaml');
    await fsPromises.writeFile(unreadableEventsPath, '{}\n', 'utf8');
    await fsPromises.writeFile(workspacePath, 'id: blocked\ncwd: /workspace/blocked\n', 'utf8');

    if (process.platform === 'win32') {
      await expect(loadCopilotCliWorkspaceMetadata(unreadableEventsPath)).resolves.toEqual({
        id: 'blocked',
        cwd: '/workspace/blocked',
      });
      return;
    }

    await fsPromises.chmod(workspacePath, 0o000);

    try {
      await expect(loadCopilotCliWorkspaceMetadata(unreadableEventsPath)).resolves.toEqual({});
    } finally {
      await fsPromises.chmod(workspacePath, 0o600);
    }
  });
});
