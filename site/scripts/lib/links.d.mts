export type ClassifiedLink =
  | { kind: 'external' }
  | { kind: 'ignored' }
  | { kind: 'internal'; path: string; fragment: string | null };

export function stripRawText(html: string): string;
export function startTags(html: string): string[];
export function extractAttributeValues(html: string, name: string): string[];
export function splitSrcset(value: string): string[];
export function extractLinks(html: string): string[];
export function extractIds(html: string): Set<string>;
export function classifyLink(value: string, pagePath: string): ClassifiedLink;
export function toDistCandidates(urlPath: string, base: string): string[] | null;
