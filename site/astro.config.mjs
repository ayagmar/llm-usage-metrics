import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { getDefaultSourceIds } from '../src/sources/create-default-adapters.ts';
import { sidebar } from './src/sidebar.mjs';

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
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://ayagmar.github.io/llm-usage-metrics/og.png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:card',
            content: 'summary_large_image',
          },
        },
      ],
      sidebar,
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
