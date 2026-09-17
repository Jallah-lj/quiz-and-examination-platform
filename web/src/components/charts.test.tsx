import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BarChart, DonutChart, LineChart, axisTickIndexes, distinctTones } from './charts';

/** Pretend the panel is a given number of CSS pixels wide, as a real layout would. */
function withPanelWidth(width: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 200,
    top: 0,
    left: 0,
    right: width,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Thirty days, as the administrator and platform dashboards send them. */
function dailySeries(count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    label: `08-${String(index + 1).padStart(2, '0')}`,
    detail: `2026-08-${String(index + 1).padStart(2, '0')}`,
    value: index % 7,
  }));
}

describe('axisTickIndexes', () => {
  it('labels every point of a short series', () => {
    expect(axisTickIndexes(5, 7)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins a long series down to the target and always labels the newest point', () => {
    const ticks = axisTickIndexes(30, 7);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks[ticks.length - 1]).toBe(29);
    // Ticks are evenly spaced and never adjacent, so the labels cannot collide.
    const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBeGreaterThan(1);
  });

  it('returns nothing for an empty series', () => {
    expect(axisTickIndexes(0)).toEqual([]);
  });
});

describe('BarChart', () => {
  it('prints a readable number of date labels on a thirty-day series', () => {
    render(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);

    const chart = screen.getByRole('img', { name: 'Submissions per day' });
    const labels = Array.from(chart.querySelectorAll('.chart__label')).filter(
      (node) => !node.classList.contains('chart__label--hidden'),
    );
    // Six or seven ticks — not thirty overlapping timestamps.
    expect(labels.length).toBeLessThanOrEqual(7);
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const label of labels) {
      expect(label.textContent).toMatch(/^08-\d{2}$/);
    }
    // The newest day is always labelled.
    expect(labels[labels.length - 1].textContent).toBe('08-30');
  });

  it('keeps the numbers available when the columns are too narrow to print them', () => {
    render(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);

    const chart = screen.getByRole('img', { name: 'Submissions per day' });
    const inlineValues = Array.from(chart.querySelectorAll('.chart__value')).filter(
      (node) => !node.classList.contains('chart__value--hidden'),
    );
    expect(inlineValues).toHaveLength(0);
    // Every day is still reachable: a tooltip on the column and a table for screen readers.
    const columns = chart.querySelectorAll('.chart__column');
    expect(columns).toHaveLength(30);
    expect(columns[5].getAttribute('title')).toBe('2026-08-06: 5 submissions');
    const table = screen.getByRole('table', { name: 'Submissions per day' });
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(table).getByText('2026-08-30')).toBeInTheDocument();
  });

  it('prints a value for every bar once the columns are wide enough', () => {
    render(<BarChart ariaLabel="Submissions per day" data={dailySeries(10)} />);

    const chart = screen.getByRole('img', { name: 'Submissions per day' });
    const inlineValues = Array.from(chart.querySelectorAll('.chart__value')).filter(
      (node) => !node.classList.contains('chart__value--hidden'),
    );
    // Ten columns hold ten numbers; the dates are thinned to every other day.
    expect(inlineValues).toHaveLength(10);
    const labels = Array.from(chart.querySelectorAll('.chart__label')).filter(
      (node) => !node.classList.contains('chart__label--hidden'),
    );
    expect(labels.map((node) => node.textContent)).toEqual(['08-02', '08-04', '08-06', '08-08', '08-10']);
  });

  it('thins the labels further on a narrow card and drops the numbers before they collide', () => {
    // A phone-width card: 320px for thirty columns.
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { ...original.call(this), width: 320, height: 180, top: 0, left: 0, right: 320, bottom: 180, x: 0, y: 0 } as DOMRect;
    };
    try {
      render(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);
      const chart = screen.getByRole('img', { name: 'Submissions per day' });
      const labels = Array.from(chart.querySelectorAll('.chart__label')).filter(
        (node) => !node.classList.contains('chart__label--hidden'),
      );
      expect(labels.length).toBeLessThanOrEqual(5);
      expect(labels[labels.length - 1].textContent).toBe('08-30');
      const inlineValues = Array.from(chart.querySelectorAll('.chart__value')).filter(
        (node) => !node.classList.contains('chart__value--hidden'),
      );
      expect(inlineValues).toHaveLength(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('summarises the period from the real figures, and says so when nothing happened', () => {
    render(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);
    // Four full 0+1+2+3+4+5+6 cycles plus 0 and 1 = 85; the peak of 6 first occurs on 08-07.
    expect(screen.getByText('Peak 6 submissions on 2026-08-07 · 85 submissions in total.')).toBeInTheDocument();

    render(
      <BarChart
        ariaLabel="Sign-ins per day"
        unit="successful sign-ins"
        data={[
          { label: '08-01', detail: '2026-08-01', value: 0 },
          { label: '08-02', detail: '2026-08-02', value: 0 },
        ]}
      />,
    );
    expect(screen.getByText('No activity was recorded in this period.')).toBeInTheDocument();
  });

  it('explains an empty series instead of rendering an empty frame', () => {
    render(<BarChart ariaLabel="Submissions per day" data={[]} />);
    expect(screen.getByText('No data recorded for this period yet.')).toBeInTheDocument();
  });

  it('survives a background refetch that returns an empty series', () => {
    const { rerender } = render(<BarChart ariaLabel="Submissions per day" data={[]} />);
    expect(screen.getByText('No data recorded for this period yet.')).toBeInTheDocument();
    // Same component instance, new data: the hook order must not change.
    rerender(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);
    const chart = screen.getByRole('img', { name: 'Submissions per day' });
    expect(chart.querySelectorAll('.chart__column')).toHaveLength(30);
    rerender(<BarChart ariaLabel="Submissions per day" data={[]} />);
    expect(screen.getByText('No data recorded for this period yet.')).toBeInTheDocument();
  });
});

describe('LineChart', () => {
  it('labels the newest result and keeps a full accessible table', () => {
    render(
      <LineChart
        ariaLabel="Score progression"
        data={[
          { label: '09-01', detail: 'Statistics CA (1 September 2026)', value: 42 },
          { label: '09-08', detail: 'Data Structures quiz (8 September 2026)', value: 68 },
          { label: '09-15', detail: 'Probability CA (15 September 2026)', value: 74 },
        ]}
      />,
    );

    const chart = screen.getByRole('img', { name: 'Score progression' });
    expect(chart).toBeInTheDocument();
    const ticks = Array.from(chart.querySelectorAll('text')).map((node) => node.textContent);
    expect(ticks).toContain('09-15');
    // The scale is stated, so bar and point heights have meaning.
    for (const value of ['0', '25', '50', '75', '100']) expect(ticks).toContain(value);
    const table = screen.getByRole('table', { name: 'Score progression' });
    expect(within(table).getByText('Statistics CA (1 September 2026)')).toBeInTheDocument();
    expect(within(table).getByText('74%')).toBeInTheDocument();
  });

  it('refuses to draw a trend from a single point', () => {
    render(<LineChart ariaLabel="Score progression" data={[{ label: '09-01', value: 42 }]} />);
    expect(screen.getByText('Not enough released results to draw a trend yet.')).toBeInTheDocument();
  });
});

describe('chart panels fit the space they are given', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const grades = [
    { label: 'A', value: 4, tone: 'success' },
    { label: 'B', value: 6 },
    { label: 'F', value: 2, tone: 'danger' },
  ];

  it('scales the distribution ring with its column and caps it on a wide card', () => {
    withPanelWidth(300);
    const narrow = render(<DonutChart ariaLabel="Grades" data={grades} />);
    const narrowSize = Number(narrow.container.querySelector('svg')?.getAttribute('width'));
    narrow.unmount();

    withPanelWidth(1200);
    const wide = render(<DonutChart ariaLabel="Grades" data={grades} />);
    const wideSize = Number(wide.container.querySelector('svg')?.getAttribute('width'));

    expect(narrowSize).toBeLessThan(wideSize);
    expect(narrowSize).toBeGreaterThanOrEqual(132);
    // Never larger than the default, however wide the card gets.
    expect(wideSize).toBe(184);
    // The viewBox follows the diameter, so the ring keeps its proportions.
    expect(wide.container.querySelector('svg')?.getAttribute('viewBox')).toBe(`0 0 ${wideSize} ${wideSize}`);
  });

  it('shortens the column plot on a phone-width card', () => {
    withPanelWidth(340);
    const phone = render(<BarChart ariaLabel="Submissions" data={dailySeries(30)} />);
    const phoneHeight = (phone.container.querySelector('.chart__bars') as HTMLElement).style.height;
    phone.unmount();

    withPanelWidth(900);
    const desktop = render(<BarChart ariaLabel="Submissions" data={dailySeries(30)} />);
    const desktopHeight = (desktop.container.querySelector('.chart__bars') as HTMLElement).style.height;

    expect(phoneHeight).toBe('148px');
    expect(desktopHeight).toBe('180px');
  });

  it('keeps a phone-width series labelled rather than dropping the axis', () => {
    withPanelWidth(340);
    render(<BarChart ariaLabel="Submissions per day" unit="submissions" data={dailySeries(30)} />);
    const labels = Array.from(screen.getByRole('img', { name: 'Submissions per day' }).querySelectorAll('.chart__label')).filter(
      (node) => !node.classList.contains('chart__label--hidden'),
    );
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThanOrEqual(7);
    expect(labels[labels.length - 1].textContent).toBe('08-30');
  });
});

