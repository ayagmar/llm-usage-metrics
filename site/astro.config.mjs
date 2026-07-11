import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://ayagmar.github.io',
  base: '/llm-usage-metrics',
  prefetch: false,

  integrations: [
    starlight({
      title: 'LLM Usage Metrics',
      description:
        'Local-first usage reports for 16 AI coding tools, with pricing, session analysis, Git attribution, comparisons, and exports',
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
            { label: 'Getting started', link: '/getting-started/' },
            { label: 'Data sources', link: '/sources/' },
            { label: 'Configuration', link: '/configuration/' },
          ],
        },
        {
          label: 'Reports',
          items: [
            { label: 'CLI reference', link: '/cli-reference/' },
            { label: 'Compare periods', link: '/compare/' },
            { label: 'Session usage', link: '/session/' },
            { label: 'Trends', link: '/trends/' },
            { label: 'Efficiency', link: '/efficiency/' },
            { label: 'Optimize', link: '/optimize/' },
            { label: 'Wrapped recap', link: '/wrapped/' },
            { label: 'Output formats', link: '/output-formats/' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'Pricing', link: '/pricing/' },
            { label: 'Caching and history', link: '/caching/' },
            { label: 'Doctor', link: '/doctor/' },
            { label: 'Troubleshooting', link: '/troubleshooting/' },
            { label: 'Security', link: '/security/' },
          ],
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
          label: 'Engineering',
          items: [{ label: 'Benchmarks', link: '/benchmarks/' }],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', link: '/architecture/' },
            { label: 'Event Store', link: '/architecture/event-store/' },
            { label: 'Parse Pipeline', link: '/architecture/parse-pipeline/' },
            { label: 'Pricing Pipeline', link: '/architecture/pricing-pipeline/' },
            { label: 'Config & Logging', link: '/architecture/config-and-logging/' },
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
