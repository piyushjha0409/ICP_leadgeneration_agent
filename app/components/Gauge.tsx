/**
 * Barometer-style score scale: 0–100 with a tick every 10, a major tick and
 * a figure at 0 / 50 / 100, and an amber needle at the reading. The score
 * itself sits beside it in the display face; this shows *where* it falls.
 */
const W = 180;
const H = 32;
const PAD = 4;
const TRACK_Y = 15;

export function Gauge({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const x = PAD + ((W - PAD * 2) * pct) / 100;

  return (
    <svg
      className="gauge-svg"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      focusable="false"
    >
      <line className="gauge-track" x1={PAD} y1={TRACK_Y} x2={W - PAD} y2={TRACK_Y} />
      <line className="gauge-fill" x1={PAD} y1={TRACK_Y} x2={x} y2={TRACK_Y} />
      {Array.from({ length: 11 }, (_, index) => {
        const tx = PAD + ((W - PAD * 2) * index) / 10;
        const major = index % 5 === 0;
        return (
          <line
            key={index}
            className={major ? "gauge-tick major" : "gauge-tick"}
            x1={tx}
            y1={TRACK_Y}
            x2={tx}
            y2={TRACK_Y + (major ? 7 : 4)}
          />
        );
      })}
      {[0, 50, 100].map((value) => {
        const tx = PAD + ((W - PAD * 2) * value) / 100;
        const anchor = value === 0 ? "start" : value === 100 ? "end" : "middle";
        return (
          <text key={value} className="gauge-label" x={tx} y={H - 1} textAnchor={anchor}>
            {value}
          </text>
        );
      })}
      <path className="gauge-needle" d={`M${x} ${TRACK_Y - 2} l-4.5 -8 h9 z`} />
    </svg>
  );
}
