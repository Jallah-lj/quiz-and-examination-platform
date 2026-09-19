import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BarChart,
  BarList,
  DonutChart,
  LineChart,
  StackedBarChart,
  TrendChart,
  axisTickIndexes,
  distinctTones,
  niceScale,
} from './charts';

/** Pretend the panel is a given number of CSS pixels wide, as a real layout would. */
/** The date labels of a trend axis, as opposed to its y-axis figures. */
function axisDates(container: HTMLElement): SVGTextElement[] {
  return Array.from(container.querySelectorAll<SVGTextElement>('.chart__axis')).filter((tick) =>
    /^\d\d-\d\d$/.test(tick.textContent ?? ''),
  );
}

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

describe('niceScale', () => {
  it('breaks a count series into whole numbers that clear the peak', () => {
    expect(niceScale(14)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(53)).toEqual({ max: 60, ticks: [0, 20, 40, 60] });
  });

  it('stays sane when nothing has been recorded', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('TrendChart', () => {
  /**
   * The real shape of the institution series: a quiet stretch, then activity with a peak
   * on the second-to-last day.
   */
  const quiet = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 3, 0, 0, 0, 0, 2, 8, 5, 8, 14, 6];
  const series = (values: number[] = quiet) =>
    values.map((value, index) => ({
      label: `09-${String(index + 1).padStart(2, '0')}`,
      detail: `2026-09-${String(index + 1).padStart(2, '0')}`,
      value,
    }));

  const coordinates = (path: string) => {
    const ys = Array.from(path.matchAll(/[-\d.]+,([-\d.]+)/g)).map((match) => Number(match[1]));
    const xs = Array.from(path.matchAll(/([-\d.]+),[-\d.]+/g)).map((match) => Number(match[1]));
    return { ys, xs };
  };

  it('scales the axis in whole numbers and marks the busiest day', () => {
    render(<TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />);
    const svg = screen.getByRole('img', { name: 'Submissions per day' });
    const labels = Array.from(svg.querySelectorAll('text')).map((node) => node.textContent);

    // The scale brackets the peak of 14 without printing fractions of a submission.
    for (const tick of ['0', '5', '10', '15']) expect(labels).toContain(tick);
    // The busy day is marked and labelled; the thinned axis still ends on the newest day.
    expect(labels[labels.length - 1]).toBe('09-30');
    expect(svg.querySelector('.trend__peak')?.textContent).toBe('14');
    expect(svg.querySelectorAll('.trend__point--peak')).toHaveLength(1);
  });

  it('never draws the line below the zero baseline, even beside a spike', () => {
    // A curve through 0 → 9 → 0 without clamping bows underneath the baseline.
    render(<TrendChart ariaLabel="Spiky" data={series([0, 0, 9, 0, 0, 12, 0, 0, 0, 0])} />);
    const svg = screen.getByRole('img', { name: 'Spiky' });
    const zeroTick = Array.from(svg.querySelectorAll('text')).find((node) => node.textContent === '0')!;
    const baseline = Number(zeroTick.getAttribute('y')) - 3.5;

    for (const path of ['chart__line', 'chart__area']) {
      const { ys } = coordinates(svg.querySelector(`.${path}`)!.getAttribute('d')!);
      expect(Math.max(...ys)).toBeLessThanOrEqual(baseline + 0.5);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads out the day under the pointer, with a guide line', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />,
    );
    const svg = screen.getByRole('img', { name: 'Submissions per day' });

    expect(container.querySelector('.trend__tooltip')).toBeNull();
    await user.hover(svg.querySelectorAll('.trend__hit')[28] as Element);
    const tooltip = container.querySelector('.trend__tooltip')!;
    expect(tooltip.textContent).toBe('14 submissions2026-09-29');
    expect(svg.querySelector('.trend__guide')).toBeTruthy();
    expect(svg.querySelectorAll('.trend__point--active')).toHaveLength(1);

    await user.unhover(svg.querySelectorAll('.trend__hit')[28] as Element);
    expect(container.querySelector('.trend__tooltip')).toBeNull();
    expect(svg.querySelector('.trend__guide')).toBeNull();
  });

  it('can be stepped through with the keyboard, and left with Escape', () => {
    const { container } = render(
      <TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />,
    );
    const svg = screen.getByRole('img', { name: 'Submissions per day' });
    // Reachable by keyboard, not only by pointer (jsdom does not focus SVG itself).
    expect(svg.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(svg);
    // Focusing reads the newest day straight away.
    expect(container.querySelector('.trend__tooltip')?.textContent).toBe('6 submissions2026-09-30');

    for (const [key, expected] of [
      ['ArrowLeft', '14 submissions2026-09-29'],
      ['Home', '0 submissions2026-09-01'],
      ['End', '6 submissions2026-09-30'],
    ] as const) {
      fireEvent.keyDown(svg, { key });
      expect(container.querySelector('.trend__tooltip')?.textContent).toBe(expected);
    }
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(container.querySelector('.trend__tooltip')).toBeNull();
  });

  it('keeps the readout inside the panel at both ends of the series', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />,
    );
    const svg = screen.getByRole('img', { name: 'Submissions per day' });
    const hits = svg.querySelectorAll('.trend__hit');
    const left = () => Number.parseFloat((container.querySelector('.trend__tooltip') as HTMLElement).style.left);

    await user.hover(hits[0] as Element);
    expect(left()).toBeGreaterThanOrEqual(64);
    await user.unhover(hits[0] as Element);
    await user.hover(hits[hits.length - 1] as Element);
    // 560px wide, so the newest day's card is pulled back from the right edge.
    expect(left()).toBeLessThanOrEqual(560 - 64);
  });

  it('keeps every day in the accessible table, and marks only the days worth marking', () => {
    render(<TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />);
    const table = screen.getByRole('table', { name: 'Submissions per day' });
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(table).getByText('2026-09-29')).toBeInTheDocument();

    // The busiest day and the newest day, and nothing that would read as a dashed rule.
    const svg = screen.getByRole('img', { name: 'Submissions per day' });
    expect(svg.querySelectorAll('.trend__point')).toHaveLength(2);
    // Each day still has its own target for the pointer.
    expect(svg.querySelectorAll('.trend__hit')).toHaveLength(30);
  });

  it('says so when the period was quiet, and asks for two points to draw a trend', () => {
    const flat = render(<TrendChart ariaLabel="Quiet" data={series([0, 0, 0, 0])} />);
    expect(flat.container.textContent).toBe('No activity was recorded in this period.');
    flat.unmount();

    const single = render(<TrendChart ariaLabel="One day" data={series([3])} />);
    expect(single.container.textContent).toBe('Not enough data points to draw a trend yet.');
  });

  it('summarises the peak and the daily average from the series itself', () => {
    render(<TrendChart ariaLabel="Submissions per day" unit="submissions" data={series()} />);
    expect(
      screen.getByText('Peak 14 submissions on 2026-09-29 · 1.8 submissions a day on average.'),
    ).toBeInTheDocument();
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

describe('distribution legend', () => {
  const withEmpty = [
    { label: 'C', value: 2 },
    { label: 'D', value: 6 },
    { label: 'F', value: 2, tone: 'danger' },
    { label: 'A', value: 0 },
  ];

  it('sizes each row bar from the share it stands for, and leaves an empty band blank', () => {
    const { container } = render(<DonutChart ariaLabel="Grade distribution" data={withEmpty} />);
    const rows = Array.from(container.querySelectorAll('.chart__legend li'));

    expect(rows.map((row) => (row.querySelector('.chart__legend-fill') as HTMLElement).style.width)).toEqual([
      '20%',
      '60%',
      '20%',
      '0%',
    ]);
    // The figures are printed as well, so the bar is never the only carrier.
    expect(rows[1].textContent).toBe('D6 (60%)');
    expect(rows[3].textContent).toBe('A0 (0%)');
    // A blank band draws no bar at all.
    expect((rows[3].querySelector('.chart__legend-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('lights the matching arc while a legend row is under the pointer', async () => {
    const user = userEvent.setup();
    const { container } = render(<DonutChart ariaLabel="Grade distribution" data={withEmpty} />);
    const rows = container.querySelectorAll('.chart__legend li');
    const arcs = () => Array.from(container.querySelectorAll('.chart__segment'));

    expect(arcs().filter((arc) => arc.classList.contains('is-dimmed'))).toHaveLength(0);

    await user.hover(rows[1]);
    expect(rows[1].classList.contains('is-active')).toBe(true);
    const dimmed = arcs().map((arc) => arc.classList.contains('is-dimmed'));
    expect(dimmed).toEqual([true, false, true, true]);

    await user.unhover(rows[1]);
    expect(arcs().filter((arc) => arc.classList.contains('is-dimmed'))).toHaveLength(0);
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

describe('stacked columns', () => {
  const series = [
    { key: 'ok', label: 'Successful', tone: 'success' },
    { key: 'bad', label: 'Failed', tone: 'danger' },
  ];
  const data = [
    { label: '09-15', detail: '2026-09-15', values: [10, 2] },
    { label: '09-16', detail: '2026-09-16', values: [0, 0] },
    { label: '09-17', detail: '2026-09-17', values: [6, 0] },
  ];

  it('stacks each series and draws nothing for a day with no activity', () => {
    render(<StackedBarChart ariaLabel="Sign-ins per day" series={series} data={data} unit="sign-ins" />);
    const chart = screen.getByRole('img', { name: 'Sign-ins per day' });
    const columns = Array.from(chart.querySelectorAll('.chart__column'));

    // Day one holds both series, day two is empty, day three holds only successes.
    expect(columns[0].querySelectorAll('.chart__stack-segment')).toHaveLength(2);
    expect((columns[1].querySelector('.chart__stack') as HTMLElement).style.height).toBe('0px');
    expect(columns[1].querySelectorAll('.chart__stack-segment')).toHaveLength(0);
    expect(columns[2].querySelectorAll('.chart__stack-segment')).toHaveLength(1);
  });

  it('gives every segment exactly one tone modifier, matched by its legend swatch', () => {
    render(<StackedBarChart ariaLabel="Sign-ins per day" series={series} data={data} />);
    const segments = Array.from(document.querySelectorAll('.chart__stack-segment')) as HTMLElement[];
    // One of the palette modifiers, and nothing else: this is what the theme audit reads.
    for (const segment of segments) {
      const modifiers = Array.from(segment.classList).filter((name) => name.startsWith('chart__stack-segment--'));
      expect(modifiers).toHaveLength(1);
      expect(['default', 'accent', 'success', 'warning', 'danger', 'neutral']).toContain(
        modifiers[0].replace('chart__stack-segment--', ''),
      );
    }
    // The stack keeps its order: successes first in the legend, and the same tones in the bars.
    expect(segments[0].classList.contains('chart__stack-segment--success')).toBe(true);
    expect(segments[1].classList.contains('chart__stack-segment--danger')).toBe(true);
    // The legend reuses the shared swatch classes, so it is themed from the same tokens.
    expect(document.querySelectorAll('.chart__swatch--success').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.chart__swatch--danger').length).toBeGreaterThan(0);
  });

  it('states each series in words and in the accessible table', () => {
    render(<StackedBarChart ariaLabel="Sign-ins per day" series={series} data={data} unit="sign-ins" />);
    // The split is never carried by colour alone.
    const legend = document.querySelector('.chart__key') as HTMLElement;
    expect(within(legend).getByText('Successful')).toBeInTheDocument();
    expect(within(legend).getByText('16 sign-ins')).toBeInTheDocument();
    expect(within(legend).getByText('2 sign-ins')).toBeInTheDocument();
    expect(screen.getByText(/16 successful · 2 failed in total\./)).toBeInTheDocument();

    const table = document.querySelector('figcaption.sr-only table') as HTMLElement;
    expect(within(table).getByText('2026-09-15')).toBeInTheDocument();
    // One column per series plus a total.
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Category', 'Successful', 'Failed', 'Total']);
  });

  it('says so plainly when the period recorded nothing', () => {
    render(
      <StackedBarChart
        ariaLabel="Sign-ins per day"
        series={series}
        data={[{ label: '09-17', values: [0, 0] }]}
      />,
    );
    expect(screen.getByText('No activity was recorded in this period.')).toBeInTheDocument();
  });
});

describe('ranked bars', () => {
  const items = [
    { label: 'Northgate Institute of Technology', value: 53, meta: '30 candidates', detail: 'Northgate (NIT)' },
    { label: 'Platform Office', value: 0, meta: '0 candidates', detail: 'Platform Office (PLATFORM)' },
  ];

  it('scales every bar against the largest value and leaves a zero empty', () => {
    render(<BarList ariaLabel="Attempts by institution" unit="attempts" items={items} />);
    const fills = Array.from(document.querySelectorAll('.rank__fill')) as HTMLElement[];
    expect(fills[0].style.width).toBe('100%');
    expect(fills[1].style.width).toBe('0%');
  });

  it('names each bar, its figure and its detail in the accessible table', () => {
    render(<BarList ariaLabel="Attempts by institution" unit="attempts" items={items} />);
    expect(screen.getByText('Northgate Institute of Technology')).toBeInTheDocument();
    expect(screen.getByText('53 attempts')).toBeInTheDocument();
    expect(screen.getByText('30 candidates')).toBeInTheDocument();

    const table = document.querySelector('figcaption.sr-only table') as HTMLElement;
    expect(within(table).getByText('Northgate (NIT)')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + two institutions
  });

  it('explains an empty ranking rather than rendering an empty frame', () => {
    render(<BarList ariaLabel="Attempts by institution" items={[]} emptyLabel="No institution has recorded any attempt yet." />);
    expect(screen.getByText('No institution has recorded any attempt yet.')).toBeInTheDocument();
    expect(document.querySelector('.rank')).toBeNull();
  });
});

describe('charts stay inside the box they are given', () => {
  const grades = [
    { label: 'A', value: 3 },
    { label: 'B', value: 4 },
    { label: 'C', value: 5 },
    { label: 'D', value: 6 },
    { label: 'F', value: 4 },
  ];
  /**
   * Panel widths a card can really be, from a dense two-column card on a small phone up to
   * a wide dashboard column. The narrow end matters: a fixed 140px ring floor only showed
   * itself below 140px, which is exactly why it went unnoticed.
   */
  const WIDTHS = [120, 140, 200, 240, 280, 300, 320, 360, 420, 560, 760, 900, 1200];

  it.each(WIDTHS)('draws the ring no wider than the %ipx it was measured in', (width) => {
    withPanelWidth(width);
    const { container } = render(<DonutChart ariaLabel="Grade distribution" data={grades} />);
    const svg = container.querySelector('svg.chart__donut') as SVGSVGElement;
    const drawn = Number(svg.getAttribute('width'));
    // A fixed floor used to make this wider than the card, so the ring was painted outside it.
    expect(drawn).toBeLessThanOrEqual(width);
    expect(drawn).toBeGreaterThanOrEqual(96);
    // The stroke has to leave a visible hole, or a small ring reads as a filled disc.
    const strokeWidth = Number(svg.querySelector('circle')?.getAttribute('stroke-width'));
    expect(strokeWidth).toBeLessThan(drawn / 2);
  });

  it.each(WIDTHS)('lays every one of thirty days out as its own column in a %ipx panel', (width) => {
    withPanelWidth(width);
    const { container } = render(
      <BarChart
        ariaLabel="Submissions per day"
        data={Array.from({ length: 30 }, (_, index) => ({
          label: `09-${String(index + 1).padStart(2, '0')}`,
          value: index % 7,
        }))}
      />,
    );
    // The columns are the units that shrink; the stylesheet guarantees they may (see
    // styles/layout.test.ts, which reads app.css because jsdom applies no stylesheet).
    expect(container.querySelectorAll('.chart__column')).toHaveLength(30);
    expect(container.querySelectorAll('.chart__bar')).toHaveLength(30);
  });

  it.each(WIDTHS)('fits the stacked and ranked charts into a %ipx panel', (width) => {
    withPanelWidth(width);
    const { container } = render(
      <>
        <StackedBarChart
          ariaLabel="Sign-ins per day"
          series={[
            { key: 'ok', label: 'Successful', tone: 'success' },
            { key: 'bad', label: 'Failed', tone: 'danger' },
          ]}
          data={Array.from({ length: 14 }, (_, index) => ({ label: `09-${index + 1}`, values: [index, index % 3] }))}
        />
        <BarList
          ariaLabel="Attempts by institution"
          items={[
            { label: 'Northgate Institute of Technology', value: 53 },
            { label: 'Muhanga Polytechnic', value: 12 },
          ]}
        />
      </>,
    );
    expect(container.querySelectorAll('.chart__stack')).toHaveLength(14);
    expect(container.querySelectorAll('.rank__fill')).toHaveLength(2);
  });
});

describe('drawn geometry never exceeds the box it was measured in', () => {
  const month = Array.from({ length: 30 }, (_, index) => ({
    label: `09-${String(index + 1).padStart(2, '0')}`,
    value: index % 5,
  }));
  const scores = month.map((point, index) => ({ label: point.label, value: 40 + (index % 7) * 6 }));

  /** Every x the path visits, plus the right edge of every shape that carries a width. */
  const xCoordinates = (container: HTMLElement) => {
    const xs: number[] = [];
    for (const path of Array.from(container.querySelectorAll('path'))) {
      const d = path.getAttribute('d') ?? '';
      for (const match of d.matchAll(/[ML](-?[\d.]+)/g)) xs.push(Number(match[1]));
    }
    for (const node of Array.from(container.querySelectorAll('[x]'))) {
      const x = Number(node.getAttribute('x'));
      if (Number.isFinite(x)) xs.push(x);
    }
    for (const node of Array.from(container.querySelectorAll('[cx]'))) {
      const cx = Number(node.getAttribute('cx'));
      const r = Number(node.getAttribute('r') ?? 0);
      if (Number.isFinite(cx)) xs.push(cx - r, cx + r);
    }
    return xs;
  };

  const SVGS = [
    ['TrendChart', month, (data: typeof month) => <TrendChart ariaLabel="Submissions over time" data={data} />],
    ['LineChart', scores, (data: typeof month) => <LineChart ariaLabel="Score progression" data={data} />],
  ] as const;

  it.each(SVGS)('keeps every point of a %s inside its viewBox at any width', (_name, data, draw) => {
    for (const width of [120, 200, 240, 360, 560, 900, 1200]) {
      withPanelWidth(width);
      const { container, unmount } = render(draw(data as typeof month));
      const svg = container.querySelector('svg') as SVGSVGElement;
      const viewBoxWidth = Number((svg.getAttribute('viewBox') ?? '').split(/\s+/)[2]);
      // A viewBox narrower than the box it was measured in is the same clipping, one step on.
      expect(viewBoxWidth).toBe(width);
      const xs = xCoordinates(container);
      expect(xs.length).toBeGreaterThan(0);
      // SVG clips at the viewBox, so a coordinate past the edge is a point drawn outside the
      // card — exactly the picture the containment guarantee exists to prevent.
      expect(Math.max(...xs), `a point was drawn past the right edge at ${width}px`).toBeLessThanOrEqual(viewBoxWidth);
      unmount();
    }
  });
});

describe('the trend keeps its labels inside the plot', () => {
  /** A month whose busiest day is the last one — the worst case for a centred label. */
  const month = Array.from({ length: 30 }, (_, index) => ({
    label: `09-${String(index + 1).padStart(2, '0')}`,
    value: index === 29 ? 9 : index % 5,
  }));

  it('anchors the first and last axis dates inward so neither hangs past the panel', () => {
    withPanelWidth(560);
    // Seven days: the axis has room to label every one, so both ends of the series are drawn.
    const week = month.slice(0, 7);
    const { container } = render(<TrendChart ariaLabel="Submissions over time" data={week} />);
    const dates = axisDates(container);
    expect(dates).toHaveLength(7);
    // A centred label at either end would be painted half outside the figure.
    expect(dates[0].getAttribute('text-anchor')).toBe('start');
    expect(dates[dates.length - 1].getAttribute('text-anchor')).toBe('end');
    // Everything in between stays under its own point.
    for (const middle of dates.slice(1, -1)) expect(middle.getAttribute('text-anchor')).toBe('middle');
  });

  it('anchors the newest date inward on a month-long axis, where labels are thinned', () => {
    withPanelWidth(560);
    const { container } = render(<TrendChart ariaLabel="Submissions over time" data={month} />);
    const dates = axisDates(container);
    // Thinned ticks start at the newest day and step back, so the last date is the one that
    // would otherwise overhang the right edge of the plot.
    expect(dates[dates.length - 1].getAttribute('text-anchor')).toBe('end');
    for (const date of dates.slice(0, -1)) expect(date.getAttribute('text-anchor')).toBe('middle');
  });

  it('anchors a peak label that sits on the last day to the left of its point', () => {
    withPanelWidth(560);
    const { container } = render(<TrendChart ariaLabel="Submissions over time" data={month} />);
    const peak = container.querySelector<SVGTextElement>('.trend__peak');
    expect(peak?.textContent).toBe('9');
    // Left-anchored: the figure is drawn back towards the plot instead of over the card edge.
    expect(peak?.getAttribute('text-anchor')).toBe('end');
  });

  it('keeps the readout inset from both edges of a narrow panel', async () => {
    const user = userEvent.setup();
    withPanelWidth(240);
    const { container } = render(<TrendChart ariaLabel="Submissions over time" data={month} />);
    const hits = container.querySelectorAll('.trend__hit');
    const left = () => Number.parseFloat((container.querySelector('.trend__tooltip') as HTMLElement).style.left);

    await user.hover(hits[0] as Element);
    // Centred on the point, so the inset must be at least half the readout's own width.
    expect(left()).toBeGreaterThanOrEqual(64);
    await user.unhover(hits[0] as Element);
    await user.hover(hits[hits.length - 1] as Element);
    expect(left()).toBeLessThanOrEqual(240 - 64);
  });
});
