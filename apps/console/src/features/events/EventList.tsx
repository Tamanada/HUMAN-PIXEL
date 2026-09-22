import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarRange, Plus } from 'lucide-react';
import { EVENT_STATE_LABELS, type EventState } from '@human-pixel/core';
import { Alert, Badge, Button, Empty, Field, Input, Modal, Select, Spinner } from '../../components/ui';
import { canManage, useAuth } from '../../lib/auth';
import { must, rpc, supabase } from '../../lib/supabase';
import { TIMEZONES, fmtDateTime, zonedLocalToIso } from '../../lib/time';
import type { EventRow } from '../../lib/types';

export function stateTone(s: EventState): 'neutral' | 'ok' | 'warn' | 'bad' | 'pixel' {
  if (s === 'CANCELLED') return 'bad';
  if (s === 'LIVE' || s === 'READY' || s === 'POSITIONING' || s === 'PARTICIPANT_NAVIGATION') return 'pixel';
  if (s === 'COMPLETED' || s === 'PHOTO_RELEASED') return 'ok';
  if (s === 'DRAFT') return 'neutral';
  return 'warn';
}

export function EventList() {
  const { memberships, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const events = useQuery({
    queryKey: ['events'],
    queryFn: async () =>
      must(
        await supabase
          .from('events')
          .select('id, org_id, name, state, starts_at, timezone, venue_name, capacity, join_code, event_counters(registered)')
          .order('starts_at', { ascending: true, nullsFirst: false })
          .limit(200),
      ) as unknown as (EventRow & { event_counters: { registered: number } | null })[],
  });
  const orgName = (id: string) => memberships.find((m) => m.org_id === id)?.organizations.name ?? '';
  const canCreate = isAdmin || memberships.some((m) => canManage(m, false));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="hp-display text-3xl">Events</h1>
          <p className="text-muted">Every formation starts here.</p>
        </div>
        {canCreate && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>New event</Button>}
      </div>
      {events.isLoading ? <Spinner /> : events.error ? <Alert tone="bad">{(events.error as Error).message}</Alert> : (events.data ?? []).length === 0 ? (
        <Empty icon={<CalendarRange size={28} />} title="No events yet">Create your first human formation.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {events.data!.map((e) => (
            <Link key={e.id} to={`/events/${e.id}`} className="group rounded-2xl border border-line bg-surface p-5 transition hover:border-pixel/60">
              <div className="mb-4 flex items-start justify-between gap-3">
                <Badge tone={stateTone(e.state)}>{EVENT_STATE_LABELS[e.state]}</Badge>
                <span className="hp-digits text-xs text-muted">{e.join_code}</span>
              </div>
              <h2 className="hp-display text-xl group-hover:text-pixel">{e.name}</h2>
              <p className="mt-1 text-sm text-muted">{orgName(e.org_id)}{e.venue_name ? ` · ${e.venue_name}` : ''}</p>
              <div className="mt-5 flex items-end justify-between">
                <p className="text-sm">{fmtDateTime(e.starts_at, e.timezone)}</p>
                <p className="hp-digits text-sm"><span className="text-text">{(e.event_counters?.registered ?? 0).toLocaleString()}</span><span className="text-muted"> / {e.capacity.toLocaleString()}</span></p>
              </div>
            </Link>
          ))}
        </div>
      )}
      <CreateEventModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CreateEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { memberships, isAdmin } = useAuth();
  const nav = useNavigate();
  const orgs = memberships.filter((m) => canManage(m, isAdmin));
  const [orgId, setOrgId] = useState(orgs[0]?.org_id ?? '');
  const [name, setName] = useState('');
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState('');
  const [capacity, setCapacity] = useState(12000);
  const [venue, setVenue] = useState('');

  const create = useMutation({
    mutationFn: () =>
      rpc<EventRow>('create_event', {
        p_org_id: orgId || orgs[0]?.org_id,
        p_name: name,
        p_starts_at: start ? zonedLocalToIso(start, tz) : null,
        p_timezone: tz,
        p_capacity: capacity,
        p_venue_name: venue || null,
        p_center_lat: null,
        p_center_lng: null,
      }),
    onSuccess: (e) => nav(`/events/${e.id}/location`),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New event"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={create.isPending} disabled={name.trim().length < 3 || !(orgId || orgs[0])} onClick={() => create.mutate()}>Create</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e: FormEvent) => e.preventDefault()}>
        {orgs.length > 1 && (
          <Field label="Organization">
            <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((m) => <option key={m.org_id} value={m.org_id}>{m.organizations.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Event name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="PHANGAN HUMAN PIXEL 2027" maxLength={120} /></Field>
        <Field label="Venue"><Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Haad Rin Beach, Koh Phangan" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timezone">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select>
          </Field>
          <Field label="Formation start (event time)"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        </div>
        <Field label="Participants (capacity)" hint="Target number of human pixels. Your plan may limit this.">
          <Input type="number" min={1} max={250000} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
        </Field>
        {create.error && <Alert tone="bad">{(create.error as Error).message}</Alert>}
      </form>
    </Modal>
  );
}
