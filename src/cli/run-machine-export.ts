import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { text } from 'node:stream/consumers';

import { LOCAL_MACHINE_NAME } from '../config/user-config.js';
import { buildMachineExportLines, parseKnownFiles } from '../machines/machine-export-bundle.js';
import {
  closeEventStore,
  openEventStore,
  readStoredFileSnapshots,
} from '../persistence/event-store.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { buildUsageEventDataset } from './build-usage-event-dataset.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import { emitReportRunDiagnostics } from './report-runtime/report-lifecycle.js';
import { logger } from '../utils/logger.js';
import { getRepeatingSourceIds } from '../sources/source-adapter.js';
import type { BuildUsageDataDeps } from './usage-data-contracts.js';

export type MachineExportCommandOptions = {
  /** A file, or `-` for stdin, listing the files the reader already holds. */
  known?: string;
};

type MachineExportDeps = BuildUsageDataDeps & {
  stdout?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  now?: () => Date;
};

async function readKnownFiles(
  known: string | undefined,
  stdin: NodeJS.ReadableStream,
): Promise<Map<string, string>> {
  if (known === undefined) {
    return new Map();
  }

  return parseKnownFiles(known === '-' ? await text(stdin) : await readFile(known, 'utf8'));
}

async function writeLine(stdout: NodeJS.WritableStream, line: unknown): Promise<void> {
  if (!stdout.write(`${JSON.stringify(line)}\n`)) {
    await once(stdout, 'drain');
  }
}

/**
 * Prints the events this machine's reports count, as a machine export bundle. The run
 * refreshes the ledger like a report does, then reads every counted file back from it.
 */
export async function runMachineExport(
  options: MachineExportCommandOptions,
  deps: MachineExportDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const knownFiles = await readKnownFiles(options.known, deps.stdin ?? process.stdin);
  // Only this machine's own usage: other machines export theirs themselves.
  const dataset = await buildUsageEventDataset({ machine: LOCAL_MACHINE_NAME }, deps);

  emitReportRunDiagnostics(
    buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin: 'none',
      warnings: dataset.warnings,
      notes: dataset.notes,
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone: dataset.normalizedInputs.timezone,
    }),
    {
      emitCommonDiagnostics: emitDiagnostics,
      getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
      getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    },
  );

  if (!dataset.ledger) {
    throw new Error(
      'machine export reads the event store, which is disabled or failed to open; see the warning above',
    );
  }

  const store = await (deps.openEventStore ?? openEventStore)(dataset.ledger.path);
  let snapshots;

  try {
    snapshots = readStoredFileSnapshots(store, dataset.ledger.parsedFiles, {
      historyFiles: dataset.ledger.historyFiles,
      repeatingSources: new Set(getRepeatingSourceIds(dataset.adaptersToParse)),
    });
  } finally {
    (deps.closeEventStore ?? closeEventStore)(store);
  }

  const lines = buildMachineExportLines(
    {
      cliVersion: loadPackageMetadataFromRuntime().packageVersion,
      hostname: os.hostname(),
      exportedAt: (deps.now?.() ?? new Date()).toISOString(),
    },
    snapshots,
    knownFiles,
  );

  const end = lines.at(-1);
  const missingEventCount =
    dataset.filteredEvents.length - (end?.type === 'end' ? end.eventCount : 0);

  // A file whose fingerprint cannot be read (e.g. a dependency without read access) is
  // counted by reports but never stored, so it cannot be exported.
  if (missingEventCount > 0) {
    logger.warn(
      `machine export left out ${missingEventCount} event(s) that reports count but the event store does not hold`,
    );
  }

  for (const line of lines) {
    await writeLine(stdout, line);
  }
}
