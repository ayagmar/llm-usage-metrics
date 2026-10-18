import { describe, expect, it } from 'vitest';

import {
  deriveSpanId,
  deriveTraceId,
  toOtlpAttributes,
  toUnixNanos,
} from '../../src/otel-export/otlp-json.js';

describe('OTLP/JSON encoding', () => {
  it('writes timestamps as decimal nanosecond strings, as fixed64 needs', () => {
    expect(toUnixNanos(1_790_845_203_517)).toBe('1790845203517000000');
  });

  it('encodes int64 attributes as strings and keeps cost a double when it is whole', () => {
    expect(
      toOtlpAttributes({
        'gen_ai.usage.input_tokens': 9_007_199_254,
        'llm_usage.cost_usd': 0,
        'llm_usage.provider_unknown': true,
        'gen_ai.tool.name': 'Bash',
      }),
    ).toEqual([
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '9007199254' } },
      { key: 'llm_usage.cost_usd', value: { doubleValue: 0 } },
      { key: 'llm_usage.provider_unknown', value: { boolValue: true } },
      { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
    ]);
  });

  it('derives distinct hex ids per session and per span key', () => {
    const traceId = deriveTraceId('codex', 'session-1');

    expect(traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(deriveTraceId('codex', 'session-1')).toBe(traceId);
    expect(deriveTraceId('claude', 'session-1')).not.toBe(traceId);
    // The separator keeps the parts apart: `a` + `bc` is not `ab` + `c`.
    expect(deriveTraceId('a', 'bc')).not.toBe(deriveTraceId('ab', 'c'));
    expect(deriveSpanId(traceId, 'chat', '#0')).toMatch(/^[0-9a-f]{16}$/u);
    expect(deriveSpanId(traceId, 'chat', '#0')).not.toBe(
      deriveSpanId(traceId, 'execute_tool', '#0'),
    );
  });
});
