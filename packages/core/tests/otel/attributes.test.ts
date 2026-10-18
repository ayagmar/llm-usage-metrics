import { describe, expect, it } from 'vitest';

import {
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  type CostMode,
  type UsageRecord,
} from '../../src/index.js';
import {
  SEMCONV_GENAI_REF,
  sessionAttributes,
  toolCallAttributes,
  usageRecordAttributes,
} from '../../src/otel/index.js';

const base = { source: 'codex', sessionId: 'session-1', timestamp: '2026-06-15T12:00:00.000Z' };

const usage = createUsageRecord({
  ...base,
  repoRoot: '/work/repo',
  provider: 'openai',
  model: 'gpt-5.2-codex',
  inputTokens: 150,
  outputTokens: 100,
  reasoningTokens: 20,
  cacheReadTokens: 50,
  cacheWriteTokens: 30,
  totalTokens: 330,
  costUsd: 0.0017,
  messageId: 'resp-1',
  requestId: 'req-1',
  rawProvider: 'openai',
});

const toolCall = createToolCallEvent({
  ...base,
  name: 'Bash',
  toolCallId: 'call-1',
  status: 'error',
  durationMs: 12,
  messageId: 'resp-1',
});

const meta = createSessionMetaEvent({
  ...base,
  cwd: '/work/repo/sub',
  gitBranch: 'feature/secret-project',
  agentVersion: '1.2.3',
  parentSessionId: 'session-0',
  model: 'gpt-5.2-codex',
  rawProvider: 'OpenAI',
});

describe('SEMCONV_GENAI_REF', () => {
  it('pins the commit and schema URL the names were checked against', () => {
    expect(SEMCONV_GENAI_REF).toEqual({
      repository: 'open-telemetry/semantic-conventions-genai',
      commit: 'f49da22056925ae9ba78ec5dd7fe1fa559adce05',
      schemaUrl: 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev',
    });
    expect(Object.isFrozen(SEMCONV_GENAI_REF)).toBe(true);
  });
});

