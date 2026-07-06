import { describe, expect, it, vi } from 'vitest';

import { emitDiagnostics, type DiagnosticsLogger } from '../../src/cli/emit-diagnostics.js';
import type { UsageDiagnostics } from '../../src/cli/usage-data-contracts.js';

function createLoggerSpy(): DiagnosticsLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    dim: vi.fn(),
  };
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

describe('emitDiagnostics', () => {
  it('warns when no sessions were found and pricing is not loaded', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(createDiagnostics(), diagnosticsLogger);

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith('No sessions found');
    expect(diagnosticsLogger.info).not.toHaveBeenCalled();
    expect(diagnosticsLogger.dim).not.toHaveBeenCalled();
  });

  it('emits session stats before pricing diagnostics in terminal order', () => {
    const callSequence: string[] = [];

    const diagnosticsLogger: DiagnosticsLogger = {
      info: (message) => {
        callSequence.push(`info:${message}`);
      },
      warn: (message) => {
        callSequence.push(`warn:${message}`);
      },
      dim: (message) => {
        callSequence.push(`dim:${message}`);
      },
    };

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [
          { source: 'pi', filesFound: 1, eventsParsed: 2 },
          { source: 'codex', filesFound: 2, eventsParsed: 3 },
        ],
        pricingOrigin: 'cache',
      }),
      diagnosticsLogger,
    );

    expect(callSequence).toEqual([
      'info:Found 3 session file(s) with 5 event(s)',
      'dim:  pi: 1 file(s), 2 events',
      'dim:  codex: 2 file(s), 3 events',
      'info:Loaded pricing from cache',
    ]);
  });

  it.each([
    ['cache', 'Loaded pricing from cache'],
    ['network', 'Fetched pricing from LiteLLM'],
    ['offline-cache', 'Using cached pricing (offline mode)'],
  ] as const)('emits pricing message for "%s" origin', (origin, message) => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'pi', filesFound: 1, eventsParsed: 1 }],
        pricingOrigin: origin,
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.info).toHaveBeenCalledWith(message);
  });

  it('emits pricing warning when pricing is skipped after a pricing load failure', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'pi', filesFound: 1, eventsParsed: 1 }],
        pricingOrigin: 'none',
        pricingWarning: 'Could not load pricing; continuing without estimated costs: network down',
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith(
      'Could not load pricing; continuing without estimated costs: network down',
    );
  });

  it('emits generic diagnostics warnings', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sessionStats: [{ source: 'pi', filesFound: 1, eventsParsed: 1 }],
        warnings: ['Event store disabled after failure: database locked'],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith(
      'Event store disabled after failure: database locked',
    );
  });

  it('emits source failure diagnostics when parsing failures are present', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        sourceFailures: [{ source: 'codex', reason: 'permission denied' }],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith('No sessions found');
    expect(diagnosticsLogger.warn).toHaveBeenCalledWith('Failed to parse 1 source');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('  codex: permission denied');
  });

  it('emits skipped-row diagnostics when row skips are present', () => {
    const diagnosticsLogger = createLoggerSpy();

    emitDiagnostics(
      createDiagnostics({
        skippedRows: [
          {
            source: 'pi',
            skippedRows: 1,
            reasons: [{ reason: 'missing_timestamp', count: 1 }],
          },
          {
            source: 'codex',
            skippedRows: 2,
            reasons: [
              { reason: 'invalid_data_json', count: 1 },
              { reason: 'missing_usage_signal', count: 1 },
            ],
          },
        ],
      }),
      diagnosticsLogger,
    );

    expect(diagnosticsLogger.warn).toHaveBeenCalledWith('Skipped 3 malformed rows');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('  pi: 1 skipped (missing_timestamp: 1)');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith(
      '  codex: 2 skipped (invalid_data_json: 1, missing_usage_signal: 1)',
    );
  });
});
