import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Circle } from 'lucide-react';
import { EVENT_STATES, EVENT_STATE_LABELS, EVENT_TRANSITIONS, type EventState } from '@human-pixel/core';
import { Alert, Badge, Button, Card, Field, Modal, Stat, Textarea } from '../../components/ui';
import { rpc } from '../../lib/supabase';
import { fmtDateTime, fmtRelative } from '../../lib/time';
import type { EventRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { useAreas, useCounters, useFormations } from './hooks';

const FLOW: EventState[] = EVENT_STATES.filter((s) => s !== 'CANCELLED');

const TRANSITION_HELP: Partial<Record<EventState, string>> = {
  REGISTRATION_OPEN: 'Publishes the event: participants can join with the code or QR. Requires a capacity (from the formation).',
  REGISTRATION_CLOSED: 'Stops new registrations (late registration still follows your settings later).',
  EVENT_PREPARATION: 'Freezes the formation plan. Requires a locked formation.',
  PARTICIPANT_NAVIGATION: 'Releases every exact position now and tells phones to guide people to their pixel.',
  POSITIONING: 'Final positioning phase. Watch readiness in the Live tab.',
  READY: 'Everyone is in place. Phones already count down locally.',
  LIVE: 'Records the formation moment (happens automatically at the start time).',
  PHOTO_CAPTURED: 'The aerial photo has been taken.',
  PHOTO_PROCESSING: 'You are editing the photo.',
  PHOTO_RELEASED: 'Every participant receives the official photo. Requires an uploaded official photo.',
  COMPLETED: 'Closes the event. Retention timers start.',
  CANCELLED: 'Cancels the event for everyone. Cannot be undone.',
};

export function Overview({ event, canEdit }: TabProps) {
  const areas = useAreas(event.id);
  const formations = useFormations(event.id);
  const counters = useCounters(event.id);
  const qc = useQueryClient();
  const [target, setTarget] = useState<EventState | null>(null);
  const [reason, setReason] = useState('');

  const transition = useMutation({
    mutationFn: (to: EventState) => rpc<EventRow>('transition_event', { p_event_id: event.id, p_to: to, p_reason: reason || null }),
    onSuccess: (e) => {
      qc.setQueryData(['event', event.id], e);
      void qc.invalidateQueries({ queryKey: ['events'] });
      setTarget(null);
      setReason('');
    },
  });

  const hasPerimeter = (areas.data ?? []).some((a) => a.kind === 'perimeter');
  const locked = (formations.data ?? []).find((f) => f.id === event.active_formation_id);
  const checklist: [boolean, string, string][] = [
    [!!event.starts_at && Date.parse(event.starts_at) > Date.now() - 86400_000, 'Formation start time set', 'settings'],
    [hasPerimeter, 'Event perimeter drawn', 'location'],
    [event.capacity != null, 'Capacity set (calculated from the formation)', 'formation'],
    [!!locked, 'Formation generated, validated and locked', 'formation'],
    [!!event.positions_release_at, 'Position release time chosen', 'settings'],
    [!!event.arrival_deadline, 'Arrival deadline set', 'settings'],
  ];
  const next = EVENT_TRANSITIONS[event.state];
  const idx = FLOW.indexOf(event.state);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Registered" value={(counters.data?.registered ?? 0).toLocaleString()} sub={event.capacity != null ? `of ${event.capacity.toLocaleString()} capacity` : 'capacity set by the formation'} tone="pixel" />
          <Stat label="Formation" value={locked ? `v${locked.version}` : '—'} sub={locked ? `${locked.point_count.toLocaleString()} pixels · locked` : 'not locked'} />
          <Stat label="Starts" value={event.starts_at ? fmtRelative(event.starts_at) : '—'} sub={fmtDateTime(event.starts_at, event.timezone)} />
        </div>
        <Card title="Lifecycle">
          <ol className="flex flex-wrap gap-2">
            {FLOW.map((s, i) => (
              <li key={s} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                s === event.state ? 'border-pixel bg-pixel/10 text-pixel' : i < idx ? 'border-line text-muted' : 'border-line text-muted/60'
              }`}>
                {i < idx ? <Check size={12} /> : <Circle size={8} />} {EVENT_STATE_LABELS[s]}
              </li>
            ))}
            {event.state === 'CANCELLED' && <li><Badge tone="bad">Cancelled</Badge></li>}
          </ol>
          {canEdit && next.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Next</p>
              <div className="flex flex-wrap gap-2">
                {next.map((s) => (
                  <Button key={s} variant={s === 'CANCELLED' ? 'danger' : 'primary'} size="sm" onClick={() => setTarget(s)}>
                    {s === 'CANCELLED' ? 'Cancel event' : `→ ${EVENT_STATE_LABELS[s]}`}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
      <Card title="Readiness checklist">
        <ul className="space-y-3">
          {checklist.map(([ok, label, tab]) => (
            <li key={label} className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-ok/20 text-ok' : 'bg-line text-muted'}`}>{ok ? <Check size={12} /> : ''}</span>
              <Link to={`/events/${event.id}/${tab}`} className={ok ? 'text-muted' : 'hover:text-pixel'}>{label}</Link>
            </li>
          ))}
        </ul>
      </Card>
      <Modal
        open={!!target}
        onClose={() => setTarget(null)}
        title={target === 'CANCELLED' ? 'Cancel this event?' : `Move to ${target ? EVENT_STATE_LABELS[target] : ''}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>Back</Button>
            <Button variant={target === 'CANCELLED' ? 'danger' : 'primary'} busy={transition.isPending} onClick={() => target && transition.mutate(target)}>Confirm</Button>
          </>
        }
      >
        <div className="space-y-4">
          {target && <p className="text-sm">{TRANSITION_HELP[target]}</p>}
          <Field label="Reason (recorded in the audit trail)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {transition.error && <Alert tone="bad">{(transition.error as Error).message}</Alert>}
        </div>
      </Modal>
    </div>
  );
}