describe('usageRecordAttributes mapping', () => {
  const attributes = usageRecordAttributes({ ...usage, costMode: 'estimated' });

  it.each([
    ['gen_ai.operation.name', 'chat'],
    ['gen_ai.provider.name', 'openai'],
    ['gen_ai.response.model', 'gpt-5.2-codex'],
    ['gen_ai.response.id', 'resp-1'],
    ['gen_ai.conversation.id', 'session-1'],
    // input + cache read + cache write: the convention counts cached tokens as input.
    ['gen_ai.usage.input_tokens', 230],
    // Our output already includes reasoning.
    ['gen_ai.usage.output_tokens', 100],
    ['gen_ai.usage.reasoning.output_tokens', 20],
    ['gen_ai.usage.cache_read.input_tokens', 50],
    ['gen_ai.usage.cache_write.input_tokens', 30],
    ['llm_usage.cost_usd', 0.0017],
    ['llm_usage.cost_mode', 'estimated'],
    ['llm_usage.source', 'codex'],
  ])('%s = %j', (key, value) => {
    expect(attributes[key]).toBe(value);
  });

  it('emits nothing beyond the mapped keys', () => {
    expect(Object.keys(attributes).sort()).toEqual([
      'gen_ai.conversation.id',
      'gen_ai.operation.name',
      'gen_ai.provider.name',
      'gen_ai.response.id',
      'gen_ai.response.model',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_write.input_tokens',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'gen_ai.usage.reasoning.output_tokens',
      'llm_usage.cost_mode',
      'llm_usage.cost_usd',
      'llm_usage.source',
    ]);
  });

  it('omits optional keys whose fields are absent', () => {
    const bare = createUsageRecord({ ...base, inputTokens: 1 });
    const keys = Object.keys(usageRecordAttributes(bare));

    for (const key of [
      'gen_ai.provider.name',
      'gen_ai.response.model',
      'gen_ai.response.id',
      'llm_usage.cost_usd',
      'llm_usage.cost_mode',
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  it('omits the reasoning and cache counts when they are zero', () => {
    const keys = Object.keys(
      usageRecordAttributes({
        ...usage,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    expect(keys).toContain('gen_ai.usage.input_tokens');
    expect(keys).toContain('gen_ai.usage.output_tokens');
    for (const key of [
      'gen_ai.usage.reasoning.output_tokens',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_write.input_tokens',
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  it('never emits gen_ai.request.model: the logs record only the response model', () => {
    expect(attributes).not.toHaveProperty('gen_ai.request.model');
  });

  it.each<CostMode>(['explicit', 'estimated'])('passes costMode %s through', (costMode) => {
    expect(usageRecordAttributes({ ...usage, costMode })['llm_usage.cost_mode']).toBe(costMode);
  });

  it('emits repoRoot only with includePaths', () => {
    expect(usageRecordAttributes(usage, { includePaths: true })['llm_usage.repo_root']).toBe(
      '/work/repo',
    );
    expect(usageRecordAttributes(usage)).not.toHaveProperty('llm_usage.repo_root');
  });
});

describe('gen_ai.provider.name', () => {
  function providerName(provider: string | undefined): unknown {
    const record: UsageRecord = { ...usage, provider };
    return usageRecordAttributes(record)['gen_ai.provider.name'];
  }

  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['google', 'gcp.gemini'],
    ['moonshot', 'moonshot_ai'],
    ['xai', 'x_ai'],
    // `mistral` is the well-known value at the pin, not `mistral_ai`.
    ['mistral', 'mistral'],
    ['deepseek', 'deepseek'],
    ['groq', 'groq'],
    // Cloud-hosted endpoints, matched by prefix after lowercasing.
    ['amazon-bedrock', 'aws.bedrock'],
    ['Amazon-Bedrock-Converse', 'aws.bedrock'],
    ['google-vertex', 'gcp.vertex_ai'],
    ['google-vertex-anthropic', 'gcp.vertex_ai'],
    ['azure-openai', 'azure.ai.openai'],
    ['azure-openai-responses', 'azure.ai.openai'],
    // Other Google and Azure ids do not say which well-known endpoint they are.
    ['google-custom', 'google-custom'],
    ['azure-east', 'azure-east'],
    // No well-known value: passes through as a custom value.
    ['github', 'github'],
    ['openrouter', 'openrouter'],
  ])('%s -> %s', (provider, expected) => {
    expect(providerName(provider)).toBe(expected);
  });

  it('is omitted when the provider is unknown', () => {
    expect(usageRecordAttributes({ ...usage, provider: undefined })).not.toHaveProperty(
      'gen_ai.provider.name',
    );
  });
});

describe('toolCallAttributes mapping', () => {
  const attributes = toolCallAttributes(toolCall);

  it.each([
    ['gen_ai.operation.name', 'execute_tool'],
    ['gen_ai.tool.name', 'Bash'],
    ['gen_ai.tool.call.id', 'call-1'],
    ['gen_ai.conversation.id', 'session-1'],
    ['llm_usage.source', 'codex'],
    ['error.type', '_OTHER'],
    ['llm_usage.message_id', 'resp-1'],
  ])('%s = %j', (key, value) => {
    expect(attributes[key]).toBe(value);
  });

  it('emits nothing beyond the mapped keys', () => {
    expect(Object.keys(attributes)).toHaveLength(7);
  });

  it('sets error.type only on a failed call and the tool status only when unknown', () => {
    const ok = toolCallAttributes({ ...toolCall, status: 'ok' });
    const unknown = toolCallAttributes({ ...toolCall, status: 'unknown' });

    expect(ok).not.toHaveProperty('error.type');
    expect(ok).not.toHaveProperty('llm_usage.tool.status');
    expect(unknown).not.toHaveProperty('error.type');
    expect(unknown['llm_usage.tool.status']).toBe('unknown');
  });

  it('omits gen_ai.tool.call.id without a call id', () => {
    expect(toolCallAttributes({ ...toolCall, toolCallId: undefined })).not.toHaveProperty(
      'gen_ai.tool.call.id',
    );
  });
});

describe('sessionAttributes mapping', () => {
  const attributes = sessionAttributes(meta);

  it.each([
    ['gen_ai.conversation.id', 'session-1'],
    ['gen_ai.provider.name', 'openai'],
    ['gen_ai.request.model', 'gpt-5.2-codex'],
    ['llm_usage.source', 'codex'],
    ['llm_usage.agent_version', '1.2.3'],
    ['llm_usage.parent_session_id', 'session-0'],
  ])('%s = %j', (key, value) => {
    expect(attributes[key]).toBe(value);
  });

  it('emits nothing beyond the mapped keys', () => {
    expect(Object.keys(attributes)).toHaveLength(6);
  });

  it('emits cwd and the git branch only with includePaths', () => {
    expect(sessionAttributes(meta, { includePaths: true })).toMatchObject({
      'llm_usage.cwd': '/work/repo/sub',
      'llm_usage.git_branch': 'feature/secret-project',
    });
    expect(attributes).not.toHaveProperty('llm_usage.cwd');
    expect(attributes).not.toHaveProperty('llm_usage.git_branch');
  });

  it('omits the provider and model when the meta has none', () => {
    const bare = createSessionMetaEvent(base);
    expect(sessionAttributes(bare)).toEqual({
      'gen_ai.conversation.id': 'session-1',
      'llm_usage.source': 'codex',
    });
  });
});

describe('no message text, title or path unless the caller opts in', () => {
  const SECRETS = ['SECRET-TITLE', 'SECRET-RAW', '/secret/path', 'secret-branch'];
  const raw = { content: 'SECRET-RAW', nested: { text: 'SECRET-RAW' } };

  function leaked(attributes: Record<string, unknown>): string[] {
    const values = Object.values(attributes).map(String);
    return SECRETS.filter((secret) => values.some((value) => value.includes(secret)));
  }

  it('usageRecordAttributes ignores raw and paths', () => {
    const record = createUsageRecord({
      ...base,
      repoRoot: '/secret/path',
      inputTokens: 1,
      raw,
    });

    expect(leaked(usageRecordAttributes(record))).toEqual([]);
    expect(leaked(usageRecordAttributes(record, { includePaths: false }))).toEqual([]);
    expect(leaked(usageRecordAttributes(record, { includePaths: true }))).toEqual(['/secret/path']);
  });

  it('toolCallAttributes ignores raw', () => {
    const event = createToolCallEvent({ ...base, name: 'Read', status: 'ok', raw });

    expect(leaked(toolCallAttributes(event))).toEqual([]);
  });

  it('sessionAttributes never emits the title, never reads raw', () => {
    const event = createSessionMetaEvent({
      ...base,
      title: 'SECRET-TITLE',
      cwd: '/secret/path',
      gitBranch: 'secret-branch',
      raw,
    });
    // A getter would throw if read.
    Object.defineProperty(event, 'raw', {
      enumerable: true,
      get() {
        throw new Error('raw was read');
      },
    });

    expect(leaked(sessionAttributes(event))).toEqual([]);
    expect(leaked(sessionAttributes(event, { includePaths: true }))).toEqual([
      '/secret/path',
      'secret-branch',
    ]);
  });
});
