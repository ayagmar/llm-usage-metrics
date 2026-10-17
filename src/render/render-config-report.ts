import os from 'node:os';

import type {
  ConfigReportData,
  ConfigReportEventStoreFile,
  ConfigSetting,
  SettingOrigin,
} from '../cli/build-config-report.js';
import { formatEnvVarOverrides } from '../config/env-var-display.js';
import { formatByteSize } from './format-byte-size.js';
import { formatDuration } from './format-duration.js';
import { formatInteger, pluralize } from './format-number.js';
import { abbreviateHome, describeMissingEventStore } from './render-doctor-report.js';
import { formatAge } from './render-machines.js';

const originLabels: Record<SettingOrigin, string> = {
  cli: 'flag',
  env: 'env var',
  config: 'config',
  default: 'default',
};

const ORIGIN_WIDTH = Math.max(...Object.values(originLabels).map((label) => label.length));

type Row = { label: string; origin?: SettingOrigin; value: string };

/**
 * Rows as `label  origin  value`, the origin column only when a row has one. The value goes
 * last so a long path wraps alone.
 */
function formatSection(title: string, rows: readonly Row[]): string[] {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const hasOrigins = rows.some((row) => row.origin !== undefined);

  return [
    title,
    ...rows.map((row) =>
      [
        `  ${row.label.padEnd(labelWidth)}`,
        ...(hasOrigins ? [(row.origin ? originLabels[row.origin] : '').padEnd(ORIGIN_WIDTH)] : []),
        row.value,
      ].join('  '),
    ),
  ];
}

function settingRow<Value>(
  label: string,
  setting: ConfigSetting<Value>,
  format: (value: Value) => string,
): Row {
  return { label, origin: setting.origin, value: format(setting.value) };
}

const formatYesNo = (value: boolean): string => (value ? 'yes' : 'no');

function describeEventStoreFile(file: ConfigReportEventStoreFile): string {
  switch (file.state) {
    case 'missing':
      return describeMissingEventStore(file.legacyPath);
    case 'ok':
      return [
        formatByteSize(file.sizeBytes),
        `schema v${file.schemaVersion}`,
        pluralize(file.eventCount, 'event'),
      ].join(', ');
    case 'unsupported':
    case 'error':
      return file.error;
  }
}

function describeFetchedAt(fetchedAt: string, now: number): string {
  return `fetched ${fetchedAt.slice(0, 10)} (${formatAge(now - Date.parse(fetchedAt))})`;
}

function describeCache(cache: ConfigReportData['pricing']['cache'], now: number): string {
  if (cache.state === 'none' || cache.fetchedAt === undefined) {
    return 'none usable for this URL';
  }

  const freshness = cache.state === 'fresh' ? 'fresh' : 'past its refresh interval';
  return `${describeFetchedAt(cache.fetchedAt, now)}, ${freshness}`;
}

function describePricesFrom(pricing: ConfigReportData['pricing']): string {
  const fetchedDate = pricing.pricesFetchedAt?.slice(0, 10);

  switch (pricing.pricesFrom) {
    case 'cache':
      return 'from the cache';
    case 'network':
      return 'fetched from the URL by the next report';
    case 'bundled-snapshot':
      return `from the bundled snapshot${fetchedDate ? ` of ${fetchedDate}` : ''}`;
    case 'none':
      return 'none: offline, and no cache for this URL';
  }
}

function formatSourceRows(data: ConfigReportData, homeDir: string): string[] {
  if (data.sources.length === 0) {
    return ['Sources', '  none selected'];
  }

  const idWidth = Math.max(...data.sources.map((source) => source.id.length));
  const lines = data.sources.flatMap((source) =>
    (source.paths.length > 0 ? source.paths : [undefined]).map((entry, index) =>
      [
        `  ${(index === 0 ? source.id : '').padEnd(idWidth)}`,
        (index === 0 ? originLabels[source.origin] : '').padEnd(ORIGIN_WIDTH),
        entry ? (entry.exists ? 'found  ' : 'missing') : '       ',
        entry ? abbreviateHome(entry.path, homeDir) : 'no path',
      ].join('  '),
    ),
  );

  return ['Sources', ...lines];
}

function formatMachines(machines: ConfigReportData['machines']): string[] {
  if (machines.length === 0) {
    return ['Machines', '  none configured'];
  }

  return formatSection(
    'Machines',
    machines.map((machine) => ({
      label: machine.name,
      value: machine.enabled ? 'enabled' : 'disabled',
    })),
  );
}

export function renderConfigReportText(
  data: ConfigReportData,
  options: { now: number; homeDir?: string },
): string {
  const homeDir = options.homeDir ?? os.homedir();
  const showPath = (filePath: string): string => abbreviateHome(filePath, homeDir);
  const { configFile, eventStore, pricing, defaults } = data;
  const configFileState = configFile.exists ? '' : ' (missing)';

  const sections = [
    formatSection('Config file', [
      {
        label: 'path',
        origin: configFile.origin,
        value: `${showPath(configFile.path)}${configFileState}`,
      },
    ]),
    formatSourceRows(data, homeDir),
    formatSection('Event store', [
      settingRow('enabled', eventStore.enabled, formatYesNo),
      settingRow('path', eventStore.path, showPath),
      ...(eventStore.file
        ? [{ label: 'file', value: describeEventStoreFile(eventStore.file) }]
        : []),
    ]),
    formatMachines(data.machines),
    formatSection('Pricing', [
      settingRow('url', pricing.url, String),
      settingRow('offline', pricing.offline, formatYesNo),
      settingRow('refresh', pricing.cacheTtlMs, (ms) => `every ${formatDuration(ms)}`),
      { label: 'cache', value: showPath(pricing.cache.path) },
      { label: '', value: describeCache(pricing.cache, options.now) },
      { label: 'prices', value: describePricesFrom(pricing) },
      pricing.overrides
        ? settingRow(
            'overrides',
            pricing.overrides.path,
            (filePath) => `${showPath(filePath)}${pricing.overrides?.exists ? '' : ' (missing)'}`,
          )
        : { label: 'overrides', value: 'none' },
    ]),
    formatSection('Defaults', [
      settingRow('timezone', defaults.timezone, String),
      settingRow('sources', defaults.sources, (ids) => (ids.length > 0 ? ids.join(', ') : 'all')),
      settingRow('parse workers', defaults.parseWorkers, formatInteger),
      settingRow('parse max parallel', defaults.parseMaxParallel, formatInteger),
      settingRow('worker min size', defaults.parseWorkerMinBytes, formatByteSize),
      {
        label: 'history',
        value: defaults.history ? 'on (event store enabled)' : 'off (event store disabled)',
      },
    ]),
  ];
  const environment = formatEnvVarOverrides(data.environment);

  return [...sections, ...(environment.length > 0 ? [environment] : [])]
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}
