import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventStoreModule from '../../src/persistence/event-store.js';

vi.mock('../../src/persistence/event-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof EventStoreModule>();
  return { ...original, openEventStore: vi.fn(original.openEventStore) };
});

import { createCli } from '../../src/cli/create-cli.js';
import { buildPricingData, buildPricingReport } from '../../src/cli/run-pricing-report.js';
import { openEventStore } from '../../src/persistence/event-store.js';
import { setLogLevel } from '../../src/utils/logger.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const overridesPath = path.resolve('tests/fixtures/pricing/explain-overrides.json');

describe('pricing report', () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel('info');
  });

  it('prints the explanation on stdout and the snapshot warning on stderr, opening no store', async () => {
    // The store is on, as for a report: a usage read would open it.
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv(
      'LLM_USAGE_EVENT_STORE_PATH',
      path.join(environment.rootDir, 'never-opened', 'events.db'),
    );
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await createCli().parseAsync(['pricing', 'gpt-5.4', '--pricing-offline', '--json'], {
        from: 'user',
      });
    } finally {
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
    }

    const report = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      report: string;
      data: { models: { pricingKey: string | null }[] };
    };
    expect(report.report).toBe('pricing');
    expect(report.data.models).toEqual([expect.objectContaining({ pricingKey: 'gpt-5.4' })]);
    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringMatching(/Pricing: using the bundled LiteLLM snapshot from/u),
    ]);
    expect(openEventStore).not.toHaveBeenCalled();
    expect(pricing.fetch).not.toHaveBeenCalled();
  });

  it('applies config pricing settings as reports do, with flags taking precedence', async () => {
    const configPath = path.join(environment.rootDir, 'pricing-config.toml');
    await writeFile(
      configPath,
      `[pricing]\noffline = true\noverridesPath = ${JSON.stringify(overridesPath)}\n`,
    );
    vi.stubEnv('LLM_USAGE_CONFIG_PATH', configPath);

    try {
      const { data } = await buildPricingData(['acme-internal-model'], {});
      expect(data.models[0]).toMatchObject({ override: 'raw', pricingKey: 'acme-internal-model' });

      const flagOverridesPath = path.join(environment.rootDir, 'flag-overrides.json');
      await writeFile(flagOverridesPath, JSON.stringify({ models: {} }));
      const fromFlag = await buildPricingData(['acme-internal-model'], {
        pricingOverrides: flagOverridesPath,
      });
      expect(fromFlag.data.models[0]).toMatchObject({ override: 'none', pricingKey: null });
    } finally {
      vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(environment.rootDir, 'missing-config.toml'));
    }

    expect(pricing.fetch).not.toHaveBeenCalled();
  });

  it('fails when prices cannot load, as reports do', async () => {
    await expect(
      buildPricingReport(['gpt-5.4'], {
        pricingOffline: true,
        pricingUrl: 'https://example.test/pricing.json',
      }),
    ).rejects.toThrow('Offline pricing mode enabled but cached pricing is unavailable');
    await expect(
      buildPricingReport(['gpt-5.4'], {
        pricingOffline: true,
        pricingOverrides: path.join(environment.rootDir, 'missing-overrides.json'),
      }),
    ).rejects.toThrow('Could not load --pricing-overrides');
  });

  it('rejects an invalid pricing URL and blank model names before loading prices', async () => {
    await expect(
      buildPricingReport(['gpt-5.4'], { pricingOffline: true, pricingUrl: 'ftp://example.test' }),
    ).rejects.toThrow('--pricing-url must be a valid http(s) URL');
    await expect(buildPricingReport(['gpt-5.4', '  '], { pricingOffline: true })).rejects.toThrow(
      'Model names must be non-empty',
    );
    await expect(
      buildPricingReport(['gpt-5.4'], { pricingOffline: true, json: true, markdown: true }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');
  });

  it('names the override a padded name reaches only once normalized', async () => {
    // The override source matches the raw name untrimmed; the matcher then trims it.
    const output = await buildPricingReport(['  acme-internal-model'], {
      pricingOffline: true,
      pricingOverrides: overridesPath,
    });

    expect(output).toContain('Rule            override keyed on the normalized name');
    expect(output).toContain('Override        yes, keyed on the pricing key');
    expect(output).toContain('Input           $1.00 / 1M');
  });

  it('explains per-request tier rates only when a name has tiers', async () => {
    const tiered = await buildPricingReport(['gemini-2.5-pro'], { pricingOffline: true });
    const flat = await buildPricingReport(['claude-sonnet-4-5-20250929'], {
      pricingOffline: true,
      markdown: true,
    });

    expect(tiered).toMatch(/apply per request .* only to events that record one request/u);
    expect(flat).not.toContain('per request');
  });
});
