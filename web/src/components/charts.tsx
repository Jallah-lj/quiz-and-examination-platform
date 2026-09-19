/**
 * Small, dependency-free SVG charts.
 *
 * They are deliberately plain: no gradients, no animation, accessible labels and a
 * data table fallback so the information is never conveyed by colour alone.
 *
 * Axis labels are thinned to the space actually available, so a 30-day series never
 * prints thirty overlapping timestamps.
 */
import { useLayoutEffect, useRef, useState } from 'react';

export interface SeriesPoint {
  label: string;
  value: number;
  tone?: string;
  /** Fuller description used in the tooltip and the accessible table (for example an ISO date). */
  detail?: string;
}

/**
 * Tone names map to classes rather than hex values, so every series is painted from the
 * theme tokens and switches cleanly between the light and dark palettes.
 */
const TONES = ['default', 'accent', 'success', 'warning', 'danger', 'neutral'] as const;
type Tone = (typeof TONES)[number];

function toneName(tone?: string): Tone {
  return (TONES as readonly string[]).includes(tone ?? '') ? (tone as Tone) : 'default';
}

/**
 * Indexes that get an axis label: roughly `target` evenly spaced ticks anchored on the
 * newest point, so the series never ends without a date. Short series are labelled in full.
 */
export function axisTickIndexes(count: number, target = 7): number[] {
  if (count <= 0) return [];
  if (count <= target) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil(count / target);
  const ticks: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) ticks.push(index);
  return ticks.reverse();
}

/** Width of the chart container, so SVG shapes are drawn at a uniform scale. */
function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(Math.round(measured));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/**
 * Colours for a categorical series, such as a grade distribution. A caller may pin a tone
 * (a failing band stays red); whatever is left open is handed the next unused colour, so
 * two slices can never be drawn in exactly the same colour — which is what makes an
 * otherwise correct distribution impossible to read.
 */
export function distinctTones(data: SeriesPoint[]): SeriesPoint[] {
  const taken = new Set<Tone>(
    data.map((point) => toneName(point.tone)).filter((tone) => tone !== 'default'),
  );
  return data.map((point) => {
    if (point.tone) return point;
    const next = TONES.find((tone) => !taken.has(tone)) ?? 'default';
    taken.add(next);
    return { ...point, tone: next };
  });
}

/**
 * Whole-number axis for a count series: ticks that clear the peak without printing
 * fractions of a submission ("0 2.5 5 7.5 10" would be nonsense on a daily count).
 */
