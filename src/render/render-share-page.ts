import {
  escapeSvg,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  shareFonts,
  shareThemes,
  type ShareThemeName,
} from './share-svg-theme.js';

export type SharePageOptions = {
  title: string;
  /** Base name for downloaded PNGs, without extension. */
  fileBaseName: string;
  svgs: Readonly<Record<ShareThemeName, string>>;
};

// Rasterizes the visible card in the browser: SVG -> <img> -> 2x canvas -> PNG.
// No network access and no dependencies; the CSP below blocks everything else.
const pageScript = `
const cards = {
  dark: document.querySelector('[data-card="dark"]'),
  light: document.querySelector('[data-card="light"]'),
};
const status = document.getElementById('status');
const fileBaseName = document.body.dataset.fileBaseName;
let theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

function show(nextTheme) {
  theme = nextTheme;
  document.body.dataset.theme = theme;
  for (const [name, card] of Object.entries(cards)) {
    card.hidden = name !== theme;
  }
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  }
  status.textContent = '';
}

// The theme is captured when the click happens, so switching themes mid-render
// cannot mislabel or mix up the image.
async function renderPng(renderedTheme) {
  const svg = cards[renderedTheme].querySelector('svg');
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = ${SHARE_WIDTH} * scale;
    canvas.height = ${SHARE_HEIGHT} * scale;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadPng() {
  const renderedTheme = theme;
  try {
    const url = URL.createObjectURL(await renderPng(renderedTheme));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileBaseName + '-' + renderedTheme + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Downloaded ' + link.download;
  } catch (error) {
    status.textContent = 'Could not create the PNG: ' + error.message;
  }
}

async function copyImage() {
  const renderedTheme = theme;
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    status.textContent = 'This browser cannot copy images. Use Download PNG instead.';
    return;
  }
  try {
    // A pending blob keeps Safari's user activation; older Chromium only takes a resolved one.
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPng(renderedTheme) })]);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await renderPng(renderedTheme) })]);
    }
    status.textContent = 'Copied the image to the clipboard';
  } catch (error) {
    status.textContent = 'Could not copy the image: ' + error.message + '. Use Download PNG instead.';
  }
}

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => show(button.dataset.themeChoice));
}
document.getElementById('download').addEventListener('click', downloadPng);
document.getElementById('copy').addEventListener('click', copyImage);
show(theme);
`;

function renderPageStyle(): string {
  const { dark, light } = shareThemes;

  return `
:root { color-scheme: dark light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  padding: 32px 16px;
  display: grid;
  place-items: center;
  font-family: ${shareFonts.sans};
  background: ${dark.bg};
  color: ${dark.text};
}
body[data-theme="light"] { background: ${light.bg}; color: ${light.text}; }
main { width: min(100%, ${SHARE_WIDTH}px); display: grid; gap: 16px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; }
.group { display: flex; gap: 8px; }
button {
  font: inherit;
  font-size: 15px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid ${dark.line};
  background: ${dark.panel};
  color: inherit;
  cursor: pointer;
}
body[data-theme="light"] button { border-color: ${light.line}; background: ${light.panel}; }
button[aria-pressed="true"] { border-color: ${dark.accent}; }
body[data-theme="light"] button[aria-pressed="true"] { border-color: ${light.accent}; }
button:focus-visible { outline: 2px solid ${dark.heat[3]}; outline-offset: 2px; }
body[data-theme="light"] button:focus-visible { outline-color: ${light.heat[3]}; }
figure { margin: 0; }
figure svg { display: block; width: 100%; height: auto; border-radius: 12px; }
#status { min-height: 1.5em; margin: 0; font-size: 15px; }
`;
}

/** A self-contained page that shows a share card in both themes and exports it as PNG. */
export function renderSharePage(options: SharePageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeSvg(options.title)}</title>
<style>${renderPageStyle()}</style>
</head>
<body data-theme="dark" data-file-base-name="${escapeSvg(options.fileBaseName)}">
<main>
<div class="toolbar">
<div class="group" role="group" aria-label="Theme">
<button type="button" data-theme-choice="dark" aria-pressed="true">Dark</button>
<button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
</div>
<div class="group">
<button type="button" id="download">Download PNG</button>
<button type="button" id="copy">Copy image</button>
</div>
</div>
<figure data-card="dark">
${options.svgs.dark}
</figure>
<figure data-card="light" hidden>
${options.svgs.light}
</figure>
<p id="status" role="status"></p>
</main>
<script>${pageScript}</script>
</body>
</html>
`;
}
