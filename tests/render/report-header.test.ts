import { describe, expect, it } from 'vitest';

import { renderReportHeader } from '../../src/render/report-header.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';

describe('renderReportHeader', () => {
  it('renders a plain boxed header when color is disabled', () => {
    const rendered = renderReportHeader({
      title: 'Monthly Token Usage Report',
      useColor: false,
    });

    expect(rendered).toContain('┌');
    expect(rendered).toContain('┐');
    expect(rendered).toContain('└');
    expect(rendered).toContain('┘');
    expect(rendered).toContain('Monthly Token Usage Report');
    expect(rendered).not.toContain('Timezone');
    expect(rendered.includes('\u001b[')).toBe(false);
  });

  it('prints the title without a box, wrapped, when the box would not fit the terminal', () => {
    const title = 'Usage summary for 2026-10-12 (Africa/Casablanca)';

    expect(renderReportHeader({ title, useColor: false, terminalWidth: 50 })).toBe(title);
    expect(renderReportHeader({ title, useColor: false, terminalWidth: 44 })).toBe(
      'Usage summary for 2026-10-12\n(Africa/Casablanca)',
    );
    expect(renderReportHeader({ title, useColor: false, terminalWidth: 80 })).toContain('┌');
  });

  it('renders header content when color is enabled', () => {
    const rendered = renderReportHeader({
      title: 'Daily Token Usage Report',
      useColor: true,
    });

    expect(rendered).toContain('Daily Token Usage Report');
    expect(rendered).not.toContain('Timezone');
    expect(rendered).toContain('┌');
    expect(rendered).toContain('┘');
  });

  it('keeps header borders aligned for wide unicode characters', () => {
    const rendered = renderReportHeader({
      title: 'Usage 漢字',
      useColor: false,
    });

    const lineWidths = rendered.split('\n').map((line) => visibleWidth(line));

    expect(new Set(lineWidths).size).toBe(1);
  });
});
