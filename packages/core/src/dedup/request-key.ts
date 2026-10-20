import type { UsageEvent } from '../domain/usage-event.js';

/**
 * Whether the event carries a logged message or request id. An event stored or exported
 * before events carried them has neither; a row can log only one of them.
 */
export function hasRequestIds(event: UsageEvent): boolean {
  return event.messageId !== undefined || event.requestId !== undefined;
}

/** The event's message and request ids as one key, or undefined when it has neither. */
export function getRequestKey(event: UsageEvent): string | undefined {
  return hasRequestIds(event)
    ? JSON.stringify([event.messageId ?? null, event.requestId ?? null])
    : undefined;
}
