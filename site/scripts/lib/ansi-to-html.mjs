// ANSI terminal output to HTML for the docs screenshots. Handles SGR (`ESC [ … m`): the 16
// colours, 256 colours, truecolor, bold, dim, italic, underline and resets. Other escape
// sequences (cursor moves, OSC hyperlinks) are dropped, unknown SGR codes ignored, and text is
// HTML-escaped.

const ESC = '\u001b';
const BEL = '\u0007';

/** The 16-colour palette: 0–7 normal, 8–15 bright. */
export const DEFAULT_PALETTE = [
  '#1e1e1e',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#d4d4d4',
  '#7f848e',
  '#ff7b86',
  '#b5e890',
  '#ffd68a',
  '#82c4ff',
  '#de9bf0',
  '#7fd8e3',
  '#ffffff',
];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  let result = '';
  for (const character of text) result += HTML_ESCAPES[character] ?? character;
  return result;
}

function hex(value) {
  return value.toString(16).padStart(2, '0');
}

function rgb(red, green, blue) {
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/** A 256-colour index as a CSS colour: the palette, the 6×6×6 cube, then the grey ramp. */
export function color256(index, palette = DEFAULT_PALETTE) {
  if (index < 16) return palette[index];
  if (index < 232) {
    const cube = index - 16;
    const level = (step) => (step === 0 ? 0 : 55 + step * 40);
    return rgb(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
  }
  const grey = 8 + (index - 232) * 10;
  return rgb(grey, grey, grey);
}

function emptyStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Reads an extended colour (`38;5;n` or `38;2;r;g;b`) starting after the 38/48 code.
 * Returns the colour (or null when malformed) and how many parameters it used; an unknown
 * mode makes the rest of the sequence unreadable, so it uses them all.
 */
function readExtendedColor(params, start, palette) {
  const mode = params[start];
  if (mode === 5) {
    const index = params[start + 1];
    return { color: isByte(index) ? color256(index, palette) : null, used: 2 };
  }
  if (mode === 2) {
    const [red, green, blue] = params.slice(start + 1, start + 4);
    const valid = [red, green, blue].every(isByte);
    return { color: valid ? rgb(red, green, blue) : null, used: 4 };
  }
  return { color: null, used: params.length - start };
}

/** Applies one SGR parameter list to `style` in place. */
function applySgr(style, params, palette) {
  if (params.length === 0) params = [0];

  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) Object.assign(style, emptyStyle());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 22) style.bold = style.dim = false;
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code >= 30 && code <= 37) style.fg = palette[code - 30];
    else if (code >= 90 && code <= 97) style.fg = palette[code - 90 + 8];
    else if (code === 39) style.fg = null;
    else if (code >= 40 && code <= 47) style.bg = palette[code - 40];
    else if (code >= 100 && code <= 107) style.bg = palette[code - 100 + 8];
    else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      const { color, used } = readExtendedColor(params, index + 1, palette);
      if (color !== null) style[code === 38 ? 'fg' : 'bg'] = color;
      index += used;
    }
  }
}

function toCss(style) {
  const rules = [];
  if (style.fg) rules.push(`color:${style.fg}`);
  if (style.bg) rules.push(`background-color:${style.bg}`);
  if (style.bold) rules.push('font-weight:700');
  if (style.dim) rules.push('opacity:0.65');
  if (style.italic) rules.push('font-style:italic');
  if (style.underline) rules.push('text-decoration:underline');
  return rules.join(';');
}

/**
 * The end of an escape sequence starting at `start` (the ESC), and its SGR parameters when it
 * is one (`null` otherwise). An unterminated sequence runs to the end of the text.
 */
function readEscape(text, start) {
  const kind = text[start + 1];

  if (kind === '[') {
    let end = start + 2;
    // Parameter and intermediate bytes, then one final byte in @–~.
    while (end < text.length && !(text[end] >= '@' && text[end] <= '~')) end += 1;
    const body = text.slice(start + 2, end);
    const isSgr = text[end] === 'm' && /^[\d;]*$/u.test(body);
    const params = isSgr
      ? body === ''
        ? []
        : body.split(';').map((part) => (part === '' ? 0 : Number(part)))
      : null;
    return { next: Math.min(end + 1, text.length), params };
  }

  if (kind === ']') {
    // OSC, ended by BEL or ESC \.
    const bell = text.indexOf(BEL, start + 2);
    const st = text.indexOf(`${ESC}\\`, start + 2);
    const ends = [bell === -1 ? Infinity : bell + 1, st === -1 ? Infinity : st + 2];
    const next = Math.min(...ends);
    return { next: next === Infinity ? text.length : next, params: null };
  }

  // Two-character escapes (ESC 7, ESC c, …).
  return { next: Math.min(start + 2, text.length), params: null };
}

/**
 * Converts ANSI text to HTML: escaped text, with `<span style="…">` around each styled run.
 * Line breaks are kept as `\n`; wrap the result in a `<pre>`.
 */
export function ansiToHtml(text, { palette = DEFAULT_PALETTE } = {}) {
  const style = emptyStyle();
  let html = '';
  let position = 0;

  const emit = (chunk) => {
    if (chunk === '') return;
    const css = toCss(style);
    html += css === '' ? escapeHtml(chunk) : `<span style="${css}">${escapeHtml(chunk)}</span>`;
  };

  while (position < text.length) {
    const escape = text.indexOf(ESC, position);
    if (escape === -1) {
      emit(text.slice(position));
      break;
    }
    emit(text.slice(position, escape));
    const { next, params } = readEscape(text, escape);
    if (params !== null) applySgr(style, params, palette);
    position = next;
  }

  return html;
}
