import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { buildProjectsData } from '../../src/cli/build-projects-data.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

function event(sessionId: string, repoRoot: string, machine?: string): UsageEvent {
  const created = createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp: '2026-06-01T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    repoRoot,
  });
  return machine === undefined ? created : { ...created, machine };
}

describe('projects under aliased folders', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  // This platform's absolute paths, so the config's paths resolve to the same keys.
  const at = (...segments: string[]) => path.resolve('/', ...segments);
  // A TOML basic string, which takes JSON's escapes.
  const toml = (value: string) => JSON.stringify(value);

  beforeAll(async () => {
    const configPath = path.join(environment.rootDir, 'config.toml');
    await writeFile(
      configPath,
      [
        '[projectAliases]',
        `${toml(at('desktop/projects'))} = [${toml(at('laptop/Projects/Personal'))}]`,
        `${toml(at('desktop/projects/orange'))} = [${toml(at('laptop/Projects/Work/Orange'))}, ${toml(at('desktop/Orange'))}]`,
      ].join('\n'),
    );
    vi.stubEnv('LLM_USAGE_CONFIG_PATH', configPath);
  });

  const deps = (events: UsageEvent[]) => ({
    createAdapters: (): SourceAdapter[] => [
      {
        id: 'claude',
        discoverFiles: async () => ['/tmp/s.jsonl'],
        read: readFrom(async () => events),
      },
    ],
  });
  const projects = async (events: UsageEvent[], extra: Record<string, unknown> = {}) =>
    (
      await buildProjectsData({ timezone: 'UTC', pricingOffline: true, ...extra }, deps(events))
    ).projects
      .map((project) => [project.repoRoot, project.events])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));

  const events = [
    event('desktop-app', at('desktop/projects/app')),
    event('laptop-app', at('laptop/Projects/Personal/app'), 'laptop'),
    event('desktop-orange', at('desktop/projects/orange')),
    event('laptop-orange', at('laptop/Projects/Work/Orange/api'), 'laptop'),
    event('desktop-other', at('desktop/Orange')),
    event('elsewhere', at('laptop/Projects/Personalized/app'), 'laptop'),
  ];

  it('counts the same project in other folders, and on other machines, as one', async () => {
    expect(await projects(events)).toEqual([
      [at('desktop/projects/app'), 2],
      [at('desktop/projects/orange'), 2],
      [at('desktop/projects/orange/api'), 1],
      [at('laptop/Projects/Personalized/app'), 1],
    ]);
  });

  it('selects the merged project with --repo on an aliased path', async () => {
    expect(await projects(events, { repo: at('laptop/Projects/Personal/app') })).toEqual([
      [at('desktop/projects/app'), 2],
    ]);
  });
});
