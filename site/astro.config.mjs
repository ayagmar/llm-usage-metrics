import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { getDefaultSourceIds } from '../src/sources/create-default-adapters.ts';

export default defineConfig({
  site: 'https://ayagmar.github.io',
  base: '/llm-usage-metrics',
  prefetch: false,

  integrations: [
    starlight({
      title: 'LLM Usage Metrics',
      description: `Local usage reports for ${getDefaultSourceIds().length} AI coding tools: tokens, estimated cost, sessions, comparisons, and exports`,
      favicon: '/favicon.svg',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ayagmar/llm-usage-metrics' },
      ],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.googleapis.com',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: true,
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'theme-color',
            content: '#11130f',
          },
        },
      ],
      sidebar: [
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
            { label: 'Doctor', slug: 'doctor' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
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
      ],
      customCss: ['./src/styles/tokens.css', './src/styles/custom.css'],
      editLink: {
        baseUrl: 'https://github.com/ayagmar/llm-usage-metrics/edit/master/site/',
      },
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        defaultProps: {
          wrap: true,
        },
      },
    }),
  ],
  outDir: './dist',
  srcDir: './src',
  publicDir: './public',
  server: {
    port: 4321,
  },
});
