import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://ayagmar.github.io',
  base: '/llm-usage-metrics',

  integrations: [
    starlight({
      title: 'llm-usage-metrics',
      description:
        'CLI for aggregating local LLM usage and cost metrics across 16 local coding agents, with pricing, trends, efficiency reports, and yearly recaps',
      favicon: '/favicon.svg',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: true,
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
      ],
      sidebar: [
        {
          label: 'Getting Started',
          link: '/getting-started',
        },
        {
          label: 'CLI Reference',
          link: '/cli-reference',
        },
        {
          label: 'Efficiency',
          link: '/efficiency',
        },
        {
          label: 'Optimize',
          link: '/optimize',
        },
        {
          label: 'Trends',
          link: '/trends',
        },
        {
          label: 'Session',
          link: '/session',
        },
        {
          label: 'Wrapped',
          link: '/wrapped',
        },
        {
          label: 'Doctor',
          link: '/doctor',
        },
        {
          label: 'Data Sources',
          items: [
            { label: 'Overview', link: '/sources/' },
            { label: 'amp', link: '/sources/amp/' },
            { label: 'antigravity', link: '/sources/antigravity/' },
            { label: 'claude', link: '/sources/claude/' },
            { label: 'cline', link: '/sources/cline/' },
            { label: 'codex', link: '/sources/codex/' },
            { label: 'copilot', link: '/sources/copilot/' },
            { label: 'droid', link: '/sources/droid/' },
            { label: 'gemini', link: '/sources/gemini/' },
            { label: 'goose', link: '/sources/goose/' },
            { label: 'kilocode', link: '/sources/kilocode/' },
            { label: 'kimi', link: '/sources/kimi/' },
            { label: 'openclaw', link: '/sources/openclaw/' },
            { label: 'opencode', link: '/sources/opencode/' },
            { label: 'pi', link: '/sources/pi/' },
            { label: 'qwen', link: '/sources/qwen/' },
            { label: 'roocode', link: '/sources/roocode/' },
          ],
        },
        {
          label: 'Configuration',
          link: '/configuration',
        },
        {
          label: 'Security',
          link: '/security',
        },
        {
          label: 'Caching',
          link: '/caching',
        },
        {
          label: 'Output Formats',
          link: '/output-formats',
        },
        {
          label: 'Benchmarks',
          link: '/benchmarks',
        },
        {
          label: 'Pricing',
          link: '/pricing',
        },
        {
          label: 'Troubleshooting',
          link: '/troubleshooting',
        },
        {
          label: 'Architecture',
          link: '/architecture',
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
