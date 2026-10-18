// Link extraction for the built-site link checker: the `href`/`src` values and `id`s of an
// HTML page, and how a link resolves against the site base. Scans with indexOf, no regex over
// page text. Script and style bodies are skipped, so code that builds markup is not read as
// links.

const ENTITIES = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

function decodeEntities(value) {
  let result = value;
  for (const [entity, character] of Object.entries(ENTITIES)) {
    result = result.replaceAll(entity, character);
  }
  return result;
}

/** The page with the contents of `<script>` and `<style>` elements removed. */
export function stripRawText(html) {
  const lower = html.toLowerCase();
  let result = '';
  let position = 0;

  while (position < html.length) {
    const scriptAt = lower.indexOf('<script', position);
    const styleAt = lower.indexOf('<style', position);
    const candidates = [scriptAt, styleAt].filter((index) => index !== -1);
    if (candidates.length === 0) break;
    const start = Math.min(...candidates);
    const name = start === scriptAt ? 'script' : 'style';
    const openEnd = lower.indexOf('>', start);
    if (openEnd === -1) break;
    result += html.slice(position, openEnd + 1);
    const close = lower.indexOf(`</${name}`, openEnd + 1);
    if (close === -1) {
      position = html.length;
      break;
    }
    position = close;
  }

  return result + html.slice(position);
}

function isNameBoundary(character) {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f'
  );
}

function isTagStart(character) {
  return character !== undefined && /[a-z]/iu.test(character);
}

/** The text of every start tag (`<a href="…">`), skipping comments and text content. */
export function startTags(html) {
  const tags = [];
  let position = 0;

  for (;;) {
    const open = html.indexOf('<', position);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close === -1) break;
      position = close + 3;
      continue;
    }
    if (!isTagStart(html[open + 1])) {
      position = open + 1;
      continue;
    }
    // The tag ends at the first `>` outside a quoted attribute value.
    let end = open + 1;
    let quote = null;
    while (end < html.length) {
      const character = html[end];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      end += 1;
    }
    tags.push(html.slice(open, end + 1));
    position = end + 1;
  }

  return tags;
}

/**
 * The values of attribute `name` in one start tag, entities decoded. Attributes are read in
 * order as HTML tokenizes them: optional whitespace around `=`, quoted or bare values, and
 * names case-insensitive, so `href = "…"` counts and `title="href=…"` does not.
 */
function readAttributes(tag, name, values) {
  let position = 1;
  while (position < tag.length && !isNameBoundary(tag[position]) && tag[position] !== '>') {
    position += 1;
  }

  for (;;) {
    while (isNameBoundary(tag[position]) || tag[position] === '/') position += 1;
    if (position >= tag.length || tag[position] === '>') return;

    const nameStart = position;
    position += 1;
    while (
      position < tag.length &&
      !isNameBoundary(tag[position]) &&
      !'/>='.includes(tag[position])
    ) {
      position += 1;
    }
    const attribute = tag.slice(nameStart, position).toLowerCase();

    while (isNameBoundary(tag[position])) position += 1;
    if (tag[position] !== '=') continue;
    position += 1;
    while (isNameBoundary(tag[position])) position += 1;

    const quote = tag[position];
    let value;
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, position + 1);
      if (end === -1) return;
      value = tag.slice(position + 1, end);
      position = end + 1;
    } else {
      const end = position;
      while (position < tag.length && !isNameBoundary(tag[position]) && tag[position] !== '>') {
        position += 1;
      }
      value = tag.slice(end, position);
    }
    if (attribute === name) values.push(decodeEntities(value));
  }
}

/** Every value of attribute `name` on the page's start tags. */
export function extractAttributeValues(html, name) {
  const values = [];
  for (const tag of startTags(html)) readAttributes(tag, name, values);
  return values;
}

/**
 * The URLs of a `srcset` value: the first non-whitespace run of each comma-separated
 * candidate, without its width or density descriptor. A URL may hold commas; trailing
 * commas end it.
 */
export function splitSrcset(value) {
  const urls = [];
  let position = 0;

  while (position < value.length) {
    while (isNameBoundary(value[position]) || value[position] === ',') position += 1;
    if (position >= value.length) break;

    const start = position;
    while (position < value.length && !isNameBoundary(value[position])) position += 1;
    let end = position;
    while (end > start && value[end - 1] === ',') end -= 1;

    if (end === position) {
      while (position < value.length && value[position] !== ',') position += 1;
    }
    if (end > start) urls.push(value.slice(start, end));
  }
  return urls;
}

/** The link targets of a page: every `href`, `src` and `srcset` URL, outside scripts and styles. */
export function extractLinks(html) {
  const markup = stripRawText(html);
  return [
    ...extractAttributeValues(markup, 'href'),
    ...extractAttributeValues(markup, 'src'),
    ...extractAttributeValues(markup, 'srcset').flatMap(splitSrcset),
  ];
}

/** The fragment targets of a page: every `id`. */
export function extractIds(html) {
  return new Set(extractAttributeValues(stripRawText(html), 'id'));
}

const IGNORED_SCHEMES = ['mailto:', 'tel:', 'javascript:', 'data:', 'blob:'];

function hasScheme(value) {
  const colon = value.indexOf(':');
  if (colon <= 0) return false;
  const slash = value.indexOf('/');
  return slash === -1 || colon < slash;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Classifies one link found on the page at URL path `pagePath` (e.g. `/base/guide/`).
 * - `external`: another origin (`https:`, `//host`), counted but not fetched.
 * - `ignored`: `mailto:`, `tel:`, `javascript:`, `data:`, `blob:` and empty values.
 * - `internal`: `path` is the target URL path (base included, query dropped) and `fragment`
 *   the decoded `#fragment` or null. Relative links resolve against the page.
 */
export function classifyLink(value, pagePath) {
  const link = value.trim();
  const lower = link.toLowerCase();

  if (link === '' || IGNORED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return { kind: 'ignored' };
  }
  if (link.startsWith('//') || hasScheme(link)) return { kind: 'external' };

  const url = new URL(link, `http://site.invalid${pagePath}`);
  const fragment = url.hash === '' || url.hash === '#' ? null : safeDecode(url.hash.slice(1));
  return { kind: 'internal', path: safeDecode(url.pathname), fragment };
}

/**
 * The file a URL path maps to under the built site, as candidate paths relative to the dist
 * root, or null when the path is outside the base. `/base/a/` → `a/index.html`; `/base/a` →
 * `a`, `a.html`, `a/index.html`.
 */
export function toDistCandidates(urlPath, base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  if (urlPath === root.slice(0, -1)) return ['index.html'];
  if (!urlPath.startsWith(root)) return null;

  const relative = urlPath.slice(root.length);
  if (relative === '' || relative.endsWith('/')) return [`${relative}index.html`];
  return [relative, `${relative}.html`, `${relative}/index.html`];
}
