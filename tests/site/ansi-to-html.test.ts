import { describe, expect, it } from 'vitest';

import {
  ansiToHtml,
  color256,
  DEFAULT_PALETTE,
} from '../../site/scripts/lib/ansi-to-html.mjs';

const ESC = '\u001b';
const sgr = (codes: string) => `${ESC}[${codes}m`;

describe('ansiToHtml', () => {
  it('leaves plain text as escaped text without spans', () => {
    expect(ansiToHtml('Total: 3 <events> & "more"')).toBe(
      'Total: 3 &lt;events&gt; &amp; &quot;more&quot;',
    );
  });

  it('escapes text inside styled runs', () => {
    expect(ansiToHtml(`${sgr('31')}<script>&${sgr('0')}`)).toBe(
      `<span style="color:${DEFAULT_PALETTE[1]}">&lt;script&gt;&amp;</span>`,
    );
  });

  it('maps the 16 foreground and background colours to the palette', () => {
    expect(ansiToHtml(`${sgr('32')}ok`)).toBe(`<span style="color:${DEFAULT_PALETTE[2]}">ok</span>`);
    expect(ansiToHtml(`${sgr('94')}hi`)).toBe(`<span style="color:${DEFAULT_PALETTE[12]}">hi</span>`);
    expect(ansiToHtml(`${sgr('41')}x`)).toBe(
      `<span style="background-color:${DEFAULT_PALETTE[1]}">x</span>`,
    );
    expect(ansiToHtml(`${sgr('107')}x`)).toBe(
      `<span style="background-color:${DEFAULT_PALETTE[15]}">x</span>`,
    );
  });

  it('reads 256-colour and truecolor sequences', () => {
    expect(ansiToHtml(`${sgr('38;5;196')}a`)).toBe('<span style="color:#ff0000">a</span>');
    expect(ansiToHtml(`${sgr('38;5;244')}a`)).toBe('<span style="color:#808080">a</span>');
    expect(ansiToHtml(`${sgr('48;2;10;20;30')}a`)).toBe(
      '<span style="background-color:#0a141e">a</span>',
    );
    // A colour code followed by a style code in the same sequence applies both.
    expect(ansiToHtml(`${sgr('38;2;255;128;0;1')}a`)).toBe(
      '<span style="color:#ff8000;font-weight:700">a</span>',
    );
  });

  it('applies bold, dim, italic and underline together', () => {
    expect(ansiToHtml(`${sgr('1;2;3;4')}a`)).toBe(
      '<span style="font-weight:700;opacity:0.65;font-style:italic;text-decoration:underline">a</span>',
    );
  });

  it('undoes only what each reset code covers', () => {
    const html = ansiToHtml(
      `${sgr('1;31')}a${sgr('39')}b${sgr('22')}c${sgr('4;32')}d${sgr('0')}e${sgr('3')}f${sgr('')}g`,
    );
    expect(html).toBe(
      [
        `<span style="color:${DEFAULT_PALETTE[1]};font-weight:700">a</span>`,
        '<span style="font-weight:700">b</span>',
        'c',
        `<span style="color:${DEFAULT_PALETTE[2]};text-decoration:underline">d</span>`,
        'e',
        '<span style="font-style:italic">f</span>',
        'g',
      ].join(''),
    );
  });

  it('ignores unknown SGR codes and malformed extended colours', () => {
    expect(ansiToHtml(`${sgr('5;7;53')}blink`)).toBe('blink');
    expect(ansiToHtml(`${sgr('38;5;999')}x`)).toBe('x');
    expect(ansiToHtml(`${sgr('38;9;1')}x`)).toBe('x');
  });

  it('drops other escape sequences but keeps their text', () => {
    const hyperlink = `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;\u0007`;
    expect(ansiToHtml(`${ESC}[2K${ESC}[1Gline ${hyperlink}`)).toBe('line link');
  });

  it('keeps line breaks', () => {
    expect(ansiToHtml(`${sgr('1')}a\nb${sgr('0')}\nc`)).toBe(
      '<span style="font-weight:700">a\nb</span>\nc',
    );
  });
});

describe('color256', () => {
  it('covers the palette, the colour cube and the grey ramp', () => {
    expect(color256(9)).toBe(DEFAULT_PALETTE[9]);
    expect(color256(16)).toBe('#000000');
    expect(color256(231)).toBe('#ffffff');
    expect(color256(232)).toBe('#080808');
    expect(color256(255)).toBe('#eeeeee');
  });
});
