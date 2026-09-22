import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { Alert, Button, Card, Spinner, Stat, Table } from '../../components/ui';
import { must, rpc, supabase } from '../../lib/supabase';
import { fmtDateTime } from '../../lib/time';
import type { TabProps } from './EventLayout';

interface Evidence {
  generated_at: string;
  sha256: string;
  event: { name: string; starts_at: string | null; live_at: string | null; timezone: string; venue_name: string | null };
  perimeter_area_m2: number | null;
  formation: { version: number; points: number; seed: number; checksum: number; metrics: Record<string, number>; locked_at: string } | null;
  counts_now: Record<string, number>;
  counts_at_live: Record<string, number> | null;
  state_history: { from: string | null; to: string; at: string; system: boolean }[];
  assignment_actions: Record<string, number>;
  photos: { id: string; kind: string; sha256: string | null; width: number | null; height: number | null; captured_at: string | null; camera: string | null }[];
  audit_entries: number;
}

interface AuditRow {
  id: number;
  at: string;
  action: string;
  target_type: string | null;
  details: Record<string, unknown>;
}

/**
 * Record-grade evidence: exact times, location, counts at the LIVE moment, formation geometry and
 * the photo hashes, sealed with a SHA-256 of the whole report. This platform makes no record claim.
 */
export function EvidenceTab({ event }: TabProps) {
  const ev = useQuery({ queryKey: ['evidence', event.id], queryFn: () => rpc<Evidence>('get_event_evidence', { p_event_id: event.id }) });
  const audit = useQuery({
    queryKey: ['audit', event.id],
    queryFn: async () => must(await supabase.from('audit_logs').select('id, at, action, target_type, details').eq('event_id', event.id).order('at', { ascending: false }).limit(200)) as AuditRow[],
  });

  if (ev.isLoading) return <Spinner />;
  if (ev.error) return <Alert tone="bad">{(ev.error as Error).message}</Alert>;
  const e = ev.data!;
  const live = e.counts_at_live;
  const download = () => {
    const blob = new Blob([JSON.stringify(e, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `human-pixel-evidence-${event.join_code}-${e.generated_at.slice(0, 10)}.json`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <Alert>
        <span className="flex items-start gap-2"><ShieldCheck size={16} className="mt-0.5 shrink-0" /> This report documents the event for a possible future record submission. HUMAN PIXEL does not claim any record; adjudication belongs to the record body.</span>
      </Alert>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pixels in formation" value={e.formation?.points.toLocaleString() ?? '—'} />
        <Stat label="In position at LIVE" value={live ? (live.in_position ?? 0).toLocaleString() : '—'} sub={live ? `${(live.ready ?? 0).toLocaleString()} ready` : 'not live yet'} tone="pixel" />
        <Stat label="Checked in at LIVE" value={live ? (live.checked_in ?? 0).toLocaleString() : '—'} />
        <Stat label="Perimeter" value={e.perimeter_area_m2 ? `${Math.round(e.perimeter_area_m2).toLocaleString()} m²` : '—'} />
      </div>
      <Card title="Report" actions={<Button size="sm" icon={<Download size={14} />} onClick={download}>Download JSON</Button>}>
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <Item k="Formation start" v={fmtDateTime(e.event.starts_at, e.event.timezone)} />
          <Item k="LIVE recorded" v={fmtDateTime(e.event.live_at, e.event.timezone)} />
          <Item k="Venue" v={e.event.venue_name ?? '—'} />
          <Item k="Formation" v={e.formation ? `v${e.formation.version} · seed ${e.formation.seed} · checksum ${e.formation.checksum}` : '—'} />
          <Item k="Assignment actions" v={Object.entries(e.assignment_actions).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'} />
          <Item k="Audit entries" v={String(e.audit_entries)} />
          <Item k="Photos" v={e.photos.map((p) => `${p.kind}${p.camera ? ` (${p.camera})` : ''}`).join(', ') || '—'} />
          <Item k="Report SHA-256" v={<span className="break-all font-mono text-xs">{e.sha256}</span>} />
        </dl>
      </Card>
      <Card title="State history" padded={false}>
        <Table head={['At', 'From', 'To', 'By']}>
          {e.state_history.map((h, i) => (
            <tr key={i}>
              <td className="px-4 py-2 text-xs">{fmtDateTime(h.at, e.event.timezone)}</td>
              <td className="px-4 py-2 text-xs text-muted">{h.from ?? '—'}</td>
              <td className="px-4 py-2 text-xs">{h.to}</td>
              <td className="px-4 py-2 text-xs text-muted">{h.system ? 'scheduler' : 'organizer'}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Audit trail (latest 200)" padded={false}>
        <Table head={['At', 'Action', 'Details']}>
          {(audit.data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap px-4 py-2 text-xs">{new Date(a.at).toLocaleString()}</td>
              <td className="px-4 py-2 text-xs">{a.action}</td>
              <td className="max-w-md truncate px-4 py-2 font-mono text-[11px] text-muted">{JSON.stringify(a.details)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function Item({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>
  );
}
