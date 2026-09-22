import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { rpc } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import { Badge, Button, Card, Empty, Spinner, Stat, Table } from '../../components/ui';
import { PageHeader, QueryError, Td, adminKeys, fmtBytes, fmtNum } from './shared';

interface TableSize {
  table: string;
  bytes: number;
  rows: number;
}

interface CronJob {
  jobname: string;
  last_run: string | null;
  failures_24h: number;
}

export interface SystemHealth {
  at: string;
  db_size_bytes: number;
  connections: Record<string, number>;
  max_connections: number;
  active_events: number;
  live_events: number;
  participants_total: number;
  reports_last_minute: number;
  open_abuse_reports: number;
  largest_tables: TableSize[] | null;
  cron: CronJob[] | null;
  cache_hit_ratio: number | null;
}

type PlatformStatus = { level: 'CRITICAL' | 'HIGH LOAD' | 'NORMAL'; tone: 'bad' | 'warn' | 'ok'; reasons: string[] };

const CONNECTIONS_CRITICAL = 0.8;
const REPORTS_HIGH_LOAD = 20000;

function totalConnections(h: SystemHealth): number {
  return Object.values(h.connections ?? {}).reduce((a, n) => a + Number(n), 0);
}

export function platformStatus(h: SystemHealth): PlatformStatus {
  const reasons: string[] = [];
  const failures = (h.cron ?? []).reduce((a, j) => a + Number(j.failures_24h), 0);
  const conn = totalConnections(h);
  const ratio = h.max_connections > 0 ? conn / h.max_connections : 0;
  if (failures > 0) reasons.push(`${fmtNum(failures)} cron failure${failures === 1 ? '' : 's'} in 24h`);
  if (ratio > CONNECTIONS_CRITICAL) reasons.push(`connections at ${Math.round(ratio * 100)}% of max`);
  if (reasons.length) return { level: 'CRITICAL', tone: 'bad', reasons };
  if (h.reports_last_minute > REPORTS_HIGH_LOAD) {
    return { level: 'HIGH LOAD', tone: 'warn', reasons: [`${fmtNum(h.reports_last_minute)} position reports in the last minute`] };
  }
  return { level: 'NORMAL', tone: 'ok', reasons: [] };
}

export function HealthPage() {
  const q = useQuery({
    queryKey: adminKeys.health,
    queryFn: () => rpc<SystemHealth>('admin_system_health'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  if (q.isPending) return <Spinner label="Loading system health" />;
  // A failed background refetch keeps the last snapshot on screen with an inline error.
  if (q.data === undefined) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;

  const h = q.data;
  const status = platformStatus(h);
  const conn = totalConnections(h);
  const connRatio = h.max_connections > 0 ? conn / h.max_connections : 0;
  const cache = h.cache_hit_ratio === null ? null : Number(h.cache_hit_ratio);
  const tables = h.largest_tables ?? [];
  const cron = h.cron ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="System health"
        sub={
          <span aria-live="polite">
            Snapshot {fmtRelative(h.at)} · auto-refresh every 10 s{q.isFetching ? ' · refreshing…' : ''}
          </span>
        }
        actions={
          <>
            <span className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Platform status</span>
              <Badge tone={status.tone}>
                <span className={`h-1.5 w-1.5 rounded-full bg-current ${status.level !== 'NORMAL' ? 'hp-pulse' : ''}`} aria-hidden="true" />
                {status.level}
              </Badge>
            </span>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} busy={q.isFetching} onClick={() => void q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {q.isError && <QueryError error={q.error} onRetry={() => void q.refetch()} />}

      {status.reasons.length > 0 && (
        <p className={`text-xs ${status.tone === 'bad' ? 'text-bad' : 'text-warn'}`}>{status.reasons.join(' · ')}</p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Live events" value={fmtNum(h.live_events)} tone={h.live_events > 0 ? 'pixel' : undefined} sub="navigation → live" />
        <Stat label="Active events" value={fmtNum(h.active_events)} sub="not draft / closed" />
        <Stat label="Participants" value={fmtNum(h.participants_total)} sub="registered, all events" />
        <Stat
          label="Reports / min"
          value={fmtNum(h.reports_last_minute)}
          tone={h.reports_last_minute > REPORTS_HIGH_LOAD ? 'warn' : undefined}
          sub={`high load above ${fmtNum(REPORTS_HIGH_LOAD)}`}
        />
        <Stat label="Open abuse reports" value={fmtNum(h.open_abuse_reports)} tone={h.open_abuse_reports > 0 ? 'warn' : undefined} sub="open + reviewing" />
        <Stat label="Database size" value={fmtBytes(h.db_size_bytes)} />
        <Stat
          label="Connections"
          value={
            <>
              {fmtNum(conn)}
              <span className="text-base text-muted"> / {fmtNum(h.max_connections)}</span>
            </>
          }
          tone={connRatio > CONNECTIONS_CRITICAL ? 'bad' : connRatio > 0.6 ? 'warn' : undefined}
          sub={
            Object.entries(h.connections ?? {})
              .map(([s, n]) => `${s} ${fmtNum(Number(n))}`)
              .join(' · ') || 'none'
          }
        />
        <Stat
          label="Cache hit ratio"
          value={cache === null ? '—' : `${(cache * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`}
          tone={cache === null ? undefined : cache < 0.95 ? 'warn' : 'ok'}
          sub="target ≥ 99%"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Largest tables" padded={false}>
          {tables.length === 0 ? (
            <div className="p-5">
              <Empty title="No table statistics" />
            </div>
          ) : (
            <Table head={['Table', 'Size', 'Rows (est.)']}>
              {tables.map((t) => (
                <tr key={t.table}>
                  <Td className="hp-digits text-xs">{t.table}</Td>
                  <Td className="hp-digits">{fmtBytes(t.bytes)}</Td>
                  <Td className="hp-digits">{fmtNum(t.rows)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Scheduled jobs" padded={false}>
          {cron.length === 0 ? (
            <div className="p-5">
              <Empty title="No cron jobs registered" />
            </div>
          ) : (
            <Table head={['Job', 'Last run', 'Failures 24h']}>
              {cron.map((j) => {
                const failed = Number(j.failures_24h) > 0;
                return (
                  <tr key={j.jobname} className={failed ? 'bg-bad/5' : ''}>
                    <Td className={`hp-digits text-xs ${failed ? 'text-bad' : ''}`}>{j.jobname}</Td>
                    <Td className="text-xs text-muted" title={j.last_run ?? undefined}>
                      {j.last_run ? fmtRelative(j.last_run) : 'never'}
                    </Td>
                    <Td className={`hp-digits font-semibold ${failed ? 'text-bad' : 'text-muted'}`}>{fmtNum(Number(j.failures_24h))}</Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
