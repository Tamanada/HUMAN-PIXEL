import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Megaphone, RotateCcw } from 'lucide-react';
import { countdown, formatCountdown } from '@human-pixel/core';
import { Alert, Badge, Button, Card, Input, Stat } from '../../components/ui';
import { MapView } from '../../components/MapView';
import { rpc, supabase } from '../../lib/supabase';
import type { LiveStats } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { useAreas, useFormationPoints } from './hooks';

// Point categories from get_formation_live: 0 free · 1 joined · 2 checked-in · 3 arrived · 4 in position · 5 ready · 6 left · 7 completed
const PALETTE = ['#3a3a48', '#6b6b7d', '#9ad0ff', '#ffb23f', '#8c7cff', '#2be38f', '#ff4d5e', '#2be38f'];
const LEGEND: [number, string][] = [[5, 'Ready'], [4, 'In position'], [3, 'Arrived'], [2, 'Checked in'], [1, 'Not arrived'], [6, 'Left position'], [0, 'Unassigned']];

export function LiveTab({ event, canEdit }: TabProps) {
  const qc = useQueryClient();
  const stats = useQuery({
    queryKey: ['live', event.id],
    queryFn: () => rpc<LiveStats>('get_event_live_stats', { p_event_id: event.id }),
    refetchInterval: 5_000,
  });
  const areas = useAreas(event.id);
  const points = useFormationPoints(event.active_formation_id);
  const liveStates = useQuery({
    queryKey: ['formation-live', event.active_formation_id],
    enabled: !!event.active_formation_id,
    refetchInterval: 10_000,
    queryFn: () => rpc<string>('get_formation_live', { p_formation_id: event.active_formation_id }),
  });

  // Organizer clock offset from the server time in each stats response (dashboard countdown).
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (stats.data) setOffset(Date.parse(stats.data.server_time) - Date.now());
  }, [stats.data]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const layer = useMemo(() => {
    if (!points.data) return null;
    const cat = new Uint8Array(points.data.idx.length);
    const s = liveStates.data ?? '';
    for (let i = 0; i < cat.length; i++) cat[i] = s.charCodeAt(i) - 48 || 0;
    return { lat: points.data.lat, lng: points.data.lng, category: cat, palette: PALETTE };
  }, [points.data, liveStates.data]);

  const reclaim = useMutation({
    mutationFn: () => rpc<{ standby: number; released: number; assigned: number }>('reclaim_no_shows', { p_event_id: event.id, p_limit: 100000 }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['live', event.id] }),
  });
  const [announcement, setAnnouncement] = useState(event.announcement ?? '');
  const announce = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('events').update({ announcement: announcement.trim() || null }).eq('id', event.id);
      if (error) throw new Error(error.message);
    },
  });

  const s = stats.data;
  const c = s?.counts;
  const start = event.starts_at ? Date.parse(event.starts_at) : null;
  const cd = start ? countdown(start, now + offset) : null;
  const healthTone = s?.health.level === 'CRITICAL' ? 'bad' : s?.health.level === 'HIGH_LOAD' ? 'warn' : 'ok';
  const pct = (n: number | undefined) => (c && c.assigned ? `${((100 * (n ?? 0)) / c.assigned).toFixed(1)}%` : '—');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Event health</p>
          <div className="mt-1 flex items-center gap-3">
            <span className={`h-3 w-3 rounded-full ${healthTone === 'ok' ? 'bg-ok' : healthTone === 'warn' ? 'bg-warn' : 'bg-bad'} hp-pulse`} />
            <span className={`hp-display text-2xl text-${healthTone}`}>{s?.health.level.replace('_', ' ') ?? '…'}</span>
            <span className="text-xs text-muted">{s ? `${s.report_rate_per_s} reports/s · query ${s.health.query_ms} ms` : ''}</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">{cd && cd.remainingMs <= 0 ? 'Since start' : 'Formation starts in'}</p>
          <p className="hp-digits text-4xl font-bold">{cd ? (cd.remainingMs > 0 ? formatCountdown(cd) : `+${formatCountdown(countdown(now + offset, start!))}`) : '—'}</p>
        </div>
      </div>
      {s?.health.issues.map((i) => <Alert key={i.code} tone={i.level === 'critical' ? 'bad' : 'warn'}>{i.message}</Alert>)}
      {stats.error && <Alert tone="bad">{(stats.error as Error).message}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Registered" value={(c?.registered ?? 0).toLocaleString()} sub={`${(c?.waitlisted ?? 0).toLocaleString()} waitlisted`} />
        <Stat label="Checked in" value={(c?.checked_in ?? 0).toLocaleString()} sub={pct(c?.checked_in)} />
        <Stat label="Arrived" value={(c?.arrived ?? 0).toLocaleString()} sub={pct(c?.arrived)} />
        <Stat label="In position" value={(c?.in_position ?? 0).toLocaleString()} sub={pct(c?.in_position)} tone="pixel" />
        <Stat label="Ready" value={(c?.ready ?? 0).toLocaleString()} sub={`${(c?.left_position ?? 0).toLocaleString()} left position`} tone="ok" />
        <Stat label="Readiness" value={`${s?.readiness ?? 0}%`} sub={`of ${(c?.assigned ?? 0).toLocaleString()} assigned`} tone={(s?.readiness ?? 0) >= 85 ? 'ok' : (s?.readiness ?? 0) >= 50 ? 'warn' : 'bad'} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card title="Secret formation · live" actions={<Badge tone="pixel">organizer only</Badge>} padded={false}>
          <div className="p-3">
            {event.active_formation_id ? <MapView areas={areas.data ?? []} points={layer} height={520} /> : <Alert>No locked formation yet.</Alert>}
            <div className="mt-3 flex flex-wrap gap-3 px-1 text-xs text-muted">
              {LEGEND.map(([k, l]) => (
                <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[k] }} />{l}</span>
              ))}
            </div>
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Zones" padded={false}>
            <ul className="divide-y divide-line">
              {(s?.zones ?? []).map((z) => {
                const p = z.assigned ? z.in_position / z.assigned : 0;
                return (
                  <li key={z.label} className="px-4 py-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="hp-display">Zone {z.label}</span>
                      <span className="hp-digits text-xs text-muted">{z.in_position.toLocaleString()} / {z.assigned.toLocaleString()}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full ${p > 0.85 ? 'bg-ok' : p > 0.5 ? 'bg-warn' : 'bg-pixel'}`} style={{ width: `${p * 100}%` }} /></div>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card title="GPS & sync">
            <dl className="space-y-1.5 text-sm">
              <Row k="Median accuracy" v={s?.gps.median_accuracy_m != null ? `±${s.gps.median_accuracy_m.toFixed(1)} m` : '—'} />
              <Row k="90th percentile" v={s?.gps.p90_accuracy_m != null ? `±${s.gps.p90_accuracy_m.toFixed(1)} m` : '—'} />
              <Row k="Poor GPS" v={(s?.gps.poor ?? 0).toLocaleString()} />
              <Row k="Clock sync p95" v={s?.gps.p95_clock_uncertainty_ms != null ? `±${Math.round(s.gps.p95_clock_uncertainty_ms)} ms` : '—'} />
            </dl>
          </Card>
          {canEdit && (
            <Card title="Operations">
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs text-muted">Give the pixels of people who never checked in to on-site standby participants (most important pixels first).</p>
                  <Button icon={<RotateCcw size={14} />} busy={reclaim.isPending} disabled={!['PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY'].includes(event.state)} onClick={() => reclaim.mutate()}>Reclaim no-shows</Button>
                  {reclaim.data && <Alert tone="ok">Standby {reclaim.data.standby} · reassigned {reclaim.data.assigned}</Alert>}
                  {reclaim.error && <Alert tone="bad">{(reclaim.error as Error).message}</Alert>}
                </div>
                <div className="space-y-2 border-t border-line pt-4">
                  <p className="text-xs text-muted">Announcement shown on every phone (reaches the crowd through the CDN within ~1 minute).</p>
                  <Input maxLength={280} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} placeholder="e.g. Zone C: enter from the north gate" />
                  <Button icon={<Megaphone size={14} />} busy={announce.isPending} onClick={() => announce.mutate()}>Publish</Button>
                  {announce.isSuccess && <p className="text-xs text-ok">Published.</p>}
                </div>
              </div>
            </Card>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted"><Activity size={12} /> Stats every 5 s, formation every 10 s. Phones never stream GPS.</p>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="hp-digits">{v}</dd></div>
  );
}
