/**
 * Layout containment.
 *
 * A grid track with a hard pixel floor — `repeat(auto-fit, minmax(205px, 1fr))` — refuses to
 * shrink below that floor. In any container narrower than the floor the track still lays out
 * at its floor, so the content is painted outside its card instead of inside it. The chart
 * panels hit exactly that: the ring's fixed-size SVG and the legend's 205px floor together
 * were wider than a narrow card, and `justify-content: center` pushed the pair out of both
 * sides of the box.
 *
 * jsdom applies no stylesheet, so these rules cannot be asserted by rendering. They are read
 * from the stylesheet instead, which is what the browser will actually be handed.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const webRoot = existsSync(resolve(process.cwd(), 'src/styles/app.css')) ? process.cwd() : resolve(process.cwd(), 'web');
const css = readFileSync(resolve(webRoot, 'src/styles/app.css'), 'utf8');

/** The declarations of a rule, by selector, from anywhere in the file. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`rule not found in app.css: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function declarations(selector: string): Record<string, string> {
  // Comments are stripped first: they contain colons and semicolons, which would otherwise
  // be parsed as part of a property name and hide the declaration that follows them.
  const body = rule(selector).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  for (const part of body.split(';')) {
    const [property, ...rest] = part.split(':');
    if (!property || !rest.length) continue;
    out[property.trim()] = rest.join(':').trim();
  }
  return out;
}

/** Every `grid-template-columns` declaration in the file, with the line it sits on. */
function gridTemplates(): { line: number; value: string }[] {
  return css
    .split('\n')
    .map((text, index) => ({ line: index + 1, value: text.trim() }))
    .filter((entry) => entry.value.startsWith('grid-template-columns:'))
    .map((entry) => ({ line: entry.line, value: entry.value }));
}

describe('grid tracks can always shrink to their container', () => {
  it('guards every auto-fit and auto-fill floor with min()', () => {
    // A floor at or above this can overflow the narrowest card the app renders into.
    const RISKY = 140;
    const offenders: string[] = [];
    for (const { line, value } of gridTemplates()) {
      const repeat = value.match(/repeat\(\s*auto-(?:fit|fill)\s*,\s*minmax\(\s*(\d+)px/);
      if (!repeat) continue;
      const floor = Number(repeat[1]);
      if (floor >= RISKY && !value.includes('minmax(min(')) {
        offenders.push(`line ${line}: ${value}`);
      }
    }
    expect(
      offenders,
      `these tracks cannot shrink and will paint outside a narrow card:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('chart panels contain themselves', () => {
  const chart = declarations('.chart');

  it('lets a chart shrink below its content width', () => {
    expect(chart['min-width']).toBe('0');
    expect(chart['max-width']).toBe('100%');
  });

  it('lets the donut grid shrink: a shrinkable ring track and a legend with no auto minimum', () => {
    const donut = declarations('.chart--donut');
    // The ring's track is sized from a fixed-pixel SVG, so it must be allowed to shrink.
    expect(donut['grid-template-columns']).toMatch(/^minmax\(0/);
    // Without this the legend's min-content width becomes the grid's floor.
    expect(declarations('.chart--donut > .chart__legend')['min-width']).toBe('0');
    // ...and the fixed-size SVG is capped to the track it lands in.
    expect(declarations('.chart--donut > .chart__donut')['max-width']).toBe('100%');
  });

  it('clips the column row so a nowrap label cannot spill out of the card', () => {
    // Hidden labels still occupy layout, and they are wider than their columns on a dense
    // series; unclipped, they extend the card's content past its own edge.
    expect(declarations('.chart__bars')['overflow-x']).toBe('clip');
  });

  it('confines values and labels to their own column', () => {
    for (const selector of ['.chart__value', '.chart__label']) {
      const node = declarations(selector);
      expect(node['max-width'], `${selector} can outgrow its column`).toBe('100%');
      expect(node['overflow'], `${selector} is not clipped`).toBe('hidden');
    }
  });

  it('clips the trend plot to its own box', () => {
    // `overflow: visible` let a figure anchored to the last day paint over the panel next to
    // the card. The edge labels are now anchored inward, and the box clips what is left.
    expect(declarations('.trend__svg')['overflow']).not.toBe('visible');
    expect(declarations('.trend__tooltip')['max-width']).toBe('100%');
  });

  it('keeps every chart container shrinkable', () => {
    // The dashboard's paired columns: a grid item defaults to min-content, which is wider
    // than the column for a dense chart.
    expect(declarations('.split-2 > *')['min-width']).toBe('0');
    expect(declarations('.dashboard-charts > .card > .card__body')['min-width']).toBe('0');
    expect(declarations('.chart__key li')['max-width']).toBe('100%');
  });
});
