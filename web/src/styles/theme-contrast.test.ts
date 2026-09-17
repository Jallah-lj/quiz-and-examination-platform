/**
 * Contrast audit for the light and dark palettes.
 *
 * The tokens are read straight out of styles/app.css, so this fails whenever a palette
 * edit makes text hard to read — the usual way a dark theme goes wrong.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cssPath = ['src/styles/app.css', 'web/src/styles/app.css']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
if (!cssPath) throw new Error('Could not locate styles/app.css for the contrast audit');
const css = readFileSync(cssPath, 'utf8');

function block(startMarker: string, endMarker: string): Record<string, string> {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker, start + startMarker.length);
  const body = css.slice(start, end === -1 ? undefined : end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s*;/g)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

const light = block(':root {', "/*\n * Dark theme");
const dark = block("[data-theme='dark'] {", '/* ---');

function toRgb(hex: string): [number, number, number] {
  const value = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/** Every pair the interface actually renders, with the ratio WCAG asks of it. */
const PAIRS: { name: string; foreground: string; background: string; minimum: number }[] = [
  { name: 'body text on a card', foreground: '--ink-800', background: '--surface', minimum: 4.5 },
  { name: 'heading on a card', foreground: '--ink-900', background: '--surface', minimum: 4.5 },
  { name: 'muted text on a card', foreground: '--ink-500', background: '--surface', minimum: 4.5 },
  { name: 'muted text on the page', foreground: '--ink-500', background: '--surface-sunken', minimum: 4.5 },
  { name: 'body text on the page', foreground: '--ink-800', background: '--surface-sunken', minimum: 4.5 },
  { name: 'links and accents', foreground: '--accent-text', background: '--surface', minimum: 4.5 },
  { name: 'links on a tinted panel', foreground: '--accent-text', background: '--tint-info', minimum: 4.5 },
  { name: 'primary button label', foreground: '--accent-contrast', background: '--navy-700', minimum: 4.5 },
  { name: 'toast text', foreground: '--toast-text', background: '--toast-bg', minimum: 4.5 },
  { name: 'success badge', foreground: '--green-700', background: '--green-100', minimum: 4.5 },
  { name: 'warning badge', foreground: '--amber-700', background: '--amber-100', minimum: 4.5 },
  { name: 'danger badge', foreground: '--red-700', background: '--red-100', minimum: 4.5 },
  { name: 'neutral badge', foreground: '--ink-700', background: '--slate-100', minimum: 4.5 },
  { name: 'chart labels', foreground: '--ink-500', background: '--surface', minimum: 4.5 },
  { name: 'progress track outline', foreground: '--border-strong', background: '--surface', minimum: 1.2 },
];

