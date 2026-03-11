import { splitCellLines } from './table-text-layout.js';

const markdownSpecialCharacterPattern = /[\\`*_~[\]()!|]/gu;
const bareUrlPattern = /\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+/giu;
const bareEmailPattern = /(^|[^\w.+-])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?=$|[^\w.-])/giu;

function escapeBareAutolinks(value: string): string {
  const withoutBareUrls = value.replace(bareUrlPattern, (match) =>
    match.startsWith('www.') ? match.replace('www.', 'www\\.') : match.replace('://', '\\://'),
  );

  return withoutBareUrls.replace(
    bareEmailPattern,
    (_, prefix: string, email: string) => `${prefix}${email.replace('@', '\\@')}`,
  );
}

function escapeMarkdownText(value: string): string {
  const escapedMarkdownText = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(markdownSpecialCharacterPattern, '\\$&');

  return escapeBareAutolinks(escapedMarkdownText);
}

export function toMarkdownSafeCell(value: string): string {
  return splitCellLines(value)
    .map((line) => escapeMarkdownText(line))
    .join('<br>');
}
