export const DEFAULT_PALETTE: readonly string[];
export function escapeHtml(text: string): string;
export function color256(index: number, palette?: readonly string[]): string;
export function ansiToHtml(text: string, options?: { palette?: readonly string[] }): string;
