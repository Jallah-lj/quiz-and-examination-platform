import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../context/ThemeContext';
import { ThemeOptions, ThemeToggleButton } from './ThemeToggle';

// The suite runs from either the workspace root or web/ depending on the entry point.
const cssPath = ['src/styles/app.css', 'web/src/styles/app.css']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
if (!cssPath) throw new Error('Could not locate styles/app.css for the theme audit');
const css = readFileSync(cssPath, 'utf8');

/** Tokens that legitimately differ per theme, and the ones that are layout constants. */
const LAYOUT_TOKENS = [
  '--font-sans',
  '--font-mono',
  '--radius-sm',
  '--radius',
  '--radius-lg',
  '--sidebar-width',
  '--topbar-height',
];

describe('appearance controls', () => {
  it('switches the palette and states what the press will do', async () => {
    const user = userEvent.setup();
    document.documentElement.dataset.theme = 'light';
    localStorage.clear();
    render(
      <ThemeProvider>
        <ThemeToggleButton />
      </ThemeProvider>,
    );

    const button = screen.getByRole('button', { name: 'Switch to dark theme' });
    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe('dark');
    // The same control now offers the opposite action.
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('marks the active option in text, not only in colour', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    render(
      <ThemeProvider>
        <ThemeOptions />
      </ThemeProvider>,
    );

    // Nothing stored yet, so the active option is "Match system".
    const system = screen.getByRole('button', { name: /Match system/ });
    expect(system).toHaveAttribute('aria-pressed', 'true');
    expect(system).toHaveTextContent('Selected');

    await user.click(screen.getByRole('button', { name: /Dark/ }));
    expect(screen.getByRole('button', { name: /Dark/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Light/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Selected')).toBeInTheDocument();
    expect(localStorage.getItem('examsys.theme')).toBe('dark');
  });
});

describe('theme tokens', () => {
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/*\n * Dark theme'));
  const darkBlock = css.slice(css.indexOf("[data-theme='dark'] {"), css.indexOf('/* ---', css.indexOf("[data-theme='dark'] {")));

  function section(startMarker: string, endMarker: string) {
    const start = css.indexOf(startMarker);
    const end = css.indexOf(endMarker, start + startMarker.length);
    return css.slice(start, end === -1 ? undefined : end);
  }

  // The print stylesheet and the always-dark chrome, identified by their content.
  const printBlock = section('@media print {', '\n}\n');
  const alwaysDarkBlock = section('.brand-mark {', '\n}\n');

  function tokens(block: string) {
    return new Set(Array.from(block.matchAll(/(--[a-z0-9-]+):/g), (match) => match[1]));
  }

  it('defines a dark override for every colour token', () => {
    const light = [...tokens(rootBlock)].filter((token) => !LAYOUT_TOKENS.includes(token));
    const dark = tokens(darkBlock);
    const missing = light.filter((token) => !dark.has(token));
    // A colour without a dark value would keep its light colour on a dark surface.
    expect(missing).toEqual([]);
  });

  it('only references tokens that are actually defined', () => {
    const used = new Set(Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g), (match) => match[1]));
    const defined = new Set([...tokens(rootBlock), ...tokens(darkBlock)]);
    const undefinedTokens = [...used].filter((token) => !defined.has(token));
    expect(undefinedTokens).toEqual([]);
  });

  it('does not hard-code light backgrounds outside the token blocks', () => {
    // Two regions are deliberately theme-independent and are excluded by name rather than
    // by line number, so an unrelated edit cannot silently move the exemption:
    //  - "@media print" always prints dark on white;
    //  - always-dark chrome (the sidebar and the examination header) sits on navy in both
    //    themes, so a white rule there is a light-on-dark accent, not a broken token.
    const themeIndependent = [printBlock, alwaysDarkBlock];
    const scannable = themeIndependent.reduce((text, block) => text.replace(block, ''), css);

    // The dark palette must not be beaten by a literal #fff or a near-white hex.
    const literals = scannable
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /background:\s*#(fff|ffffff|f[0-9a-f]{2}|f[0-9a-f]{5}|e[0-9a-f]{2})\b/i.test(line))
      .filter(({ line }) => !line.startsWith('--'))
      // The offline status dot is a pale marker on the always-dark examination header.
      .filter(({ line }) => !/connection-chip__dot/.test(line));
    expect(literals.map((entry) => `${entry.number}: ${entry.line}`)).toEqual([]);
    // The exemptions must still exist, otherwise the scan above becomes meaningless.
    expect(printBlock).toContain('@media print');
    expect(alwaysDarkBlock).toContain('background: #ffffff');
  });
});

describe('responsive rules', () => {
  it('keeps every wide layout paired with a narrowing rule', () => {
    // Each of these grids or bars would overflow a phone without its own breakpoint.
    const required = [
      '.stat-grid',
      '.split-2',
      '.page-header',
      '.card__body',
      '.pipeline',
      '.attention-list__item',
      '.deadline__actions',
      '.account-button__text',
      '.metric-list__bar',
      'table.data-table.responsive',
      '.dashboard-charts',
      '.chart--donut',
    ];
    const mediaBlocks = Array.from(css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g));
    expect(mediaBlocks.length).toBeGreaterThan(4);
    // Any narrowing rule counts: the wide grids collapse at 1180px, tables at 720px.
    const mobileCss = mediaBlocks.filter((block) => Number(block[1]) <= 1180).map((block) => block[2]).join('\n');
    const uncovered = required.filter((selector) => !mobileCss.includes(selector));
    expect(uncovered).toEqual([]);
  });

  it('pairs the two dashboard chart panels without letting either one squeeze', () => {
    const band = css.match(/\.dashboard-charts \{([\s\S]*?)\n\}/);
    expect(band, 'the dashboard chart band has no layout rule').not.toBeNull();
    // The thirty-column series gets the wider column of the pair.
    const columns = band![1].match(/grid-template-columns: minmax\(0, ([\d.]+)fr\) minmax\(0, ([\d.]+)fr\)/);
    expect(columns, 'the chart band is not a two-column proportional grid').not.toBeNull();
    expect(Number(columns![1])).toBeGreaterThan(Number(columns![2]));
    // Both cards stretch to a common height and stack their chart against the baseline.
    expect(css).toMatch(/\.dashboard-charts > \.card \{[^}]*display: flex/);
    expect(css).toMatch(/\.dashboard-charts > \.card > \.card__body \{[^}]*justify-content: flex-end/);
    // The band collapses to one column, and the ring stacks above its legend on a phone.
    const stack = css.match(/@media \(max-width: (\d+)px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?\.dashboard-charts \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(stack, 'the chart band never collapses to a single column').not.toBeNull();
    // It must collapse before the grades column becomes too narrow for the ring.
    expect(Number(stack![1])).toBeGreaterThanOrEqual(960);
    expect(Number(stack![1])).toBeLessThanOrEqual(1180);
    const phone = css.match(/@media \(max-width: 520px\) \{([\s\S]*?)\n\}/);
    expect(phone![1]).toContain('.chart--donut { grid-template-columns: minmax(0, 1fr);');
  });

  it('has a phone breakpoint that trims the topbar and full-width controls', () => {
    const phone = css.match(/@media \(max-width: 520px\) \{([\s\S]*?)\n\}/);
    expect(phone).not.toBeNull();
    expect(phone![1]).toContain('.account-button__text { display: none; }');
    expect(phone![1]).toContain('.page-header__actions');
    expect(phone![1]).toContain('.toast-region');
  });

  it('honours a reduced-motion preference', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