export function niceScale(peak: number): { max: number; ticks: number[] } {
  const safe = Math.max(1, Math.ceil(peak));
  const step =
    [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((candidate) => safe / candidate <= 4) ??
    Math.ceil(safe / 4);
  const max = Math.ceil(safe / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Catmull-Rom curve through the points, expressed as cubic Béziers.
 *
 * Control points are clamped inside the plot, because a spike beside a zero day would
 * otherwise bow the curve below the baseline — and a chart must never imply that a
 * negative number of submissions was received.
 */
function smoothPath(points: { x: number; y: number }[], top: number, baseline: number): string {
  if (!points.length) return '';
  const clamp = (y: number) => round1(Math.max(top, Math.min(baseline, y)));
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index === 0 ? 0 : index - 1];
    const start = points[index];
    const end = points[index + 1];
    const next = points[index + 2] ?? end;
    const c1x = round1(start.x + (end.x - previous.x) / 6);
    const c1y = clamp(start.y + (end.y - previous.y) / 6);
    const c2x = round1(end.x - (next.x - start.x) / 6);
    const c2y = clamp(end.y - (next.y - start.y) / 6);
    path += ` C${c1x},${c1y} ${c2x},${c2y} ${end.x},${end.y}`;
  }
  return path;
}

/** Peak, spread and daily average, read from the series that is actually drawn. */
function trendSummary(data: SeriesPoint[], unit?: string): string {
  const total = data.reduce((sum, point) => sum + point.value, 0);
  if (total === 0) return 'No activity was recorded in this period.';
  const peak = data.reduce((best, point) => (point.value > best.value ? point : best), data[0]);
  const suffix = unit ? ` ${unit}` : '';
  const average = round1(total / data.length);
  return `Peak ${peak.value}${suffix} on ${peak.detail ?? peak.label} · ${average}${suffix} a day on average.`;
}

function summarise(data: SeriesPoint[], unit?: string): string {
  const total = data.reduce((sum, point) => sum + point.value, 0);
  const peak = data.reduce((best, point) => (point.value > best.value ? point : best), data[0]);
  const suffix = unit ? ` ${unit}` : '';
  if (peak.value === 0) return `No activity was recorded in this period.`;
  return `Peak ${peak.value}${suffix} on ${peak.detail ?? peak.label} · ${total}${suffix} in total.`;
}

/**
 * Daily counts as vertical bars.
 *
 * Inline values are only printed when the columns are wide enough to hold them; on a dense
 * series the figures stay available through the per-column tooltip and the accessible table
 * underneath, rather than being rendered on top of each other.
 */
export function BarChart({
  data,
  height = 180,
  valueSuffix = '',
  ariaLabel,
  unit,
  labelTarget,
  showSummary = true,
}: {
  data: SeriesPoint[];
  height?: number;
  valueSuffix?: string;
  ariaLabel: string;
  unit?: string;
  /** Override the automatic tick count (which follows the measured card width). */
  labelTarget?: number;
  showSummary?: boolean;
}) {
  // Hooks run before the empty-state return so the hook order never changes when a
  // refetch briefly returns an empty series.
  const [container, width] = useMeasuredWidth<HTMLElement>(560);

  if (!data.length) {
    return <p className="chart-empty">No data recorded for this period yet.</p>;
  }

  const max = Math.max(...data.map((point) => point.value), 1);
  // How many labels and numbers the card actually has room for, rather than a fixed guess:
  // a date needs about 56px of column, a count about 26px. A phone card also gets a
  // shorter plot so the panel does not push everything below the fold.
  const capacity = Math.max(3, Math.min(7, Math.floor(width / 56)));
  const inlineValues = width / data.length >= 26;
  const ticks = new Set(axisTickIndexes(data.length, labelTarget ?? capacity));
  const plot = width < 460 ? Math.min(height, 148) : height;
  const plotHeight = plot - (inlineValues ? 34 : 18);

  return (
    <figure className="chart" ref={container}>
      <div className="chart__bars" style={{ height: plot }} role="img" aria-label={ariaLabel}>
        {data.map((point, index) => (
          <div
            key={point.label}
            className="chart__column"
            title={`${point.detail ?? point.label}: ${point.value}${unit ? ` ${unit}` : valueSuffix}`}
          >
            <span className={`chart__value ${inlineValues ? '' : 'chart__value--hidden'}`} aria-hidden={!inlineValues}>
              {point.value}
              {valueSuffix}
            </span>
            <span
              className={`chart__bar chart__bar--${toneName(point.tone)}`}
              style={{
                // A day with no submissions draws nothing: a visible minimum height would
                // turn a run of zero days into a dashed line along the baseline.
                height: point.value === 0 ? 0 : `${Math.max(3, (point.value / max) * plotHeight)}px`,
              }}
            />
            <span className={`chart__label ${ticks.has(index) ? '' : 'chart__label--hidden'}`} aria-hidden={!ticks.has(index)}>
              {ticks.has(index) ? point.label : data[0].label}
            </span>
          </div>
        ))}
      </div>
      {showSummary ? <p className="chart__summary">{summarise(data, unit)}</p> : null}
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.label}>
                <td>{point.detail ?? point.label}</td>
                <td>{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

/**
 * A daily count as a trend line over a soft area fill.
 *
 * The line is drawn with the same zero-is-nothing honesty as the bars: the baseline is
 * the zero line and every point sits at its true height, so a flat run of empty days is
 * a flat line on the baseline rather than a smoothed guess.
 *
 * Any point can be inspected: hover it, or focus the chart and step through the series
 * with the arrow keys. The readout is decoration for sighted users — the per-day figures
 * live in the table underneath, so nothing is reachable only by pointing at it.
 */
export function TrendChart({
  data,
  height = 200,
  ariaLabel,
  unit,
  valueSuffix = '',
  showSummary = true,
}: {
  data: SeriesPoint[];
  height?: number;
  ariaLabel: string;
  unit?: string;
  valueSuffix?: string;
  showSummary?: boolean;
}) {
  // Hooks run before the empty-state return so the hook order never changes mid-refetch.
  const [container, width] = useMeasuredWidth<HTMLElement>(560);
  const [active, setActive] = useState<number | null>(null);

  if (data.length < 2) {
    return <p className="chart-empty">Not enough data points to draw a trend yet.</p>;
  }

  const padding = { top: 22, right: 12, bottom: 26, left: 34 };
  // A phone card gets a shorter plot so the panel does not push the page around.
  const plot = width < 460 ? Math.min(height, 168) : height;
  // Never a floor: a plot wider than the box it was measured in would draw past the card, so
  // the padding is simply taken off whatever width the card actually has.
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = plot - padding.top - padding.bottom;
  const baseline = padding.top + plotHeight;
  const peakValue = Math.max(...data.map((point) => point.value));
  const { max, ticks } = niceScale(peakValue);
  const stepX = plotWidth / (data.length - 1);
  const yFor = (value: number) => round1(padding.top + plotHeight - (Math.max(0, value) / max) * plotHeight);
  const points = data.map((point, index) => ({
    ...point,
    x: round1(padding.left + index * stepX),
    y: yFor(point.value),
  }));
  const line = smoothPath(points, padding.top, baseline);
  const area = `${line} L${points[points.length - 1].x},${baseline} L${points[0].x},${baseline} Z`;
  const peakIndex = points.reduce((best, point, index) => (point.value > points[best].value ? index : best), 0);
  const labelTicks = axisTickIndexes(points.length, Math.max(3, Math.min(7, Math.floor(width / 56))));
  const current = active === null ? null : points[active];
  // The peak figure is only printed when the plot is wide enough for it to sit clear of
  // the line and the axis.
  const showPeakLabel = width >= 420 && peakValue > 0;
  /*
   * Markers are kept for the points that carry meaning — the busiest day, the newest day
   * and whatever the reader is inspecting. Thirty dots along a mostly quiet baseline read
   * as a dashed rule, which is exactly what a run of empty days must not look like.
   */
  const showsDot = (index: number) => index === peakIndex || index === active || index === points.length - 1;
  // Below the dot keeps the figure clear of the top of the plot; above it would sit on
  // the highest gridline.
  const peakLabelY = Math.min(baseline - 3, points[peakIndex].y + 15);
  /*
   * Text centred on a point hangs half its own width past that point, so a label on the first
   * or last day would be painted outside the panel. Edge labels are anchored inward instead,
   * which is also how their axis reads: the leftmost date sits to the right of its point and
   * the rightmost to the left of its.
   */
  const anchorFor = (index: number): 'start' | 'middle' | 'end' =>
    index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
  /*
   * Half the readout's own width — a 6.5rem min-width plus its padding is about 122px, so 61
   * is the least inset that cannot spill; 64 keeps a round number and a little margin. The
   * readout is centred on its point, so that is exactly the inset the clamp needs at each end.
   */
  const TOOLTIP_INSET = 64;

  const step = (direction: -1 | 1) => {
    const last = data.length - 1;
    setActive((from) => {
      if (from === null) return direction === 1 ? 0 : last;
      return Math.max(0, Math.min(last, from + direction));
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'ArrowRight') {
      step(1);
    } else if (event.key === 'ArrowLeft') {
      step(-1);
    } else if (event.key === 'Home') {
      setActive(0);
    } else if (event.key === 'End') {
      setActive(data.length - 1);
    } else if (event.key === 'Escape') {
      setActive(null);
    } else {
      return;
    }
    event.preventDefault();
  };

  if (peakValue === 0) {
    return <p className="chart-empty">No activity was recorded in this period.</p>;
  }

  return (
    <figure className="chart chart--trend" ref={container}>
      <div className="trend" style={{ height: plot }}>
        <svg
          viewBox={`0 0 ${width} ${plot}`}
          className="chart__svg trend__svg"
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((from) => from ?? points.length - 1)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={padding.left}
                y1={yFor(value)}
                x2={width - padding.right}
                y2={yFor(value)}
                className={value === 0 ? 'chart__grid-line chart__grid-line--base' : 'chart__grid-line chart__grid-line--soft'}
              />
              <text x={padding.left - 7} y={yFor(value) + 3.5} textAnchor="end" className="chart__axis">
                {value}
              </text>
            </g>
          ))}
          <path d={area} className="chart__area" />
          <path d={line} className="chart__line chart__line--smooth" />
          {current ? (
            <line x1={current.x} y1={padding.top} x2={current.x} y2={baseline} className="trend__guide" />
          ) : null}
          {points.map((point, index) =>
            showsDot(index) ? (
              <circle
                key={point.label}
                cx={point.x}
                cy={point.y}
                r={index === peakIndex ? 4 : 3}
                className={`trend__point${index === peakIndex ? ' trend__point--peak' : ''}${
                  index === active ? ' trend__point--active' : ''
                }`}
              />
            ) : null,
          )}
          {showPeakLabel ? (
            <text
              x={points[peakIndex].x}
              y={peakLabelY}
              textAnchor={anchorFor(peakIndex)}
              className="trend__peak"
            >
              {points[peakIndex].value}
              {valueSuffix}
            </text>
          ) : null}
          {labelTicks.map((index) => (
            <text
              key={`tick-${points[index].label}`}
              x={points[index].x}
              y={plot - 8}
              textAnchor={anchorFor(index)}
              className="chart__axis"
            >
              {points[index].label}
            </text>
          ))}
          {/* One invisible column per day, so a pointer can land between data points. */}
          <g onMouseLeave={() => setActive(null)}>
            {points.map((point, index) => (
              <rect
                key={`hit-${point.label}`}
                x={round1(point.x - stepX / 2)}
                y={0}
                width={round1(stepX)}
                height={baseline}
                className="trend__hit"
                aria-hidden="true"
                onMouseEnter={() => setActive(index)}
              />
            ))}
          </g>
        </svg>
        {current ? (
          <div
            className="trend__tooltip"
            style={{
              left: `${Math.max(
                TOOLTIP_INSET,
                Math.min(Math.max(TOOLTIP_INSET, width - TOOLTIP_INSET), current.x),
              )}px`,
            }}
            aria-hidden="true"
          >
            <strong>
              {current.value}
              {unit ? ` ${unit}` : valueSuffix}
            </strong>
            <span>{current.detail ?? current.label}</span>
          </div>
        ) : null}
      </div>
      {showSummary ? <p className="chart__summary">{trendSummary(data, unit)}</p> : null}
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.label}>
                <td>{point.detail ?? point.label}</td>
                <td>
                  {point.value}
                  {valueSuffix}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

export function LineChart({
  data,
  height = 190,
  ariaLabel,
  valueSuffix = '%',
}: {
  data: SeriesPoint[];
  height?: number;
  ariaLabel: string;
  valueSuffix?: string;
}) {
  const [container, width] = useMeasuredWidth<HTMLElement>(560);

  if (data.length < 2) {
    return <p className="chart-empty">Not enough released results to draw a trend yet.</p>;
  }

  const padding = { top: 16, right: 14, bottom: 28, left: 38 };
  // Never a floor, for the same reason as the trend: the plot is only ever as wide as the
  // space the card leaves between its own padding.
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = height - padding.top - padding.bottom;
  // Scores run from zero, so the height of a point always means the same thing.
  const scale = (value: number) => height - padding.bottom - (Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const stepX = plotWidth / (data.length - 1);
  const points = data.map((point, index) => ({
    ...point,
    x: padding.left + index * stepX,
    y: scale(point.value),
  }));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
  const area = `${path} L${points[points.length - 1].x},${height - padding.bottom} L${points[0].x},${height - padding.bottom} Z`;
  const gridValues = [100, 75, 50, 25, 0];
  const ticks = axisTickIndexes(points.length, 6).map((index) => points[index]);

  return (
    <figure className="chart" ref={container}>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart__svg" role="img" aria-label={ariaLabel}>
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={padding.left}
              y1={scale(value)}
              x2={width - padding.right}
              y2={scale(value)}
              className={value === 0 ? 'chart__grid-line--base' : 'chart__grid-line'}
            />
            <text x={padding.left - 8} y={scale(value) + 4} textAnchor="end" className="chart__axis">
              {value}
            </text>
          </g>
        ))}
        <path d={area} className="chart__area" />
        <path d={path} className="chart__line" />
        {points.map((point) => (
          <circle key={point.label} cx={point.x} cy={point.y} r={3.5} className="chart__dot">
            <title>{`${point.detail ?? point.label}: ${point.value}${valueSuffix}`}</title>
          </circle>
        ))}
        {ticks.map((point) => (
          <text key={`tick-${point.label}`} x={point.x} y={height - 8} textAnchor="middle" className="chart__axis">
            {point.label}
          </text>
        ))}
      </svg>
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <tbody>
            {data.map((point) => (
              <tr key={point.label}>
                <td>{point.detail ?? point.label}</td>
                <td>
                  {point.value}
                  {valueSuffix}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

export function DonutChart({
  data,
  ariaLabel,
  size = 184,
}: {
  data: SeriesPoint[];
  ariaLabel: string;
  size?: number;
}) {
  // Measured before the empty-state return so the hook order never changes.
  const [container, width] = useMeasuredWidth<HTMLElement>(520);
  // Which band the pointer is over: the matching arc stays lit while the rest recede,
  // so a legend row and its slice are obviously the same thing.
  const [highlight, setHighlight] = useState<number | null>(null);
  const total = data.reduce((sum, point) => sum + point.value, 0);
  if (!total) return <p className="chart-empty">No data recorded yet.</p>;

  /*
   * The ring is drawn at a pixel size, so it must never be asked to be wider than the space
   * it was measured in — a fixed 140px floor used to overflow a narrow card. It takes just
   * under half the width so the legend has room beside it, is capped by `size` on a wide
   * card, and is allowed to fall to 96px before it would rather be small than spilling.
   */
  const segments = distinctTones(data);
  const diameter = Math.max(
    96,
    Math.min(size, Math.round(width * 0.46), Math.max(96, Math.floor(width) - 16)),
  );
  // A ring thick enough to read as a solid band, inset so it never touches the viewBox,
  // and never so thick that a small ring closes into a disc.
  const thickness = Math.max(12, Math.min(Math.round(diameter * 0.15), Math.round(diameter * 0.22)));
  const radius = diameter / 2 - thickness / 2 - 1;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <figure className="chart chart--donut" ref={container}>
      <svg
        className="chart__donut"
        width={diameter}
        height={diameter}
        viewBox={`0 0 ${diameter} ${diameter}`}
        role="img"
        aria-label={ariaLabel}
      >
        <g transform={`rotate(-90 ${diameter / 2} ${diameter / 2})`}>
          {segments.map((point, index) => {
            const fraction = point.value / total;
            const dash = fraction * circumference;
            const circle = (
              <circle
                key={point.label}
                className={`chart__segment chart__segment--${toneName(point.tone)}${
                  highlight !== null && highlight !== index ? ' is-dimmed' : ''
                }`}
                cx={diameter / 2}
                cy={diameter / 2}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return circle;
          })}
        </g>
        <text x="50%" y="47%" textAnchor="middle" className="chart__donut-value">
          {total}
        </text>
        <text x="50%" y="59%" textAnchor="middle" className="chart__axis">
          {total === 1 ? 'result' : 'results'}
        </text>
      </svg>
      <ul className="chart__legend">
        {segments.map((point, index) => {
          const tone = toneName(point.tone);
          const share = Math.round((point.value / total) * 100);
          return (
            <li
              key={point.label}
              className={highlight === index ? 'is-active' : ''}
              onMouseEnter={() => setHighlight(index)}
              onMouseLeave={() => setHighlight(null)}
            >
              <span className={`chart__swatch chart__swatch--${tone}`} aria-hidden="true" />
              <span className="chart__legend-label">{point.label}</span>
              {/* The share as a bar, so the sizes are comparable at a glance rather than
                  only through the figures. A zero band draws no bar at all. */}
              <span className="chart__legend-bar" aria-hidden="true">
                <span
                  className={`chart__legend-fill chart__legend-fill--${tone}`}
                  style={{ width: point.value === 0 ? '0%' : `${Math.max(4, share)}%` }}
                />
              </span>
              <span className="chart__legend-value">
                {point.value} ({share}%)
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/* ------------------------------------------------------------- stacked columns */

export interface StackedPoint {
  label: string;
  /** Fuller description used in the tooltip and the accessible table (for example an ISO date). */
  detail?: string;
  /** One figure per series, in the order the legend lists them. */
  values: number[];
}

/**
 * Several series stacked into one column per category.
 *
 * Used where the composition matters as much as the total — successful against failed
 * sign-ins on a day. Every column is scaled against the busiest total, each series keeps
 * its own token colour, and the legend states each series' figure in words so the split is
 * never carried by colour alone. A series with nothing in it draws no segment at all.
 */
export function StackedBarChart({
  data,
  series,
  height = 200,
  ariaLabel,
  unit,
  showSummary = true,
}: {
  data: StackedPoint[];
  series: { key: string; label: string; tone?: string }[];
  height?: number;
  ariaLabel: string;
  unit?: string;
  showSummary?: boolean;
}) {
  // Hooks run before the empty-state return so the hook order never changes mid-refetch.
  const [container, width] = useMeasuredWidth<HTMLElement>(560);

  if (!data.length || !series.length) {
    return <p className="chart-empty">No data recorded for this period yet.</p>;
  }

  const totals = data.map((point) => point.values.reduce((sum, value) => sum + value, 0));
  const peak = Math.max(...totals, 1);
  const inlineTotals = width / data.length >= 30;
  const capacity = Math.max(3, Math.min(7, Math.floor(width / 56)));
  const ticks = new Set(axisTickIndexes(data.length, capacity));
  const plot = width < 460 ? Math.min(height, 148) : height;
  const plotHeight = plot - (inlineTotals ? 34 : 18);
  const tones = series.map((item) => toneName(item.tone));
  const seriesTotals = series.map((_, index) =>
    data.reduce((sum, point) => sum + (point.values[index] ?? 0), 0),
  );
  const grandTotal = seriesTotals.reduce((sum, value) => sum + value, 0);

  return (
    <figure className="chart" ref={container}>
      <div className="chart__bars" style={{ height: plot }} role="img" aria-label={ariaLabel}>
        {data.map((point, index) => {
          const total = totals[index];
          return (
            <div
              key={point.label}
              className="chart__column"
              title={`${point.detail ?? point.label}: ${series
                .map((item, seriesIndex) => `${point.values[seriesIndex] ?? 0} ${item.label.toLowerCase()}`)
                .join(', ')}`}
            >
              <span className={`chart__value ${inlineTotals ? '' : 'chart__value--hidden'}`} aria-hidden={!inlineTotals}>
                {total}
              </span>
              {/* A day with nothing in it draws no column: a visible minimum would read as
                  a small amount of activity rather than none. */}
              <span
                className="chart__stack"
                style={{ height: total === 0 ? 0 : `${Math.max(3, (total / peak) * plotHeight)}px` }}
              >
                {series.map((item, seriesIndex) => {
                  const value = point.values[seriesIndex] ?? 0;
                  if (value === 0) return null;
                  return (
                    <span
                      key={item.key}
                      className={`chart__stack-segment chart__stack-segment--${tones[seriesIndex]}`}
                      style={{ flexGrow: value, flexBasis: 0 }}
                    />
                  );
                })}
              </span>
              <span className={`chart__label ${ticks.has(index) ? '' : 'chart__label--hidden'}`} aria-hidden={!ticks.has(index)}>
                {ticks.has(index) ? point.label : data[0].label}
              </span>
            </div>
          );
        })}
      </div>
      <ul className="chart__key">
        {series.map((item, index) => (
          <li key={item.key}>
            <span className={`chart__swatch chart__swatch--${tones[index]}`} aria-hidden="true" />
            <span className="chart__key-label">{item.label}</span>
            <span className="chart__key-value">
              {seriesTotals[index]}
              {unit ? ` ${unit}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {showSummary ? (
        <p className="chart__summary">
          {grandTotal === 0
            ? 'No activity was recorded in this period.'
            : `${series.map((item, index) => `${seriesTotals[index]} ${item.label.toLowerCase()}`).join(' · ')} in total.`}
        </p>
      ) : null}
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              {series.map((item) => (
                <th key={item.key} scope="col">
                  {item.label}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point, index) => (
              <tr key={point.label}>
                <td>{point.detail ?? point.label}</td>
                {series.map((item, seriesIndex) => (
                  <td key={item.key}>{point.values[seriesIndex] ?? 0}</td>
                ))}
                <td>{totals[index]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------- ranked bars */

export interface RankedItem {
  label: string;
  value: number;
  /** Secondary line under the label, such as a cohort size. */
  meta?: string;
  detail?: string;
}

/**
 * A ranking as horizontal bars.
 *
 * Reads far better than a column chart for named things with long labels — institutions,
 * classes, subjects — because the label sits beside its own bar instead of on a rotated
 * axis. Every bar is scaled against the largest value in the list.
 */
export function BarList({
  items,
  ariaLabel,
  unit,
  emptyLabel = 'Nothing recorded yet.',
  tone = 'accent',
}: {
  items: RankedItem[];
  ariaLabel: string;
  unit?: string;
  emptyLabel?: string;
  tone?: string;
}) {
  if (!items.length) return <p className="chart-empty">{emptyLabel}</p>;
  const peak = Math.max(...items.map((item) => item.value), 1);
  const toneClass = toneName(tone);

  return (
    <figure className="chart chart--rank">
      <ul className="rank">
        {items.map((item) => {
          const share = Math.round((item.value / peak) * 100);
          return (
            <li key={item.label} className="rank__row">
              <span className="rank__head">
                <span className="rank__label">{item.label}</span>
                <span className="rank__value">
                  {item.value}
                  {unit ? ` ${unit}` : ''}
                </span>
              </span>
              {item.meta ? <span className="rank__meta">{item.meta}</span> : null}
              <span className="rank__track" aria-hidden="true">
                {/* A zero draws no fill, so an empty institution is visibly empty. */}
                <span
                  className={`rank__fill rank__fill--${toneClass}`}
                  style={{ width: item.value === 0 ? '0%' : `${Math.max(3, share)}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.label}>
                <td>{item.detail ?? item.label}</td>
                <td>{item.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
