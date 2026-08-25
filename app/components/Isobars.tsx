/**
 * A synoptic-chart pressure field — the one decorative element in the app,
 * and the one that belongs to Rainmaker's own world: a low forming is the
 * "why now" the agent hunts for. Contours are generated deterministically
 * (no randomness), so server and client render the same paths.
 */
const POINTS = 96;

function contour(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  scale: number,
  phase: number,
): string {
  let d = "";
  for (let i = 0; i <= POINTS; i += 1) {
    const t = (i / POINTS) * Math.PI * 2;
    const wobble =
      1 +
      0.07 * Math.sin(3 * t + phase) +
      0.045 * Math.sin(5 * t + 2.1 * phase) +
      0.03 * Math.sin(2 * t - phase);
    const x = cx + Math.cos(t) * rx * scale * wobble;
    const y = cy + Math.sin(t) * ry * scale * wobble;
    d += `${i === 0 ? "M" : " L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d} Z`;
}

const LOW = { cx: 640, cy: 95, rx: 340, ry: 215, rings: 7, phase: 0.9 };
const HIGH = { cx: 1130, cy: 600, rx: 270, ry: 160, rings: 4, phase: 2.4 };

function rings(system: typeof LOW, offset: number) {
  return Array.from({ length: system.rings }, (_, index) => {
    const scale = (index + 1) / system.rings;
    return (
      <path
        key={index}
        d={contour(system.cx, system.cy, system.rx, system.ry, scale, system.phase + index * 0.35)}
        pathLength={1}
        style={{ animationDelay: `${(offset + index) * 90}ms` }}
      />
    );
  });
}

export function Isobars() {
  return (
    <svg
      className="iso"
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g className="iso-drift">
        {rings(LOW, 0)}
        {rings(HIGH, 3)}
        <text className="iso-mark low" x={LOW.cx} y={LOW.cy + 5}>
          L
        </text>
        <text className="iso-mark" x={HIGH.cx} y={HIGH.cy + 5}>
          H
        </text>
      </g>
    </svg>
  );
}
