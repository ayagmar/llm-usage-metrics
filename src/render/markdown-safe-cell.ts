import { splitCellLines } from './table-text-layout.js';

const markdownSpecialCharacterPattern = /[\\`*_~[\]()!|]/gu;

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(markdownSpecialCharacterPattern, '\\$&');
}

export function toMarkdownSafeCell(value: string): string {
  return splitCellLines(value)
    .map((line) => escapeMarkdownText(line))
    .join('<br>');
}
