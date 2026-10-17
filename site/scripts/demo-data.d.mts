export const DEMO_SOURCES: readonly ['claude', 'codex', 'pi', 'gemini'];
export const DEMO_PROJECTS: readonly string[];
export const DEMO_DAYS: number;
export function writeDemoData(options: {
  home: string;
  seed?: number;
  now: number;
  days?: number;
}): Promise<{ dirs: Record<(typeof DEMO_SOURCES)[number], string>; fileCount: number }>;
