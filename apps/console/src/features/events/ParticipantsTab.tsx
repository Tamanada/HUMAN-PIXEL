import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { countryName, flagEmoji } from '@human-pixel/core';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, Table } from '../../components/ui';
import { must, rpc, supabase } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import type { MemberRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { useCounters } from './hooks';

const PAGE = 100;

interface GroupRow {
  id: string;
  name: string;
  code: string;
  capacity: number | null;
}

/**
 * Privacy by default: organizers see participant numbers and statuses, never emails or locations.
 */
export function ParticipantsTab({ event, canEdit }: TabProps) {
  const qc = useQueryClient();
  const counters = useCounters(event.id);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<'all' | MemberRow['status']>('registered');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MemberRow | null>(null);

  const members = useQuery({
    queryKey: ['members', event.id, page, status, search],
    queryFn: async () => {
      let q = supabase
        .from('event_members')
        .select('id, participant_number, status, joined_at, group_id, public_listing, public_name, public_nationality, participant_status(state, reported_at, accuracy_m, report_count)', { count: 'exact' })
        .eq('event_id', event.id)
        .order('participant_number')
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (status !== 'all') q = q.eq('status', status);
      if (/^\d+$/.test(search)) q = q.eq('participant_number', Number(search));
      const res = await q;
      if (res.error) throw new Error(res.error.message);
      return { rows: res.data as unknown as MemberRow[], total: res.count ?? 0 };
    },
  });

  const groups = useQuery({
    queryKey: ['groups', event.id],
    queryFn: async () => must(await supabase.from('event_groups').select('id, name, code, capacity').eq('event_id', event.id).order('created_at')) as GroupRow[],
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['members', event.id] });
    void qc.invalidateQueries({ queryKey: ['counters', event.id] });
  };
  const reassign = useMutation({
    mutationFn: (m: MemberRow) => rpc<number | null>('organizer_reassign_member', { p_member_id: m.id, p_target_idx: null }),
    onSuccess: () => (setSelected(null), invalidate()),
  });
  const removeM = useMutation({
    mutationFn: (m: MemberRow) => rpc('organizer_remove_member', { p_member_id: m.id, p_reason: 'organizer' }),
    onSuccess: () => (setSelected(null), invalidate()),
  });

  const pages = Math.max(1, Math.ceil((members.data?.total ?? 0) / PAGE));

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card
          title={`Participants · ${(counters.data?.registered ?? 0).toLocaleString()} registered`}
          actions={
            <div className="flex gap-2">
              <Input placeholder="Participant #" value={search} onChange={(e) => (setSearch(e.target.value.replace(/\D/g, '')), setPage(0))} className="h-8 w-32" />
              <Select value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(0))} className="h-8 w-36">
                <option value="all">All</option>
                <option value="registered">Registered</option>
                <option value="waitlisted">Waitlisted</option>
                <option value="cancelled">Cancelled</option>
                <option value="removed">Removed</option>
              </Select>
            </div>
          }
          padded={false}
        >
          {members.isLoading ? <Spinner /> : members.error ? <div className="p-4"><Alert tone="bad">{(members.error as Error).message}</Alert></div> : members.data!.rows.length === 0 ? (
            <div className="p-4"><Empty icon={<Users size={24} />} title="No participants here yet">Share the invite link or QR code from the Invite tab.</Empty></div>
          ) : (
            <>
              <Table head={['#', 'Hall of Fame', 'Status', 'Live state', 'GPS', 'Last report', 'Joined', '']}>
                {members.data!.rows.map((m) => (
                  <tr key={m.id} className="hover:bg-surface-2">
                    <td className="hp-digits px-4 py-2">{m.participant_number}</td>
                    <td className="px-4 py-2 text-xs">{m.public_listing ? <span title={m.public_nationality ? countryName(m.public_nationality) : undefined}>{flagEmoji(m.public_nationality)} {m.public_name}</span> : <span className="text-muted">anonymous</span>}</td>
                    <td className="px-4 py-2"><Badge tone={m.status === 'registered' ? 'ok' : m.status === 'waitlisted' ? 'warn' : 'neutral'}>{m.status}</Badge></td>
                    <td className="px-4 py-2 text-xs">{m.participant_status?.state ?? '—'}</td>
                    <td className="hp-digits px-4 py-2 text-xs text-muted">{m.participant_status?.accuracy_m != null ? `±${m.participant_status.accuracy_m.toFixed(0)} m` : '—'}</td>
                    <td className="px-4 py-2 text-xs text-muted">{fmtRelative(m.participant_status?.reported_at)}</td>
                    <td className="px-4 py-2 text-xs text-muted">{new Date(m.joined_at).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right">{canEdit && (m.status === 'registered' || m.status === 'waitlisted') && <Button size="sm" variant="ghost" onClick={() => setSelected(m)}>Manage</Button>}</td>
                  </tr>
                ))}
              </Table>
              <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
                <span>{members.data!.total.toLocaleString()} total</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                  <span>{page + 1} / {pages}</span>
                  <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </Card>
        <div className="space-y-6">
          <Demographics eventId={event.id} />
          <Groups eventId={event.id} canEdit={canEdit} groups={groups.data ?? []} hasFormation={!!event.active_formation_id} />
        </div>
      </div>
      <Modal open={!!selected} onClose={() => setSelected(null)} title={`Participant #${selected?.participant_number}`}>
        <div className="space-y-4 text-sm">
          <p>Move this participant to the best free pixel (e.g. accessibility needs, a broken phone swap, or a spot problem), or remove them from the event. Their phone is notified and refreshes automatically.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={reassign.isPending} disabled={!event.active_formation_id} onClick={() => selected && reassign.mutate(selected)}>Assign a new pixel</Button>
            <Button variant="danger" busy={removeM.isPending} onClick={() => selected && removeM.mutate(selected)}>Remove from event</Button>
          </div>
          {(reassign.error || removeM.error) && <Alert tone="bad">{((reassign.error ?? removeM.error) as Error).message}</Alert>}
        </div>
      </Modal>
    </div>
  );
}

function Groups({ eventId, canEdit, groups, hasFormation }: { eventId: string; canEdit: boolean; groups: GroupRow[]; hasFormation: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [reserveFor, setReserveFor] = useState<GroupRow | null>(null);
  const [zone, setZone] = useState(0);
  const [count, setCount] = useState(20);
  const create = useMutation({
    mutationFn: async () => {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
      const { error } = await supabase.from('event_groups').insert({ event_id: eventId, name, code });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => (setName(''), void qc.invalidateQueries({ queryKey: ['groups', eventId] })),
  });
  const reserve = useMutation({
    mutationFn: () => rpc<number>('reserve_points_for_group', { p_group_id: reserveFor!.id, p_zone: zone, p_count: count }),
  });
  return (
    <Card title="Groups">
      <p className="mb-3 text-xs text-muted">Friends, families or sponsors who should stand together join with the event code plus their group code; you can reserve a compact block of pixels for them.</p>
      <ul className="mb-4 space-y-2">
        {groups.map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <span>{g.name} <span className="hp-digits ml-1 text-xs text-muted">{g.code}</span></span>
            {canEdit && hasFormation && <Button size="sm" variant="ghost" onClick={() => setReserveFor(g)}>Reserve</Button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="flex gap-2" onSubmit={(e: FormEvent) => (e.preventDefault(), create.mutate())}>
          <Input placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button type="submit" busy={create.isPending}>Add</Button>
        </form>
      )}
      {create.error && <div className="mt-2"><Alert tone="bad">{(create.error as Error).message}</Alert></div>}
      <Modal open={!!reserveFor} onClose={() => (setReserveFor(null), reserve.reset())} title={`Reserve pixels for ${reserveFor?.name}`} footer={<Button variant="primary" busy={reserve.isPending} onClick={() => reserve.mutate()}>Reserve</Button>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Zone number (0 = A)"><Input type="number" min={0} value={zone} onChange={(e) => setZone(Number(e.target.value))} /></Field>
          <Field label="Pixels"><Input type="number" min={1} max={5000} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
        </div>
        {reserve.data != null && <div className="mt-3"><Alert tone="ok">{reserve.data} pixels reserved.</Alert></div>}
        {reserve.error && <div className="mt-3"><Alert tone="bad">{(reserve.error as Error).message}</Alert></div>}
      </Modal>
    </Card>
  );
}

interface DemographicsData {
  total: number;
  listed: number;
  medianAge: number | null;
  ageBuckets: Record<string, number | null>;
  sex: Record<string, number | null>;
  nationalities: { code: string; count: number }[];
  countries: number;
}

const AGE_ORDER = ['<18', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unknown'];
const SEX_LABEL: Record<string, string> = { female: 'Female', male: 'Male', other: 'Other', undisclosed: 'Not said', unknown: 'Unknown' };

/** Anonymous aggregates only; buckets under 3 people are suppressed by the database. */
function Demographics({ eventId }: { eventId: string }) {
  const q = useQuery({ queryKey: ['demographics', eventId], refetchInterval: 60_000, queryFn: () => rpc<DemographicsData>('get_event_demographics', { p_event_id: eventId }) });
  const d = q.data;
  if (!d || d.total === 0) return null;
  const bar = (n: number | null | undefined) => (n == null ? 0 : (100 * n) / d.total);
  return (
    <Card title={`Who is coming · ${d.countries} countries`}>
      <div className="space-y-4 text-sm">
        <div className="flex justify-between text-xs text-muted">
          <span>Median age {d.medianAge != null ? Math.round(d.medianAge) : '—'}</span>
          <span>{d.listed.toLocaleString()} in the Hall of Fame</span>
        </div>
        <div className="space-y-1.5">
          {AGE_ORDER.filter((k) => k in d.ageBuckets).map((k) => (
            <Row key={k} label={k} value={d.ageBuckets[k] ?? null} pct={bar(d.ageBuckets[k])} />
          ))}
        </div>
        <div className="space-y-1.5 border-t border-line pt-3">
          {Object.entries(d.sex).map(([k, v]) => <Row key={k} label={SEX_LABEL[k] ?? k} value={v} pct={bar(v)} />)}
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
          {d.nationalities.slice(0, 24).map((n) => (
            <span key={n.code} title={countryName(n.code)} className="rounded-full border border-line px-2 py-0.5 text-xs">{flagEmoji(n.code)} <span className="hp-digits">{n.count}</span></span>
          ))}
        </div>
        <p className="text-[11px] text-muted">Anonymous statistics. Groups under 3 people are hidden.</p>
      </div>
    </Card>
  );
}

function Row({ label, value, pct }: { label: string; value: number | null; pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full bg-pixel" style={{ width: `${pct}%` }} /></div>
      <span className="hp-digits w-12 text-right text-xs">{value == null ? '<3' : value.toLocaleString()}</span>
    </div>
  );
}
