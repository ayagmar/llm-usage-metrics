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

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeMarkdownText(value: string): string {
  const escapedMarkdownText = escapeHtmlText(value).replace(
    markdownSpecialCharacterPattern,
    '\\$&',
  );

  return escapeBareAutolinks(escapedMarkdownText);
}

function toMarkdownCodeSpan(value: string): string {
  const longestBacktickRun = Math.max(
    ...[...value.matchAll(/`+/gu)].map((match) => match[0].length),
    0,
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  const escapedValue = value.replaceAll('|', '\\|');

  return `${fence}${escapedValue}${fence}`;
}

export function toMarkdownSafeCodeCell(value: string): string {
  return splitCellLines(value)
    .map((line) => toMarkdownCodeSpan(line))
    .join('<br>');
}

export function toMarkdownSafeCell(value: string): string {
  return splitCellLines(value)
    .map((line) => escapeMarkdownText(line))
    .join('<br>');
}
