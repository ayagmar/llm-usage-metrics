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
      { label: 'Projects', slug: 'projects' },
      { label: 'Compare periods', slug: 'compare' },
      { label: 'Session usage', slug: 'session' },
      { label: 'Tool calls', slug: 'tools' },
      { label: 'Context pressure', slug: 'context' },
      { label: 'Trends', slug: 'trends' },
      { label: '5-hour blocks', slug: 'blocks' },
      { label: 'Plan value', slug: 'value' },
      { label: 'Efficiency', slug: 'efficiency' },
      { label: 'Optimize', slug: 'optimize' },
      { label: 'Wrapped recap', slug: 'wrapped' },
      { label: 'Interactive report', slug: 'share' },
      { label: 'Status line', slug: 'statusline' },
      { label: 'Events export', slug: 'events' },
      { label: 'OpenTelemetry export', slug: 'otel' },
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
    label: 'Library',
    items: [
      { label: 'Overview', slug: 'library' },
      { label: 'Reading and composing', slug: 'library/guide' },
      { label: 'Versioning and cursors', slug: 'library/contracts' },
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
      { label: 'Benchmarks', slug: 'benchmarks' },
    ],
  },
  {
    label: 'Upgrading',
    items: [
      { label: 'Overview', slug: 'upgrading' },
      { label: 'Upgrading to 0.8', slug: 'upgrading/0-8' },
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
      { label: 'Event Model', slug: 'architecture/event-model' },
      { label: 'Dedup & Cursors', slug: 'architecture/dedup-and-cursors' },
      { label: 'Machine Merge', slug: 'architecture/machine-merge' },
      { label: 'Share Report', slug: 'architecture/share-report' },
      { label: 'Config & Logging', slug: 'architecture/config-and-logging' },
    ],
  },
];
