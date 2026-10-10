import { getDefaultSourceIds } from '../../src/sources/create-default-adapters.ts';

export const sidebar = [
  {
    label: 'Start here',
    items: [
      { label: 'Docs overview', slug: 'docs' },
      { label: 'Getting started', slug: 'getting-started' },
      { label: 'Choose a report', slug: 'reports' },
      { label: 'Data sources', slug: 'sources' },
      { label: 'Configuration', slug: 'configuration' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Usage totals', slug: 'usage' },
      { label: 'Compare periods', slug: 'compare' },
      { label: 'Session usage', slug: 'session' },
      { label: 'Trends', slug: 'trends' },
      { label: 'Efficiency', slug: 'efficiency' },
      { label: 'Optimize', slug: 'optimize' },
      { label: 'Wrapped recap', slug: 'wrapped' },
      { label: 'Status line', slug: 'statusline' },
      { label: 'Events export', slug: 'events' },
      { label: 'Output formats', slug: 'output-formats' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { label: 'Pricing', slug: 'pricing' },
      { label: 'Caching and history', slug: 'caching' },
      { label: 'Multiple machines', slug: 'machines' },
      { label: 'Doctor', slug: 'doctor' },
      { label: 'Troubleshooting', slug: 'troubleshooting' },
      { label: 'Privacy', slug: 'privacy' },
      { label: 'Security', slug: 'security' },
    ],
  },
  {
    label: 'Source details',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'sources' },
      ...getDefaultSourceIds()
        .sort()
        .map((id) => ({ label: id, slug: `sources/${id}` })),
    ],
  },
  {
    label: 'Reference',
    items: [
      { label: 'CLI reference', slug: 'cli-reference' },
      { label: 'Migrating to 0.8', slug: 'migrating-to-0-8' },
      { label: 'Benchmarks', slug: 'benchmarks' },
    ],
  },
  {
    label: 'Architecture',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'architecture' },
      { label: 'Event Store', slug: 'architecture/event-store' },
      { label: 'Parse Pipeline', slug: 'architecture/parse-pipeline' },
      { label: 'Pricing Pipeline', slug: 'architecture/pricing-pipeline' },
      { label: 'Config & Logging', slug: 'architecture/config-and-logging' },
    ],
  },
];
