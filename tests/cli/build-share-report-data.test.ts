import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildShareReportData,
  type ShareReportRequest,
} from '../../src/cli/build-share-report-data.js';
import type { BuildUsageDataDeps } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { logger } from '../../src/utils/logger.js';
import { createCorpusAdapters } from '../helpers/share-payload.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const WINDOW = { since: '2026-06-01', until: '2026-06-20' } as const;

function usage(
  input: Partial<Parameters<typeof createUsageEvent>[0]> & { machine?: string },
): UsageEvent {
  const { machine, ...rest } = input;
  const created = createUsageEvent({
    source: 'claude',
    sessionId: 'session',
    timestamp: '2026-06-15T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 1_000,
    outputTokens: 100,
    ...rest,
  });

  return machine === undefined ? created : { ...created, machine };
}

function deps(events: readonly UsageEvent[], extra: BuildUsageDataDeps = {}): BuildUsageDataDeps {
  return {
    now: () => NOW,
    createAdapters: createCorpusAdapters(events),
    getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
    ...extra,
  };
}

function request(overrides: Partial<ShareReportRequest> = {}): ShareReportRequest {
  return {
    command: 'daily',
    options: { timezone: 'UTC', pricingOffline: true },
    window: WINDOW,
    initialView: { ...WINDOW, granularity: 'day' },
    ...overrides,
  };
}

