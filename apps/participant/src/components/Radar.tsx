/**
 * Offline navigation radar: no map tiles, no network. You are the centre; your pixel is the lit
 * square. With a compass the view rotates heading-up; without one it is north-up.
 */
import { compassPoint } from '@human-pixel/core';

const NICE = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

export interface RadarProps {
  distance: number;
  bearing: number;
  heading: number | null;
  accuracy: number;
  radius: number;
  inPosition: boolean;
  size?: number;
}

export function Radar({ distance, bearing, heading, accuracy, radius, inPosition, size = 300 }: RadarProps) {
  const valid = Number.isFinite(distance) && Number.isFinite(bearing);
  const range = NICE.find((r) => r >= Math.max((valid ? distance : 0) * 1.25, radius * 3)) ?? 10_000;
  const R = size / 2 - 14;
  const c = size / 2;
  const scale = R / range;
  const rotation = heading != null ? -heading : 0;
  const angle = ((bearing + rotation) * Math.PI) / 180;
  const d = Math.min(valid ? distance : 0, range) * scale;
  const tx = c + Math.sin(angle) * d;
  const ty = c - Math.cos(angle) * d;
  const color = inPosition ? 'var(--hp-ok)' : 'var(--hp-pixel)';
  const pix = Math.max(8, Math.min(18, radius * scale * 0.9));

  return (
    <figure className="relative mx-auto" style={{ width: size, height: size }} aria-label={valid ? `Your pixel is ${Math.round(distance)} metres ${compassPoint(bearing)}` : 'Waiting for GPS'}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <defs>
          <radialGradient id="hp-radar-bg">
            <stop offset="0%" stopColor="var(--hp-surface-2)" />
            <stop offset="100%" stopColor="var(--hp-bg)" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={R} fill="url(#hp-radar-bg)" stroke="var(--hp-line)" />
        {[0.25, 0.5, 0.75].map((f) => (
          <circle key={f} cx={c} cy={c} r={R * f} fill="none" stroke="var(--hp-line)" strokeDasharray="2 6" />
        ))}
        <text x={c + 4} y={c - R + 14} fontSize="10" fill="var(--hp-muted)" fontFamily="var(--font-mono)">{range} m</text>
        {/* North marker (rotates with heading) */}
        <g transform={`rotate(${rotation} ${c} ${c})`}>
          <text x={c} y={c - R - 2} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--hp-muted)">N</text>
        </g>
        {/* GPS uncertainty around you */}
        {Number.isFinite(accuracy) && <circle cx={c} cy={c} r={Math.min(R, accuracy * scale)} fill="var(--hp-pixel-2)" opacity="0.08" />}
        {valid && (
          <>
            <line x1={c} y1={c} x2={tx} y2={ty} stroke={color} strokeWidth="2" strokeDasharray="1 7" strokeLinecap="round" />
            {/* Tolerance zone and your pixel */}
            <circle cx={tx} cy={ty} r={Math.max(pix, radius * scale)} fill={color} opacity="0.12" />
            <rect x={tx - pix / 2} y={ty - pix / 2} width={pix} height={pix} rx={pix * 0.2} fill={color} className="hp-breathe" style={{ transformOrigin: `${tx}px ${ty}px`, filter: `drop-shadow(0 0 8px ${color})` }} />
          </>
        )}
        {/* You */}
        <g transform={`translate(${c} ${c})`}>
          {heading != null ? (
            <path d="M0 -13 L8 9 L0 4 L-8 9 Z" fill="var(--hp-text)" />
          ) : (
            <circle r="6" fill="var(--hp-text)" />
          )}
        </g>
      </svg>
    </figure>
  );
}

/** Big direction arrow, relative to where the phone points (or to north without a compass). */
export function DirectionArrow({ bearing, heading, size = 88 }: { bearing: number; heading: number | null; size?: number }) {
  if (!Number.isFinite(bearing)) return null;
  const rot = heading != null ? bearing - heading : bearing;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ transform: `rotate(${rot}deg)`, transition: 'transform 180ms linear' }}>
      <path d="M50 6 L84 80 L50 62 L16 80 Z" fill="var(--hp-pixel)" style={{ filter: 'drop-shadow(0 0 10px var(--hp-pixel))' }} />
    </svg>
  );
}
