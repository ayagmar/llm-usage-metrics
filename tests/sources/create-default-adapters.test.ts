import { describe, expect, it } from 'vitest';

import { selectAdaptersForParsing } from '../../src/cli/build-usage-data-inputs.js';
import { createDefaultAdapters } from '../../src/sources/create-default-adapters.js';

describe('createDefaultAdapters', () => {
  it('builds default adapters in stable order', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'pi',
      'codex',
      'gemini',
      'droid',
      'opencode',
      'openclaw',
      'claude',
      'copilot',
      'goose',
      'amp',
      'qwen',
      'kimi',
      'cline',
      'roocode',
      'kilocode',
      'antigravity',
      'dsh',
    ]);
  });

  it('exposes source capabilities for provider pruning', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.find((adapter) => adapter.id === 'codex')?.capabilities).toEqual({
      fixedProviderRoots: ['openai'],
      eventsPrecedeFileMtime: true,
    });
    expect(adapters.find((adapter) => adapter.id === 'gemini')?.capabilities).toEqual({
      fixedProviderRoots: ['google'],
      eventsPrecedeFileMtime: true,
    });
  });

  it('keeps antigravity for a Claude model scope, since it serves Claude models too', () => {
    const selected = selectAdaptersForParsing(createDefaultAdapters({}), {
      sourceFilter: undefined,
      candidateProviderRoots: ['anthropic'],
    }).map((adapter) => adapter.id);

    expect(selected).toContain('antigravity');
    expect(selected).not.toContain('gemini');
  });

  it('lets only file-per-session sources skip files by mtime', () => {
    const adapters = createDefaultAdapters({});
    const skippable = adapters
      .filter((adapter) => adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);
    const notSkippable = adapters
      .filter((adapter) => !adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);

    // SQLite sources keep events in a database whose mtime does not track each row.
    expect(notSkippable.sort()).toEqual(['antigravity', 'goose', 'opencode']);
    expect(skippable.length + notSkippable.length).toBe(adapters.length);
  });

  it('builds only the selected sources, in registration order', () => {
    const adapters = createDefaultAdapters({ sourceIds: ['dsh', 'codex', 'pi'] });

    expect(adapters.map((adapter) => adapter.id)).toEqual(['pi', 'codex', 'dsh']);
  });
});
