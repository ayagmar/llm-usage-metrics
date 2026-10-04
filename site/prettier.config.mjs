import shared from '../.prettierrc.json' with { type: 'json' };

export default {
  ...shared,
  plugins: ['prettier-plugin-astro'],
};
