import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { PositionStatus } from '@human-pixel/core';

export function Screen({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <main className={`hp-safe mx-auto flex min-h-full w-full max-w-md flex-col ${className}`}>{children}</main>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; busy?: boolean };

export function Button({ variant = 'primary', busy, className = '', children, disabled, ...rest }: ButtonProps) {
  const base = 'relative inline-flex h-14 w-full items-center justify-center rounded-2xl px-6 text-base font-semibold tracking-wide transition active:scale-[0.98] disabled:opacity-40';
  const styles = {
    primary: 'bg-pixel text-on-pixel hp-glow',
    ghost: 'border border-line bg-transparent text-text',
    danger: 'border border-bad/50 bg-transparent text-bad',
  }[variant];
  return (
    <button className={`${base} ${styles} ${className}`} disabled={disabled || busy} {...rest}>
      {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-label="Loading" /> : children}
    </button>
  );
}

/** The HUMAN PIXEL mark: a grid of dark pixels with one lit. */
export function PixelMark({ size = 56, lit = 12 }: { size?: number; lit?: number }) {
  const cells = Array.from({ length: 25 }, (_, i) => i);
  const gap = size / 22;
  const cell = (size - gap * 4) / 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {cells.map((i) => {
        const x = (i % 5) * (cell + gap);
        const y = Math.floor(i / 5) * (cell + gap);
        const on = i === lit;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={cell}
            height={cell}
            rx={cell * 0.18}
            fill={on ? 'var(--hp-pixel)' : 'var(--hp-line)'}
            className={on ? 'hp-breathe' : undefined}
            style={on ? { filter: 'drop-shadow(0 0 6px var(--hp-pixel))', transformOrigin: `${x + cell / 2}px ${y + cell / 2}px` } : undefined}
          />
        );
      })}
    </svg>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">{children}</p>;
}

const STATUS: Record<PositionStatus, { dot: string; label: string; color: string }> = {
  IN_POSITION: { dot: 'bg-ok', label: 'Position OK', color: 'text-ok' },
  MOVE_CLOSER: { dot: 'bg-warn', label: 'Move closer', color: 'text-warn' },
  GPS_LOW: { dot: 'bg-bad', label: 'GPS accuracy too low', color: 'text-bad' },
  NO_FIX: { dot: 'bg-bad', label: 'Searching for GPS', color: 'text-bad' },
};

export function StatusPill({ status, detail }: { status: PositionStatus; detail?: string }) {
  const s = STATUS[status];
  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-2.5 rounded-full border border-line bg-surface px-4 py-2">
      <span className={`h-2.5 w-2.5 rounded-full ${s.dot} ${status === 'IN_POSITION' ? 'hp-breathe' : ''}`} />
      <span className={`text-sm font-semibold uppercase tracking-wider ${s.color}`}>{s.label}</span>
      {detail && <span className="text-sm text-muted">{detail}</span>}
    </div>
  );
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  const t = { info: 'border-line text-muted', warn: 'border-warn/40 text-warn', bad: 'border-bad/40 text-bad' }[tone];
  return <div className={`rounded-xl border bg-surface px-4 py-3 text-sm ${t}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-muted">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'h-14 w-full rounded-2xl border border-line bg-surface px-4 text-lg text-text placeholder:text-muted/60 focus:border-pixel focus:outline-none';
