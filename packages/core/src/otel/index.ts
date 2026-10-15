/**
 * OpenTelemetry GenAI attributes for core events. Experimental: the GenAI semantic
 * conventions have no release, so names follow the commit pinned in `SEMCONV_GENAI_REF`
 * and may change when the pin moves.
 *
 * Pure and dependency-free: each helper returns plain attributes and never emits message
 * text, titles or raw records. Paths and the git branch appear only with `includePaths`.
 *
 * @experimental
 * @packageDocumentation
 */
import { normalizeProviderToBillingEntity } from '../domain/provider-normalization.js';
import type { SessionMetaEvent, ToolCallEvent, UsageRecord } from '../domain/session-event.js';
import type { CostMode } from '../domain/usage-event.js';

/**
 * The `open-telemetry/semantic-conventions-genai` commit the attribute names were checked
 * against, and the schema URL its `model/manifest.yaml` declares.
 *
 * @experimental
 */
export const SEMCONV_GENAI_REF = Object.freeze({
  repository: 'open-telemetry/semantic-conventions-genai',
  commit: 'f3c6d0c9bb66ebd474668a3a0be25c61226f02c2',
  schemaUrl: 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev',
});

/** @experimental */
export type OtelAttributes = Record<string, string | number | boolean>;

/** @experimental */
export type OtelAttributeOptions = {
  /** Emit `cwd`, `repoRoot` and the git branch. Off by default. */
  includePaths?: boolean;
};

// Our provider ids whose well-known `gen_ai.provider.name` value differs at the pin
// (model/gen-ai/registry.yaml). `anthropic`, `openai`, `deepseek`, `groq`, `mistral`,
// `cohere` and `perplexity` already match; anything else passes through as a custom value.
const WELL_KNOWN_PROVIDER_NAMES = new Map<string, string>([
  ['google', 'gcp.gemini'],
  ['moonshot', 'moonshot_ai'],
  ['xai', 'x_ai'],
]);

// Provider id prefixes for the cloud-hosted endpoints, such as pi's `amazon-bedrock`,
// `google-vertex` and `azure-openai-responses`.
const WELL_KNOWN_PROVIDER_PREFIXES: ReadonlyArray<[prefix: string, name: string]> = [
  ['amazon-bedrock', 'aws.bedrock'],
  ['google-vertex', 'gcp.vertex_ai'],
  ['azure-openai', 'azure.ai.openai'],
];

function toProviderName(provider: string | undefined): string | undefined {
  const normalized = normalizeProviderToBillingEntity(provider);

  if (normalized === undefined) {
    return undefined;
  }

  for (const [prefix, name] of WELL_KNOWN_PROVIDER_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return name;
    }
  }

  return WELL_KNOWN_PROVIDER_NAMES.get(normalized) ?? normalized;
}

/** Copies the defined values of `fields` onto `target`, so undefined keys stay absent. */
function withDefined(
  target: OtelAttributes,
  fields: Record<string, string | number | boolean | undefined>,
): OtelAttributes {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }

  return target;
}

/**
 * Attributes for one inference (`gen_ai.operation.name` = `chat`). `gen_ai.usage.input_tokens`
 * counts cache reads and writes, as the convention asks; `gen_ai.usage.output_tokens`
 * already includes reasoning. `gen_ai.provider.name` is omitted when the provider is unknown.
 * The record's model is the lowercased response model; `gen_ai.request.model` is not emitted,
 * since the logs do not say what was requested.
 *
 * @experimental
 */
export function usageRecordAttributes(
  record: UsageRecord & { costMode?: CostMode },
  options: OtelAttributeOptions = {},
): OtelAttributes {
  return withDefined(
    {
      'gen_ai.operation.name': 'chat',
      'gen_ai.conversation.id': record.sessionId,
      'gen_ai.usage.input_tokens':
        record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens,
      'gen_ai.usage.output_tokens': record.outputTokens,
      'gen_ai.usage.reasoning.output_tokens': record.reasoningTokens,
      'gen_ai.usage.cache_read.input_tokens': record.cacheReadTokens,
      'gen_ai.usage.cache_write.input_tokens': record.cacheWriteTokens,
      'llm_usage.source': record.source,
    },
    {
      'gen_ai.provider.name': toProviderName(record.provider),
      'gen_ai.response.model': record.model,
      'gen_ai.response.id': record.messageId,
      'llm_usage.cost_usd': record.costUsd,
      'llm_usage.cost_mode': record.costMode,
      'llm_usage.repo_root': options.includePaths ? record.repoRoot : undefined,
    },
  );
}

/**
 * Attributes for one tool call (`gen_ai.operation.name` = `execute_tool`).
 *
 * @experimental
 */
export function toolCallAttributes(event: ToolCallEvent): OtelAttributes {
  return withDefined(
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': event.name,
      'gen_ai.conversation.id': event.sessionId,
      'llm_usage.source': event.source,
    },
    { 'gen_ai.tool.call.id': event.toolCallId },
  );
}

/**
 * Attributes describing a session, from its `session_meta` event. Never emits the title.
 *
 * @experimental
 */
export function sessionAttributes(
  meta: SessionMetaEvent,
  options: OtelAttributeOptions = {},
): OtelAttributes {
  return withDefined(
    {
      'gen_ai.conversation.id': meta.sessionId,
      'llm_usage.source': meta.source,
    },
    {
      'gen_ai.provider.name': toProviderName(meta.rawProvider),
      'gen_ai.request.model': meta.model,
      'llm_usage.agent_version': meta.agentVersion,
      'llm_usage.parent_session_id': meta.parentSessionId,
      'llm_usage.cwd': options.includePaths ? meta.cwd : undefined,
      'llm_usage.git_branch': options.includePaths ? meta.gitBranch : undefined,
    },
  );
}