describe('buildShareReportData', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const priced = usage({ sessionId: 'priced' });
  const logged = usage({
    sessionId: 'logged',
    timestamp: '2026-06-15T11:00:00.000Z',
    costUsd: 0.5,
    costMode: 'explicit',
  });

  it('keeps logged costs and warns when pricing does not load in explicit mode', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const data = await buildShareReportData(
      request({ options: { timezone: 'UTC', pricingOffline: true, costMode: 'explicit' } }),
      deps([priced, logged], {
        resolvePricingSource: () => Promise.reject(new Error('offline and no cache')),
      }),
    );

    expect(data.meta.costMode).toBe('explicit');
    expect(data.meta.unavailableCostModes).toEqual(['estimated', 'both']);
    expect(Object.keys(data.cube.costs)).toEqual(['explicit']);
    expect(data.cube.costs.explicit?.costUsd).toEqual([null, 0.5]);
    expect(data.blocks.rows[0].costs).toEqual({ explicit: { costUsd: 0.5, incompleteEvents: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline and no cache'));
  });

  it('holds no cost and loads no prices with --no-cost', async () => {
    const resolvePricingSource = vi.fn();
    const data = await buildShareReportData(
      request({ options: { timezone: 'UTC', pricingOffline: true, cost: false } }),
      deps([priced, logged], { resolvePricingSource }),
    );

    expect(resolvePricingSource).not.toHaveBeenCalled();
    expect(data.meta.costMode).toBeNull();
    expect(data.meta.unavailableCostModes).toEqual([]);
    expect(data.cube.costs).toEqual({});
    expect(data.sessions.rows.every((row) => Object.keys(row.costs).length === 0)).toBe(true);
  });

  it('prices every mode from one load', async () => {
    const data = await buildShareReportData(request(), deps([priced, logged]));

    expect(data.meta.costMode).toBe('both');
    expect(Object.keys(data.cube.costs)).toEqual(['explicit', 'estimated', 'both']);
    expect(data.cube.costs.explicit?.costUsd).toEqual([null, 0.5]);
    expect(data.cube.costs.both?.costUsd[1]).toBe(0.5);
    expect(data.cube.costs.estimated?.costUsd[1]).not.toBe(0.5);
  });

  it('spells the homes of other machines ~ in labels, envelopes and text', async () => {
    const roots = ['/home/otheruser/app', '/Users/bob', 'C:\\users\\Dev\\x'];
    const events = roots.map((repoRoot, index) =>
      usage({
        sessionId: `remote-${String(index)}`,
        timestamp: `2026-06-1${String(index)}T09:00:00.000Z`,
        repoRoot,
        machine: 'remote-box',
      }),
    );
    const data = await buildShareReportData(
      request({
        envelope: {
          report: 'compare',
          data: {
            projects: roots.map((repoRoot) => ({ repoRoot, project: repoRoot })),
            note: `ran in ${roots[0]}`,
          },
        },
      }),
      deps(events),
    );
    const json = JSON.stringify(data);

    expect([...data.dictionaries.projects].sort()).toEqual(['app', 'x', '~']);
    expect(data.dictionaries.machines).toEqual(['remote-box']);
    expect(data.envelope?.data).toMatchObject({
      projects: [{ project: 'app' }, { project: '~' }, { project: 'x' }],
    });

    for (const name of ['otheruser', 'bob', 'Dev']) {
      expect(json, name).not.toContain(name);
    }
  });

  it('never syncs other machines, even when the command would', async () => {
    const spawnSsh = vi.fn(() => {
      throw new Error('ssh must not run for a share report');
    });

    await buildShareReportData(
      request({ options: { timezone: 'UTC', pricingOffline: true, sync: true } }),
      deps([priced], {
        spawnSsh,
        loadUserConfig: async () => ({
          config: { machines: { laptop: { ssh: 'share-test.invalid' } } },
          path: '/share-test/config.toml',
          exists: true,
          warnings: [],
        }),
      }),
    );

    expect(spawnSsh).not.toHaveBeenCalled();
  });

  it('picks the --model rule from the window, not from the blocks lookback week', async () => {
    // The exact name appears only in the lookback; inside the window, only a dated variant does.
    const data = await buildShareReportData(
      request({ options: { timezone: 'UTC', pricingOffline: true, model: ['claude-opus-4-1'] } }),
      deps([
        usage({ timestamp: '2026-05-28T10:00:00.000Z', model: 'claude-opus-4-1' }),
        usage({ timestamp: '2026-06-15T10:00:00.000Z', model: 'claude-opus-4-1-20250805' }),
      ]),
    );

    expect(data.dictionaries.models).toEqual(['claude-opus-4-1-20250805']);
  });

  it('echoes the filters as values, --repo as a flag only', async () => {
    const data = await buildShareReportData(
      request({
        options: {
          timezone: 'UTC',
          pricingOffline: true,
          source: 'claude',
          model: ['/opt/models/llama.gguf'],
          repo: ['/home/someone/work/app'],
        },
      }),
      deps([priced]),
    );

    expect(data.meta.filters).toEqual({
      sources: ['claude'],
      providers: [],
      models: ['llama.gguf'],
      machines: [],
      repo: true,
    });
    expect(JSON.stringify(data)).not.toContain('/home/someone');
  });

  describe('labels and redaction (decision 18)', () => {
    const home = () => os.homedir();
    const roots = () => [
      'C:\\work\\app',
      'D:\\work\\app',
      path.join(home(), 'projects', 'secret-project'),
      '/srv/teams/second-secret/',
    ];
    const machines = ['workstation-alpha', 'laptop-beta'];
    const pathModel = () => path.join(home(), 'models', 'private-llama.gguf');

    function corpus(): UsageEvent[] {
      return roots().flatMap((repoRoot, index) => [
        usage({
          sessionId: `session-id-${String(index)}-a`,
          timestamp: `2026-06-1${String(index)}T09:00:00.000Z`,
          repoRoot,
          model: index === 0 ? pathModel() : 'claude-sonnet-4-5',
          inputTokens: 1_000 * (index + 1),
        }),
        usage({
          sessionId: `session-id-${String(index)}-b`,
          timestamp: `2026-06-1${String(index)}T09:20:00.000Z`,
          repoRoot,
          machine: machines[index % 2],
        }),
      ]);
    }

    function envelope() {
      return {
        report: 'compare' as const,
        data: {
          repoDir: roots()[2],
          projects: roots().map((repoRoot) => ({ repoRoot, project: repoRoot })),
          note: `compared in ${roots()[3]} and ${home()}`,
          machine: machines[0],
          machines: ['local', 'offline-box'],
        },
      };
    }

    function forbidden(data: unknown): string[] {
      const json = JSON.stringify(data);
      const values = [
        home(),
        pathModel(),
        ...roots(),
        ...roots().map((root) => root.replace(/[\\/]+$/u, '')),
        ...corpus().map((event) => event.sessionId),
      ];

      return values.filter(
        (value) => json.includes(value) || json.includes(JSON.stringify(value).slice(1, -1)),
      );
    }

    it('never embeds a path, the home directory or a session ID', async () => {
      const data = await buildShareReportData(request({ envelope: envelope() }), deps(corpus()));

      expect(forbidden(data)).toEqual([]);
      expect([...data.dictionaries.projects].sort()).toEqual([
        'second-secret',
        'secret-project',
        'work/app',
        'work/app #2',
      ]);
      expect(data.dictionaries.models).toContain('private-llama.gguf');
      expect(data.dictionaries.machines.sort()).toEqual([...machines, 'local'].sort());
      expect(data.meta.redacted).toBe(false);
    });

    it('with --redact, embeds no project label or machine name either', async () => {
      const data = await buildShareReportData(
        request({
          options: {
            timezone: 'UTC',
            pricingOffline: true,
            redact: true,
            machine: [machines[0], 'local'],
          },
          envelope: envelope(),
        }),
        deps(corpus(), {
          spawnSsh: () => {
            throw new Error('ssh must not run for a share report');
          },
          loadUserConfig: async () => ({
            config: { machines: { [machines[0]]: { ssh: 'share-test.invalid' } } },
            path: '/share-test/config.toml',
            exists: true,
            warnings: [],
          }),
        }),
      );
      const json = JSON.stringify(data);

      expect(forbidden(data)).toEqual([]);

      for (const name of [
        'work/app',
        'secret-project',
        'second-secret',
        'offline-box',
        ...machines,
      ]) {
        expect(json).not.toContain(name);
      }

      expect(data.meta.redacted).toBe(true);
      // Most tokens first: the second-secret root has the largest inputs.
      expect(data.dictionaries.projects).toEqual([
        'project-1',
        'project-2',
        'project-3',
        'project-4',
      ]);
      // Both machines have equal tokens, so laptop-beta, first by name, is machine-1.
      expect(data.meta.filters.machines).toEqual(['local', 'machine-2']);
      // A machine only the envelope names gets the next stand-in.
      expect((data.envelope?.data as Record<string, unknown> | undefined)?.machines).toEqual([
        'local',
        'machine-3',
      ]);
    });

    it('names a file-URI model by its basename, with or without --redact', async () => {
      const model = 'file:///opt/review-alice/models/private.gguf';
      const events = [usage({ model })];

      for (const redact of [false, true]) {
        const data = await buildShareReportData(
          request({ options: { timezone: 'UTC', pricingOffline: true, redact } }),
          deps(events),
        );

        expect(data.dictionaries.models).toEqual(['private.gguf']);
        expect(JSON.stringify(data)).not.toContain('review-alice');
      }
    });

    it('labels the envelope’s models as the dictionary labels them', async () => {
      const model = './models/home/oscar/m';
      const data = await buildShareReportData(
        request({
          command: 'wrapped',
          envelope: {
            report: 'wrapped',
            data: { topModels: [{ name: model, totalTokens: 1_100 }], candidateModel: model },
          },
        }),
        deps([usage({ model })]),
      );

      expect(data.dictionaries.models).toEqual(['m']);
      expect(data.envelope?.data).toEqual({
        topModels: [{ name: 'm', totalTokens: 1_100 }],
        candidateModel: 'm',
      });
      expect(JSON.stringify(data)).not.toContain('oscar');
    });

    it('with --redact, scrubs paths and names out of the envelope’s free text', async () => {
      const data = await buildShareReportData(
        request({
          options: { timezone: 'UTC', pricingOffline: true, redact: true },
          envelope: {
            report: 'compare',
            data: {
              note: 'review /opt/alice/private-data.json for private-project on alice-laptop',
              machine: 'alice-laptop',
              project: 'private-project',
            },
          },
        }),
        deps([usage({ repoRoot: '/srv/private-project' })]),
      );

      expect(data.envelope?.data).toEqual({
        note: 'review private-data.json for project-1 on machine-1',
        machine: 'machine-1',
        project: 'project-1',
      });
    });

    it('maps the envelope’s projects to the file’s labels', async () => {
      const data = await buildShareReportData(request({ envelope: envelope() }), deps(corpus()));
      const envelopeData = data.envelope?.data as Record<string, unknown> | undefined;
      const projects = (envelopeData?.projects ?? []) as { project: string }[];

      expect(data.envelope?.report).toBe('compare');
      expect(projects.map((row) => row.project).sort()).toEqual(
        [...data.dictionaries.projects].sort(),
      );
      expect(data.envelope?.data).not.toHaveProperty('repoDir');
      expect(envelopeData?.note).toBe('compared in second-secret and ~');
    });
  });
});
