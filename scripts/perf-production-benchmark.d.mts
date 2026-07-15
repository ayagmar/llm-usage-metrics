export function buildBenchmarkEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export function buildLlmBenchmarkEnv(options: {
  cacheRoot: string;
  configRoot: string;
  eventStorePath?: string;
}): NodeJS.ProcessEnv;

export function ccusageArgs(source: string, offline: boolean): string[];

export function llmArgs(source: string, pricingOffline: boolean): string[];

export function rotateForRun<T>(cells: T[], runIndex: number): T[];
