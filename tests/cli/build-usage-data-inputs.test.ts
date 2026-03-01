import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeBuildUsageInputs,
  resolveExplicitSourceIds,
} from '../../src/cli/build-usage-data-inputs.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('build-usage-data-inputs', () => {
  it('falls back to UTC when runtime timezone detection is unavailable', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: undefined as unknown as string,
    });

    const inputs = normalizeBuildUsageInputs({});

    expect(inputs.timezone).toBe('UTC');
  });

  it('normalizes provider filter to billing-entity value', () => {
    const inputs = normalizeBuildUsageInputs({
      provider: ' OpenAI-Codex ',
    });

    expect(inputs.providerFilter).toBe('openai');
  });

  it('includes copilot explicit source ids when directory flags are set', () => {
    const explicitSourceIds = resolveExplicitSourceIds(
      {
        copilotCliDir: '/tmp/copilot-cli',
        copilotVscodeDir: '/tmp/copilot-vscode',
      },
      undefined,
    );

    expect(explicitSourceIds.has('copilot-cli')).toBe(true);
    expect(explicitSourceIds.has('copilot-vscode')).toBe(true);
  });
});
