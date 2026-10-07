import { describe, expect, it, vi } from 'vitest';

import { emitDiagnostics, type DiagnosticsLogger } from '../../src/cli/emit-diagnostics.js';
import type { UsageDiagnostics } from '../../src/cli/usage-data-contracts.js';

function createLoggerSpy() {
  return {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    dim: vi.fn<(message: string) => void>(),
    debug: vi.fn<(message: string) => void>(),
  } satisfies DiagnosticsLogger;
}

function createDiagnostics(overrides: Partial<UsageDiagnostics> = {}): UsageDiagnostics {
  return {
    sessionStats: [],
    sourceFailures: [],
    skippedRows: [],
    pricingOrigin: 'none',
    activeEnvOverrides: [],
    timezone: 'UTC',
    ...overrides,
  };
}

const twoSources = [
  { source: 'pi', filesFound: 1, eventsParsed: 2 },
  { source: 'codex', filesFound: 1_200, eventsParsed: 3_000 },
  { source: 'droid', filesFound: 0, eventsParsed: 0 },
];

describe('emitDiagnostics', () => {
  it('warns and points to doctor when no session files were found', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(createDiagnostics(), diagnosticsLogger);

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith(
      'No session files found. Run `llm-usage doctor` to see where each source is searched.',
    );
    expect(diagnosticsLogger.info).not.toHaveBeenCalled();
  });

  it('names active settings when nothing was found, since they may be the cause', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        activeConfig: { path: '/cfg.toml', entries: [{ key: 'sources', value: 'pi' }] },
        activeEnvOverrides: [
          { name: 'LLM_USAGE_PARSE_WORKERS', value: '0', description: 'parse worker count' },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith(
      'No session files found (with config /cfg.toml, 1 env override). Run `llm-usage doctor` to see where each source is searched.',
    );
  });

  it('summarizes discovery, pricing, config, and env overrides on one info line', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        pricingOrigin: 'cache',
        activeConfig: { path: '/home/me/.config/llm-usage/config.toml', entries: [] },
        activeEnvOverrides: [
          { name: 'LLM_USAGE_PARSE_WORKERS', value: '0', description: 'parse worker count' },
        ],
      }),
      diagnosticsLogger,
    );

    // Sources without files are left out; the rest are ordered by file count.
    expect(diagnosticsLogger.info.mock.calls).toEqual([
      ['Scanned 1,201 files (codex 1,200, pi 1) · cached pricing · 1 env override'],
    ]);
    expect(diagnosticsLogger.warn).not.toHaveBeenCalled();
    expect(diagnosticsLogger.dim).not.toHaveBeenCalled();
  });

  it('names the config file only when it set something', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'pi', filesFound: 1, eventsParsed: 1 }],
        activeConfig: { path: '/cfg.toml', entries: [{ key: 'timezone', value: 'UTC' }] },
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.info).toHaveBeenCalledWith('Scanned 1 file (pi 1) · config /cfg.toml');
  });

  it.each([
    ['cache', 'cached pricing'],
    ['network', 'fetched pricing'],
    ['offline-cache', 'cached pricing (offline)'],
    ['bundled-snapshot', 'bundled pricing'],
  ] as const)('labels the "%s" pricing origin', (origin, label) => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'pi', filesFound: 1, eventsParsed: 1 }],
        pricingOrigin: origin,
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.info).toHaveBeenCalledWith(`Scanned 1 file (pi 1) · ${label}`);
  });

  it('keeps per-source counts for --verbose', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(createDiagnostics({ sessionStats: twoSources }), diagnosticsLogger);

    expect(diagnosticsLogger.debug.mock.calls).toEqual([
      ['pi: 1 file, 2 events'],
      ['codex: 1,200 files, 3,000 events'],
      ['droid: 0 files, 0 events'],
    ]);
  });

  it('keeps routine skips out of the default output', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        skippedRows: [
          { source: 'pi', skippedRows: 6, reasons: [{ reason: 'no_token_usage', count: 6 }] },
          {
            source: 'claude',
            skippedRows: 11,
            reasons: [{ reason: 'synthetic_message', count: 11 }],
          },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).not.toHaveBeenCalled();
    expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
      'Skipped 17 rows without usage: pi 6 (no_token_usage 6), claude 11 (synthetic_message 11)',
    );
  });

  it('warns once about rows that could not be read', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        skippedRows: [
          {
            source: 'codex',
            skippedRows: 4,
            reasons: [
              { reason: 'json_parse_error', count: 1 },
              { reason: 'no_token_usage', count: 3 },
            ],
          },
          // No breakdown: nothing says these were routine.
          { source: 'pi', skippedRows: 2 },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn.mock.calls).toEqual([
      ['Skipped 3 unreadable rows: codex 1 (json_parse_error 1), pi 2'],
    ]);
    expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
      'Skipped 3 rows without usage: codex 3 (no_token_usage 3)',
    );
  });

  it('warns about source failures, pricing problems, and dataset warnings', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        sourceFailures: [{ source: 'codex', reason: 'permission denied' }],
        pricingWarning: 'Could not load pricing; continuing without estimated costs: network down',
        warnings: ['Event store disabled after failure: database locked'],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn.mock.calls).toEqual([
      ['Failed to parse codex: permission denied'],
      ['Could not load pricing; continuing without estimated costs: network down'],
      ['Event store disabled after failure: database locked'],
    ]);
  });

  it('reports whole files that failed to parse separately from rows', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        skippedRows: [
          {
            source: 'codex',
            skippedRows: 3,
            reasons: [
              { reason: 'file_parse_failed', count: 2 },
              { reason: 'json_parse_error', count: 1 },
            ],
          },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn.mock.calls).toEqual([
      ['Could not parse 2 files: codex 2'],
      ['Skipped 1 unreadable row: codex 1 (json_parse_error 1)'],
    ]);
  });

  it('warns when a source yields no events and every skip looks routine', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [
          { source: 'claude', filesFound: 40, eventsParsed: 0 },
          { source: 'pi', filesFound: 3, eventsParsed: 9 },
        ],
        skippedRows: [
          {
            source: 'claude',
            skippedRows: 900,
            reasons: [{ reason: 'no_token_usage', count: 900 }],
          },
          { source: 'pi', skippedRows: 2, reasons: [{ reason: 'no_token_usage', count: 2 }] },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn.mock.calls).toEqual([
      [
        'claude: files were found but no usage was read; its log format may have changed (--verbose for details)',
      ],
    ]);
  });

  it('treats goose rows with an invalid model config as routine', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'goose', filesFound: 1, eventsParsed: 4 }],
        skippedRows: [
          {
            source: 'goose',
            skippedRows: 1,
            reasons: [{ reason: 'invalid_model_config', count: 1 }],
          },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).not.toHaveBeenCalled();
  });

  it('prints notes as information after warnings', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: twoSources,
        notes: ['History: included 0 event(s) from 0 departed file(s).'],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).not.toHaveBeenCalled();
    expect(diagnosticsLogger.info).toHaveBeenLastCalledWith(
      'History: included 0 event(s) from 0 departed file(s).',
    );
  });
});
