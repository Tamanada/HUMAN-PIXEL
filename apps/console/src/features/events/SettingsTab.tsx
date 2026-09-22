import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import { supabase } from '../../lib/supabase';
import { TIMEZONES, isoToZonedLocal, zonedLocalToIso } from '../../lib/time';
import type { EventRow } from '../../lib/types';
import type { TabProps } from './EventLayout';

type Draft = Pick<
  EventRow,
  | 'name' | 'venue_name' | 'timezone' | 'capacity' | 'tolerance_radius_m' | 'required_accuracy_m' | 'allocation_mode'
  | 'allow_late_registration' | 'allow_anonymous_join' | 'countdown' | 'share_message' | 'hashtags' | 'photo_audience' | 'retention_days'
> & { starts_local: string; arrival_local: string; release_local: string };

export function SettingsTab({ event, canEdit }: TabProps) {
  const qc = useQueryClient();
  const tz0 = event.timezone;
  const [d, setD] = useState<Draft>({
    name: event.name,
    venue_name: event.venue_name,
    timezone: tz0,
    capacity: event.capacity,
    tolerance_radius_m: event.tolerance_radius_m,
    required_accuracy_m: event.required_accuracy_m,
    allocation_mode: event.allocation_mode,
    allow_late_registration: event.allow_late_registration,
    allow_anonymous_join: event.allow_anonymous_join,
    countdown: event.countdown,
    share_message: event.share_message,
    hashtags: event.hashtags,
    photo_audience: event.photo_audience,
    retention_days: event.retention_days,
    starts_local: isoToZonedLocal(event.starts_at, tz0),
    arrival_local: isoToZonedLocal(event.arrival_deadline, tz0),
    release_local: isoToZonedLocal(event.positions_release_at, tz0),
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const frozen = !canEdit;

  const save = useMutation({
    mutationFn: async () => {
      const patch = {
        name: d.name.trim(),
        venue_name: d.venue_name?.trim() || null,
        timezone: d.timezone,
        capacity: d.capacity,
        tolerance_radius_m: d.tolerance_radius_m,
        required_accuracy_m: d.required_accuracy_m,
        allocation_mode: d.allocation_mode,
        allow_late_registration: d.allow_late_registration,
        allow_anonymous_join: d.allow_anonymous_join,
        countdown: d.countdown,
        share_message: d.share_message?.trim() || null,
        hashtags: d.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean).slice(0, 10),
        photo_audience: d.photo_audience,
        retention_days: d.retention_days,
        starts_at: d.starts_local ? zonedLocalToIso(d.starts_local, d.timezone) : null,
        arrival_deadline: d.arrival_local ? zonedLocalToIso(d.arrival_local, d.timezone) : null,
        positions_release_at: d.release_local ? zonedLocalToIso(d.release_local, d.timezone) : null,
      };
      const { data, error } = await supabase.from('events').update(patch).eq('id', event.id).select('*').single();
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data as EventRow;
    },
    onSuccess: (e) => qc.setQueryData(['event', event.id], e),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Event & schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" className="col-span-2"><Input disabled={frozen} value={d.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Venue" className="col-span-2"><Input disabled={frozen} value={d.venue_name ?? ''} onChange={(e) => set('venue_name', e.target.value)} /></Field>
          <Field label="Timezone" className="col-span-2" hint="All times below are wall-clock times at the venue.">
            <Select disabled={frozen} value={d.timezone} onChange={(e) => set('timezone', e.target.value)}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select>
          </Field>
          <Field label="Positions unlock" hint="Exact coordinates become visible to phones (anti-scraping)."><Input type="datetime-local" disabled={frozen} value={d.release_local} onChange={(e) => set('release_local', e.target.value)} /></Field>
          <Field label="Arrive before"><Input type="datetime-local" disabled={frozen} value={d.arrival_local} onChange={(e) => set('arrival_local', e.target.value)} /></Field>
          <Field label="Formation starts (T-0)" className="col-span-2" hint="Changes within 90 s of the start are refused: every phone must hear about them first.">
            <Input type="datetime-local" disabled={frozen} value={d.starts_local} onChange={(e) => set('starts_local', e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card title="Positioning">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Capacity (pixels)"
            hint={event.active_formation_id ? 'Set by the locked formation.' : d.capacity == null ? 'Empty: calculated from the formation.' : 'Manual target until a formation is locked.'}
          >
            <Input
              type="number"
              disabled={frozen || !!event.active_formation_id}
              min={1}
              max={250000}
              placeholder="From the formation"
              value={d.capacity ?? ''}
              onChange={(e) => set('capacity', e.target.value === '' ? null : Number(e.target.value))}
            />
          </Field>
          <Field label="Allocation">
            <Select disabled={frozen} value={d.allocation_mode} onChange={(e) => set('allocation_mode', e.target.value as Draft['allocation_mode'])}>
              <option value="progressive">Progressive (readable at any turnout)</option>
              <option value="random">Random</option>
              <option value="sequential">Sequential</option>
            </Select>
          </Field>
          <Field label="Tolerance radius (m)" hint="How close counts as in position."><Input type="number" disabled={frozen} min={0.5} max={50} step={0.5} value={d.tolerance_radius_m} onChange={(e) => set('tolerance_radius_m', Number(e.target.value))} /></Field>
          <Field label="Required GPS accuracy (m)" hint="Phones never claim in-position with worse accuracy."><Input type="number" disabled={frozen} min={1} max={100} value={d.required_accuracy_m} onChange={(e) => set('required_accuracy_m', Number(e.target.value))} /></Field>
        </div>
        {d.required_accuracy_m < d.tolerance_radius_m && <div className="mt-3"><Alert>Tip: typical phone GPS is ±3–8 m under open sky. A tolerance smaller than the accuracy requirement makes positioning harder.</Alert></div>}
        <div className="mt-4 space-y-1 border-t border-line pt-3">
          <Toggle checked={d.allow_late_registration} onChange={(v) => set('allow_late_registration', v)} label="Late registration during preparation and on site" />
          <Toggle checked={d.allow_anonymous_join} onChange={(v) => set('allow_anonymous_join', v)} label="Instant join without email (faster gates, weaker anti-abuse)" />
        </div>
      </Card>
      <Card title="Countdown on phones">
        <div className="space-y-1">
          <Toggle checked={d.countdown.vibrate} onChange={(v) => set('countdown', { ...d.countdown, vibrate: v })} label="Vibrate on each final second and at LIVE" />
          <Toggle checked={d.countdown.sound} onChange={(v) => set('countdown', { ...d.countdown, sound: v })} label="Beep on 3, 2, 1, LIVE" />
          <Toggle checked={d.countdown.flash} onChange={(v) => set('countdown', { ...d.countdown, flash: v })} label="Screen flash at LIVE" />
          <Field label="Final countdown length (s)" className="pt-2">
            <Input type="number" min={3} max={60} value={d.countdown.finalSeconds} onChange={(e) => set('countdown', { ...d.countdown, finalSeconds: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
      <Card title="Photo, sharing & privacy">
        <div className="space-y-3">
          <Field label="Share message" hint="Default: I was one of N people who became ONE HUMAN PIXEL.">
            <Textarea rows={2} maxLength={280} disabled={frozen} value={d.share_message ?? ''} onChange={(e) => set('share_message', e.target.value)} />
          </Field>
          <Field label="Hashtags (space separated)"><Input disabled={frozen} value={d.hashtags.map((h) => `#${h}`).join(' ')} onChange={(e) => set('hashtags', e.target.value.split(/\s+/).map((h) => h.replace(/^#/, '')))} /></Field>
          <Field label="Who receives the photo">
            <Select disabled={frozen} value={d.photo_audience} onChange={(e) => set('photo_audience', e.target.value as Draft['photo_audience'])}>
              <option value="registered">Everyone registered</option>
              <option value="checked_in">Only people who checked in on site</option>
            </Select>
          </Field>
          <Field label="Retention (days after the event)" hint="Then participant links are anonymised automatically."><Input type="number" min={7} max={3650} disabled={frozen} value={d.retention_days} onChange={(e) => set('retention_days', Number(e.target.value))} /></Field>
        </div>
      </Card>
      {canEdit && (
        <div className="flex items-center gap-3 lg:col-span-2">
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
          {save.isSuccess && <span className="text-sm text-ok">Saved. Phones pick up public changes within about a minute.</span>}
          {save.error && <Alert tone="bad">{(save.error as Error).message}</Alert>}
        </div>
      )}
    </div>
  );
}
