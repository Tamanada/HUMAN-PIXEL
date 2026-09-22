import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Search } from 'lucide-react';
import { EVENT_STATES, type EventState } from '@human-pixel/core';
import { supabase, must } from '../../lib/supabase';
import { fmtDateTime, fmtRelative } from '../../lib/time';
import { Badge, Card, Empty, Input, Select, Spinner, Table } from '../../components/ui';
import { PageHeader, QueryError, ShortId, Td, adminKeys, fmtNum } from './shared';

const LIMIT = 200;

interface EventRow {
  id: string;
  org_id: string;
  name: string;
  state: EventState;
  starts_at: string | null;
  timezone: string;
  capacity: number | null;
  venue_name: string | null;
  created_at: string;
}

interface AdminEventRow extends EventRow {
  org_name: string | null;
  registered: number | null;
}

const LIVE_STATES: ReadonlySet<EventState> = new Set(['PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE']);

/** An invalid stored timezone must not crash the whole table. */
function safeDateTime(iso: string | null, tz: string): string {
  try {
    return fmtDateTime(iso, tz);
  } catch {
    return `${fmtDateTime(iso, 'UTC')} UTC`;
  }
}

export function stateTone(s: EventState): 'neutral' | 'ok' | 'warn' | 'bad' | 'pixel' {
  if (s === 'CANCELLED') return 'bad';
  if (LIVE_STATES.has(s)) return 'pixel';
  if (s === 'REGISTRATION_OPEN') return 'ok';
  if (s === 'COMPLETED' || s === 'DRAFT') return 'neutral';
  return 'warn';
}

async function fetchEvents(state: string): Promise<AdminEventRow[]> {
  let query = supabase
    .from('events')
    .select('id, org_id, name, state, starts_at, timezone, capacity, venue_name, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (state) query = query.eq('state', state);
  const events = must(await query) as EventRow[];
  if (events.length === 0) return [];

  const orgIds = [...new Set(events.map((e) => e.org_id))];
  const [orgs, counters] = await Promise.all([
    supabase.from('organizations').select('id, name').in('id', orgIds),
    supabase.from('event_counters').select('event_id, registered').in('event_id', events.map((e) => e.id)),
  ]);
  const orgName = new Map((must(orgs) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  const registered = new Map((must(counters) as { event_id: string; registered: number }[]).map((c) => [c.event_id, c.registered]));

  return events.map((e) => ({ ...e, org_name: orgName.get(e.org_id) ?? null, registered: registered.get(e.id) ?? null }));
}

export function EventsPage() {
  const [state, setState] = useState('');
  const [text, setText] = useState('');

  const q = useQuery({ queryKey: adminKeys.events(state), queryFn: () => fetchEvents(state) });

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const all = q.data ?? [];
    if (!needle) return all;
    return all.filter((e) =>
      [e.name, e.org_name ?? '', e.venue_name ?? '', e.id].some((v) => v.toLowerCase().includes(needle)),
    );
  }, [q.data, text]);

  return (
    <div className="space-y-4">
      <PageHeader title="Events" sub={`Latest ${LIMIT} events across all organizations, newest first.`} />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <label className="relative w-full max-w-sm">
            <span className="sr-only">Filter events by name, organization, venue or id</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, organization, venue, id" className="pl-9" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">State</span>
            <Select value={state} onChange={(e) => setState(e.target.value)} className="w-56">
              <option value="">All states</option>
              {EVENT_STATES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </Select>
          </label>
          {q.data && (
            <span className="hp-digits ml-auto text-xs text-muted">
              {fmtNum(rows.length)} / {fmtNum(q.data.length)}
            </span>
          )}
        </div>

        {q.isPending ? (
          <Spinner label="Loading events" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<CalendarRange size={24} />} title="No events match these filters" />
          </div>
        ) : (
          <Table head={['Event', 'Organization', 'State', 'Starts (event tz)', 'Registered', 'Capacity', 'Created']}>
            {rows.map((e) => {
              const fill = e.registered !== null && e.capacity ? e.registered / e.capacity : null;
              return (
                <tr key={e.id}>
                  <Td>
                    <div className="flex flex-col">
                      <span className="font-medium">{e.name}</span>
                      <span className="text-xs text-muted">
                        {e.venue_name ?? <ShortId id={e.id} />}
                      </span>
                    </div>
                  </Td>
                  <Td>{e.org_name ?? <ShortId id={e.org_id} />}</Td>
                  <Td>
                    <Badge tone={stateTone(e.state)}>{e.state.replace(/_/g, ' ')}</Badge>
                  </Td>
                  <Td className="text-xs">
                    <div className="flex flex-col">
                      <span>{safeDateTime(e.starts_at, e.timezone)}</span>
                      <span className="text-muted">{e.timezone}</span>
                    </div>
                  </Td>
                  <Td className={`hp-digits ${fill !== null && fill >= 1 ? 'text-warn' : ''}`}>{fmtNum(e.registered)}</Td>
                  <Td className="hp-digits">{fmtNum(e.capacity)}</Td>
                  <Td className="text-xs text-muted" title={e.created_at}>{fmtRelative(e.created_at)}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
