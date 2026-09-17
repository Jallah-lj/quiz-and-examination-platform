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

const TONES: Record<string, string> = {
  default: '#2f5d8a',
  accent: '#0f766e',
  success: '#1f7a4d',
  warning: '#a16207',
  danger: '#b42318',
  neutral: '#5b6b7c',
};

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
  // a date needs about 56px of column, a count about 26px.
  const capacity = Math.max(3, Math.min(7, Math.floor(width / 56)));
  const inlineValues = width / data.length >= 26;
  const ticks = new Set(axisTickIndexes(data.length, labelTarget ?? capacity));
  const plotHeight = height - (inlineValues ? 34 : 18);

  return (
    <figure className="chart" ref={container}>
      <div className="chart__bars" style={{ height }} role="img" aria-label={ariaLabel}>
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
              className="chart__bar"
              style={{
                height: `${Math.max(2, (point.value / max) * plotHeight)}px`,
                background: TONES[point.tone ?? 'default'] ?? TONES.default,
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
  const plotWidth = Math.max(120, width - padding.left - padding.right);
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
              stroke={value === 0 ? '#c6d2dd' : '#e7edf3'}
            />
            <text x={padding.left - 8} y={scale(value) + 4} textAnchor="end" className="chart__axis">
              {value}
            </text>
          </g>
        ))}
        <path d={area} fill="rgba(47, 93, 138, 0.10)" stroke="none" />
        <path d={path} fill="none" stroke="#2f5d8a" strokeWidth={2} />
        {points.map((point) => (
          <circle key={point.label} cx={point.x} cy={point.y} r={3.5} fill="#2f5d8a">
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
  size = 168,
}: {
  data: SeriesPoint[];
  ariaLabel: string;
  size?: number;
}) {
  const total = data.reduce((sum, point) => sum + point.value, 0);
  if (!total) return <p className="chart-empty">No data recorded yet.</p>;

  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <figure className="chart chart--donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {data.map((point) => {
            const fraction = point.value / total;
            const dash = fraction * circumference;
            const circle = (
              <circle
                key={point.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={TONES[point.tone ?? 'default'] ?? TONES.default}
                strokeWidth={16}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return circle;
          })}
        </g>
        <text x="50%" y="48%" textAnchor="middle" className="chart__donut-value">
          {total}
        </text>
        <text x="50%" y="60%" textAnchor="middle" className="chart__axis">
          total
        </text>
      </svg>
      <ul className="chart__legend">
        {data.map((point) => (
          <li key={point.label}>
            <span
              className="chart__swatch"
              style={{ background: TONES[point.tone ?? 'default'] ?? TONES.default }}
              aria-hidden="true"
            />
            <span className="chart__legend-label">{point.label}</span>
            <span className="chart__legend-value">
              {point.value} ({Math.round((point.value / total) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