describe('distribution rings', () => {
  const grades = [
    { label: 'C', value: 2 },
    { label: 'D', value: 6 },
    { label: 'F', value: 2, tone: 'danger' },
  ];

  it('never draws two slices in the same colour when a tone is left open', () => {
    const tones = distinctTones(grades);
    expect(tones[2].tone).toBe('danger');
    const used = tones.map((point) => point.tone);
    expect(new Set(used).size).toBe(used.length);
    // The failing band keeps the colour the caller pinned.
    expect(used).not.toEqual(['danger', 'danger', 'danger']);
  });

  it('keeps the assigned colours on the arcs and the legend swatches', () => {
    render(<DonutChart ariaLabel="Grade distribution" data={grades} />);
    const figure = screen.getByRole('img', { name: 'Grade distribution' }).closest('figure')!;
    const arcs = Array.from(figure.querySelectorAll('circle')).map((node) => node.getAttribute('class'));
    const swatches = Array.from(figure.querySelectorAll('.chart__swatch')).map((node) => node.getAttribute('class'));

    expect(arcs).toHaveLength(3);
    expect(new Set(arcs).size).toBe(3);
    // Each legend swatch matches its arc, so the key and the ring agree.
    const toneOf = (name: string | null, prefix: string) => name?.match(new RegExp(`${prefix}--(\\w+)`))?.[1];
    expect(swatches.map((name) => toneOf(name, 'chart__swatch'))).toEqual(
      arcs.map((name) => toneOf(name, 'chart__segment')),
    );
  });

  it('draws a solid ring that stays inside its viewBox', () => {
    render(<DonutChart ariaLabel="Grade distribution" data={grades} />);
    const svg = screen.getByRole('img', { name: 'Grade distribution' });
    const diameter = Number(svg.getAttribute('width'));
    const arcs = Array.from(svg.querySelectorAll('circle'));
    const stroke = Number(arcs[0].getAttribute('stroke-width'));
    const radius = Number(arcs[0].getAttribute('r'));

    // Thick enough to read as a band rather than a hairline outline.
    expect(stroke).toBeGreaterThanOrEqual(Math.round(diameter * 0.14));
    expect(radius + stroke / 2).toBeLessThanOrEqual(diameter / 2);
    // The three bands add up to a full circle.
    const circumference = 2 * Math.PI * radius;
    const drawn = arcs.reduce(
      (sum, arc) => sum + Number(String(arc.getAttribute('stroke-dasharray')).split(' ')[0]),
      0,
    );
    expect(drawn).toBeCloseTo(circumference, 4);
  });
});

describe('daily bars', () => {
  it('leaves a zero day empty instead of stubbing the baseline', () => {
    // A run of zero days used to paint a minimum-height bar each, which read as a dashed line.
    render(
      <BarChart
        ariaLabel="Submissions per day"
        data={[
          { label: '09-14', value: 0 },
          { label: '09-15', value: 0 },
          { label: '09-16', value: 19 },
          { label: '09-17', value: 1 },
        ]}
      />,
    );
    const bars = Array.from(screen.getByRole('img', { name: 'Submissions per day' }).querySelectorAll('.chart__bar'));
    const heights = bars.map((bar) => Number.parseFloat((bar as HTMLElement).style.height));
    expect(heights.slice(0, 2)).toEqual([0, 0]);
    // The peak day fills the plot; a day with a single submission stays visible.
    expect(heights[2]).toBeGreaterThan(140);
    expect(heights[3]).toBeGreaterThanOrEqual(3);
    expect(heights[3]).toBeLessThan(20);
  });
});