/** The pairs above must also hold on the tinted panels each role uses. */
const ON_TINT: { name: string; foreground: string; background: string }[] = [
  { name: 'text on an info panel', foreground: '--ink-700', background: '--tint-info' },
  { name: 'text on a warning panel', foreground: '--ink-700', background: '--tint-warning' },
  { name: 'text on a danger panel', foreground: '--ink-700', background: '--tint-danger' },
  { name: 'text on a success panel', foreground: '--ink-700', background: '--tint-success' },
  { name: 'selected option text', foreground: '--ink-800', background: '--tint-selected' },
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s palette', (themeName, palette) => {
  it('defines every token the contrast rules need', () => {
    const required = new Set([
      ...PAIRS.flatMap((pair) => [pair.foreground, pair.background]),
      ...ON_TINT.flatMap((pair) => [pair.foreground, pair.background]),
    ]);
    const missing = [...required].filter((token) => !palette[token]);
    expect(missing, `${themeName} palette is missing ${missing.join(', ')}`).toEqual([]);
  });

  it.each(PAIRS)('$name reaches $minimum:1', ({ foreground, background, minimum }) => {
    const ratio = contrast(palette[foreground], palette[background]);
    expect(ratio, `${themeName}: ${foreground} on ${background} is ${ratio}:1`).toBeGreaterThanOrEqual(minimum);
  });

  it.each(ON_TINT)('$name stays readable', ({ foreground, background }) => {
    const ratio = contrast(palette[foreground], palette[background]);
    expect(ratio, `${themeName}: ${foreground} on ${background} is ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps surfaces and text apart', () => {
    expect(palette['--surface']).not.toBe(palette['--surface-sunken']);
    expect(palette['--border']).not.toBe(palette['--surface']);
  });
});

describe('palette relationship', () => {
  it('inverts the page for dark mode instead of re-tinting it', () => {
    // A dark surface with light text in dark mode, and the reverse in light.
    expect(relativeLuminance(light['--surface'])).toBeGreaterThan(0.7);
    expect(relativeLuminance(dark['--surface'])).toBeLessThan(0.05);
    expect(relativeLuminance(dark['--ink-900'])).toBeGreaterThan(0.7);
    expect(relativeLuminance(light['--ink-900'])).toBeLessThan(0.05);
  });
});

describe('examination timer states', () => {
  /*
   * Regression guard: the component emits "exam-timer--danger" but the stylesheet once
   * defined only "--critical", so the last minute of an attempt had no signal at all.
   */
  const componentPath = [
    'src/pages/attempts/TakeAttemptPage.tsx',
    'web/src/pages/attempts/TakeAttemptPage.tsx',
  ]
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  const component = componentPath ? readFileSync(componentPath, 'utf8') : '';

  it('styles every urgency state the examination timer applies', () => {
    const assignments = component.split('\n').filter((line) => /timerClass\s*=/.test(line));
    expect(assignments.length, 'the timer no longer assigns an urgency class').toBeGreaterThan(0);
    const states = [
      ...new Set(assignments.flatMap((line) => [...line.matchAll(/'([a-z]+)'/g)].map((match) => match[1]))),
    ];
    expect(states.sort()).toEqual(['danger', 'warning']);
    const unstyled = states.filter((state) => !new RegExp(`\\.exam-timer--${state}\\b`).test(css));
    expect(unstyled, `no CSS rule for timer state(s): ${unstyled.join(', ')}`).toEqual([]);
  });

  it('states timer urgency in words as well as colour', () => {
    // Colour alone may never carry the message, so the label carries text too.
    expect(component).toMatch(/exam-timer__urgency/);
    expect(css).toMatch(/\.exam-timer__urgency\b/);
    expect(component).toMatch(/under 1 min|under 5 min/);
  });
});

describe('dark palette is black, not blue', () => {
  /*
   * The dark theme asked for true black: surfaces, borders, chrome and the text ramp
   * must be neutral, so blue only ever appears as an accent (buttons, links, series).
   */
  const NEUTRAL = [
    '--surface',
    '--surface-sunken',
    '--border',
    '--border-strong',
    '--ink-50',
    '--ink-100',
    '--ink-200',
    '--ink-300',
    '--ink-400',
    '--ink-500',
    '--ink-600',
    '--ink-700',
    '--ink-800',
    '--ink-900',
    '--slate-100',
    '--navy-900',
    '--navy-100',
    '--toast-bg',
    '--chart-grid',
    '--chart-grid-strong',
  ];

  it('keeps every neutral token free of a colour cast', () => {
    const tinted = NEUTRAL.filter((token) => {
      const [r, g, b] = toRgb(dark[token]);
      return Math.abs(b - r) > 3 || Math.abs(b - g) > 3;
    });
    expect(tinted, `these dark tokens still lean blue: ${tinted.join(', ')}`).toEqual([]);
  });

  it('paints the page and the chrome with true black', () => {
    expect(dark['--surface-sunken']).toBe('#000000');
    expect(dark['--navy-900']).toBe('#000000');
    // The card surface stays a hair off black so it reads as a separate panel.
    expect(relativeLuminance(dark['--surface'])).toBeLessThanOrEqual(0.01);
    expect(dark['--surface']).not.toBe(dark['--surface-sunken']);
  });

  it('keeps the navy as an accent, never as a panel wash', () => {
    // Accent tokens are allowed to be blue, and must remain readable on black.
    expect(contrast(dark['--accent-text'], dark['--surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark['--accent-contrast'], dark['--navy-700'])).toBeGreaterThanOrEqual(4.5);
  });
});
