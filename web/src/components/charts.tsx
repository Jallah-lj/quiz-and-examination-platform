/**
 * Small, dependency-free SVG charts.
 *
 * They are deliberately plain: no gradients, no animation, accessible labels and a
 * data table fallback so the information is never conveyed by colour alone.
 */

export interface SeriesPoint {
  label: string;
  value: number;
  tone?: string;
}

const TONES: Record<string, string> = {
  default: '#2f5d8a',
  accent: '#0f766e',
  success: '#1f7a4d',
  warning: '#a16207',
  danger: '#b42318',
  neutral: '#5b6b7c',
};

export function BarChart({
  data,
  height = 180,
  valueSuffix = '',
  ariaLabel,
}: {
  data: SeriesPoint[];
  height?: number;
  valueSuffix?: string;
  ariaLabel: string;
}) {
  if (!data.length) {
    return <p className="chart-empty">No data recorded for this period yet.</p>;
  }
  const max = Math.max(...data.map((point) => point.value), 1);
  return (
    <figure className="chart">
      <div className="chart__bars" style={{ height }} role="img" aria-label={ariaLabel}>
        {data.map((point) => (
          <div key={point.label} className="chart__column">
            <span className="chart__value">
              {point.value}
              {valueSuffix}
            </span>
            <span
              className="chart__bar"
              style={{
                height: `${Math.max(2, (point.value / max) * (height - 34))}px`,
                background: TONES[point.tone ?? 'default'] ?? TONES.default,
              }}
            />
            <span className="chart__label">{point.label}</span>
          </div>
        ))}
      </div>
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
                <td>{point.label}</td>
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
  height = 170,
  ariaLabel,
}: {
  data: SeriesPoint[];
  height?: number;
  ariaLabel: string;
}) {
  if (data.length < 2) {
    return <p className="chart-empty">Not enough data points to draw a trend yet.</p>;
  }
  const width = 520;
  const padding = { top: 14, right: 12, bottom: 26, left: 30 };
  const max = Math.max(...data.map((point) => point.value), 1);
  const stepX = (width - padding.left - padding.right) / (data.length - 1);
  const points = data.map((point, index) => ({
    x: padding.left + index * stepX,
    y: height - padding.bottom - (point.value / max) * (height - padding.top - padding.bottom),
    ...point,
  }));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="chart__svg"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="#d7dee6" />
        <path d={path} fill="none" stroke="#2f5d8a" strokeWidth={2} />
        {points.map((point) => (
          <g key={point.label}>
            <circle cx={point.x} cy={point.y} r={3} fill="#2f5d8a" />
            <title>{`${point.label}: ${point.value}`}</title>
          </g>
        ))}
        {points.map((point, index) =>
          index % Math.ceil(points.length / 6) === 0 ? (
            <text key={`label-${point.label}`} x={point.x} y={height - 8} textAnchor="middle" className="chart__axis">
              {point.label}
            </text>
          ) : null,
        )}
        <text x={padding.left - 6} y={padding.top + 4} textAnchor="end" className="chart__axis">
          {max}
        </text>
        <text x={padding.left - 6} y={height - padding.bottom} textAnchor="end" className="chart__axis">
          0
        </text>
      </svg>
      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <tbody>
            {data.map((point) => (
              <tr key={point.label}>
                <td>{point.label}</td>
                <td>{point.value}</td>
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
