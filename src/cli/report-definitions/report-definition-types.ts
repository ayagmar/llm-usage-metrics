import type { Command } from 'commander';

export type SharedOptionProfile =
  | 'usage'
  | 'hourly'
  | 'rollup'
  | 'pricing'
  | 'summary'
  | 'specialized'
  | 'compare'
  | 'trends'
  | 'session'
  | 'tools'
  | 'wrapped'
  | 'events'
  | 'statusline'
  | 'doctor';

export type ReportHelpExample = {
  command: string;
  includeInCliReference?: boolean;
  includeInRootHelp?: boolean;
};

export type ReportDefinitionMeta = {
  commandName: string;
  docsLabel: string;
  kind: 'usage-granularity' | 'specialized';
  description: string;
  sharedOptionProfile: SharedOptionProfile;
  helpExamples: readonly ReportHelpExample[];
};

export type ReportRuntimeDefinition = {
  meta: ReportDefinitionMeta;
  register: (command: Command) => Command;
};
