import { useEffect, useState, type ReactNode, type TdHTMLAttributes } from 'react';
import { Alert, Button } from '../../components/ui';

/** Admin query keys all live under ['admin', ...] so a single invalidate can refresh the section. */
export const adminKeys = {
  all: ['admin'] as const,
  health: ['admin', 'health'] as const,
  users: (search: string, page: number) => ['admin', 'users', search, page] as const,
  usersAll: ['admin', 'users'] as const,
  orgs: (search: string) => ['admin', 'orgs', search] as const,
  orgsAll: ['admin', 'orgs'] as const,
  events: (state: string) => ['admin', 'events', state] as const,
  audit: (prefix: string) => ['admin', 'audit', prefix] as const,
  reports: (status: string) => ['admin', 'reports', status] as const,
  reportsAll: ['admin', 'reports'] as const,
  settings: ['admin', 'settings'] as const,
};

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString();
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const b = Number(bytes);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  if (b >= 1024) return `${(b / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB`;
  return `${b.toLocaleString()} B`;
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unexpected error';
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="hp-display text-xl">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{children}</span>;
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert tone="bad">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{errMessage(error)}</span>
        {onRetry && (
          <Button size="sm" variant="danger" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </Alert>
  );
}

export function Td({ className = '', ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={`px-4 py-2.5 align-middle ${className}`} />;
}

/** Monospace id shortener for compact tables; full value in the title tooltip. */
export function ShortId({ id }: { id: string | null | undefined }) {
  if (!id) return <span className="text-muted">—</span>;
  return (
    <span className="hp-digits text-xs text-muted" title={id}>
      {id.length > 10 ? `${id.slice(0, 8)}…` : id}
    </span>
  );
}
