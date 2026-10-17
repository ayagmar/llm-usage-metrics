import { describe, expect, it } from 'vitest';

import type { ConfigReportData } from '../../src/cli/build-config-report.js';
import { renderConfigReportText } from '../../src/render/render-config-report.js';

const NOW = Date.parse('2026-06-21T12:00:00.000Z');

function createData(overrides: Partial<ConfigReportData> = {}): ConfigReportData {
  return {
    configFile: { path: '/cfg/config.toml', origin: 'default', exists: true },
    sources: [],
    eventStore: {
      enabled: { value: true, origin: 'default' },
      path: { value: '/data/events.db', origin: 'default' },
      file: { state: 'ok', sizeBytes: 2048, schemaVersion: '4', eventCount: 1250 },
    },
    machines: [],
    pricing: {
      url: { value: 'https://example.test/prices.json', origin: 'config' },
      offline: { value: false, origin: 'default' },
      cacheTtlMs: { value: 3_600_000, origin: 'default' },
      cache: { path: '/cache/prices.json', state: 'stale', fetchedAt: '2026-06-19T12:00:00.000Z' },
      pricesFrom: 'network',
    },
    defaults: {
      timezone: { value: 'UTC', origin: 'default' },
      sources: { value: [], origin: 'default' },
      parseWorkers: { value: 0, origin: 'default' },
      parseMaxParallel: { value: 8, origin: 'default' },
      parseWorkerMinBytes: { value: 1024, origin: 'default' },
      history: true,
    },
    environment: [],
    ...overrides,
  };
}

function render(data: ConfigReportData): string {
  return renderConfigReportText(data, { now: NOW, homeDir: '/home/me' });
}

describe('renderConfigReportText', () => {
  it('summarizes a readable store and a stale cache the next report replaces', () => {
    const text = render(createData());

    expect(text).toContain('file              2.0 KiB, schema v4, 1,250 events');
    expect(text).toContain('fetched 2026-06-19 (2 days ago), past its refresh interval');
    expect(text).toContain('prices              fetched from the URL by the next report');
    expect(text).toContain('  none selected');
    expect(text).toContain('  none configured');
    expect(text).not.toContain('Active environment overrides:');
  });

  it('names the snapshot date offline and says when offline pricing has nothing', () => {
    const snapshot = render(
      createData({
        pricing: {
          ...createData().pricing,
          cache: { path: '/cache/prices.json', state: 'none' },
          pricesFrom: 'bundled-snapshot',
          pricesFetchedAt: '2026-02-01T00:00:00.000Z',
        },
      }),
    );
    const nothing = render(
      createData({
        pricing: {
          ...createData().pricing,
          cache: { path: '/c', state: 'none' },
          pricesFrom: 'none',
        },
      }),
    );

    expect(snapshot).toContain('none usable for this URL');
    expect(snapshot).toContain('from the bundled snapshot of 2026-02-01');
    expect(nothing).toContain('none: offline, and no cache for this URL');
  });

  it('prints the store error, a missing config file and history off', () => {
    const text = render(
      createData({
        configFile: { path: '/home/me/.config/x.toml', origin: 'env', exists: false },
        eventStore: {
          enabled: { value: true, origin: 'env' },
          path: { value: '/data/events.db', origin: 'env' },
          file: {
            state: 'unsupported',
            sizeBytes: 10,
            error: 'Event store schema v9 is not supported',
          },
        },
        defaults: { ...createData().defaults, history: false },
      }),
    );

    expect(text).toContain('path  env var  ~/.config/x.toml (missing)');
    expect(text).toContain('Event store schema v9 is not supported');
    expect(text).toContain('off (event store disabled)');
  });

  it('puts each extra path of a source on its own line under the source', () => {
    const text = render(
      createData({
        sources: [
          {
            id: 'claude',
            format: 'jsonl',
            origin: 'config',
            paths: [
              { path: '/home/me/a', exists: true },
              { path: '/b', exists: false },
            ],
          },
          { id: 'opencode', format: 'sqlite', origin: 'default', paths: [] },
        ],
        machines: [{ name: 'laptop', enabled: true }],
        pricing: {
          ...createData().pricing,
          pricesFrom: 'cache',
          overrides: { path: { value: '/o.json', origin: 'cli' }, exists: true },
        },
      }),
    );

    expect(text).toContain('  claude    config   found    ~/a\n                     missing  /b');
    expect(text).toContain('  opencode  default           no path');
    expect(text).toContain('  laptop  enabled');
    expect(text).toContain('overrides  flag     /o.json\n');
    expect(text).toContain('prices              from the cache');
  });
});
