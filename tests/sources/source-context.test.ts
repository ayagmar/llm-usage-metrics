import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createSourceContext, readEnvPath } from '../../src/sources/source-context.js';

describe('createSourceContext', () => {
  it('reads the host when called and keeps process.env by reference', () => {
    const context = createSourceContext();

    expect(context.homeDir).toBe(os.homedir());
    expect(context.platform).toBe(process.platform);
    expect(context.env).toBe(process.env);

    vi.stubEnv('LLM_USAGE_SOURCE_CONTEXT_PROBE', 'later');
    expect(context.env.LLM_USAGE_SOURCE_CONTEXT_PROBE).toBe('later');
    vi.unstubAllEnvs();
  });

  it('takes every field from the overrides it is given', () => {
    const env = { CODEX_HOME: '/codex' };
    const onDiagnostic = vi.fn();

    expect(
      createSourceContext({ homeDir: '/home/tester', env, platform: 'win32', onDiagnostic }),
    ).toEqual({ homeDir: '/home/tester', env, platform: 'win32', onDiagnostic });
  });
});

describe('readEnvPath', () => {
  const context = createSourceContext({
    env: { SET: '  /data/dir  ', BLANK: ' \t ', EMPTY: '' },
  });

  it('trims a set path', () => {
    expect(readEnvPath(context, 'SET')).toBe('/data/dir');
  });

  it('treats unset, empty and whitespace-only values as unset', () => {
    expect(readEnvPath(context, 'MISSING')).toBeUndefined();
    expect(readEnvPath(context, 'EMPTY')).toBeUndefined();
    expect(readEnvPath(context, 'BLANK')).toBeUndefined();
  });
});
