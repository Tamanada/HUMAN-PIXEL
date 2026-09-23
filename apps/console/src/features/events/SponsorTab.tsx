/**
 * THE SPONSOR REPORT: what the brand receives the morning after, and the thing that is actually
 * sold. Every figure here was witnessed by the database — nothing is modelled or extrapolated.
 *
 * The three words that carry the money are defined on the page itself, because a brand that has
 * been sold "reach" a hundred times needs to see exactly what it is being told:
 *   registered  — signed up
 *   checked in  — a phone reported on the day
 *   in position — a phone reported from inside its tolerance radius, i.e. a person in the picture
 * The headline is the PEAK, not the final count: people drift away after the shutter.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Printer, ShieldCheck } from 'lucide-react';
import { Alert, Button, Card, Field, Input, Spinner, Stat, Table } from '../../components/ui';
import { rpc, supabase } from '../../lib/supabase';
import { fmtDateTime } from '../../lib/time';
import type { TabProps } from './EventLayout';

interface SponsorReport {
  generated_at: string;
  sha256: string;
  event: { id: string; name: string; state: string; timezone: string; venue_name: string | null; starts_at: string | null; live_at: string | null; completed_at: string | null };
  organization: { name: string; contact_email: string | null } | null;
  sponsor: { name?: string; campaign?: string };
  briefing: { dressCode?: { text?: string; colors?: string[] }; bring?: string; collect?: string; bounty?: string };
  design: { message: string | null; kind: string | null; font: string | null; version: number; pixels: number; locked_at: string | null; footprint_w_m: number | null; footprint_h_m: number | null; readability: string | null } | null;
  audience: { capacity: number | null; registered: number; waitlisted: number; cancelled: number };
  delivery: {
    peak_in_position: number;
    peak_in_position_at: string | null;
    peak_checked_in: number;
    peak_checked_in_at: string | null;
    at_formation: Record<string, number> | null;
    now: Record<string, number>;
  };
  pickups: { id: string; kind: string; name: string | null; details: string | null; capacity: number | null; assigned: number; checked_in: number }[];
  curve: { at: string; checked_in: number; in_position: number }[];
  photos: { id: string; kind: string; is_primary: boolean; display_path: string; width: number | null; height: number | null; captured_at: string | null; released_at: string | null }[];
}

const KIND_LABEL: Record<string, string> = { collection: 'Collection', control: 'Check-in', bounty: 'Bounty' };

export function SponsorTab({ event, canEdit }: TabProps) {
  const qc = useQueryClient();
  const report = useQuery({
    queryKey: ['sponsor-report', event.id],
    queryFn: () => rpc<SponsorReport>('get_event_sponsor_report', { p_event_id: event.id }),
  });
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const primary = useMemo(() => {
    const ps = report.data?.photos ?? [];
    return ps.find((p) => p.is_primary && p.kind === 'official') ?? ps.find((p) => p.kind === 'official') ?? ps[0] ?? null;
  }, [report.data]);

  useEffect(() => {
    let alive = true;
    if (!primary) {
      setPhotoUrl(null);
      return;
    }
    void supabase.storage
      .from('event-photos')
      .createSignedUrl(primary.display_path, 3600)
      .then((r) => {
        if (alive) setPhotoUrl(r.data?.signedUrl ?? null);
      });
    return () => {
      alive = false;
    };
  }, [primary]);

  if (report.isLoading) return <Spinner />;
  if (report.error) return <Alert tone="bad">{(report.error as Error).message}</Alert>;
  const r = report.data!;
  const tz = r.event.timezone;
  const peak = r.delivery.peak_in_position;
  const shown = peak || r.delivery.at_formation?.in_position || 0;
  const conversion = r.audience.registered > 0 ? Math.round((shown / r.audience.registered) * 100) : 0;

  const downloadCsv = () => {
    const rows = [
      ['point', 'kind', 'assigned', 'checked_in', 'capacity'],
      ...r.pickups.map((p) => [p.name ?? 'Point', KIND_LABEL[p.kind] ?? p.kind, String(p.assigned), String(p.checked_in), p.capacity == null ? '' : String(p.capacity)]),
    ];
    const csv = rows.map((row) => row.map((c) => (/[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `sponsor-points-${event.join_code}.csv`;
    a.click();
  };

  const downloadJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    a.download = `sponsor-report-${event.join_code}-${r.generated_at.slice(0, 10)}.json`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <div className="hp-no-print space-y-4">
        <SponsorIdentity eventId={event.id} sponsor={r.sponsor} canEdit={canEdit} onSaved={() => void qc.invalidateQueries({ queryKey: ['sponsor-report', event.id] })} />
        {shown === 0 && (
          <Alert tone="warn">
            Nothing has been measured yet: the figures fill in once the event has run. Until then this page shows the design and the
            collection points you have planned.
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Printer size={16} />} onClick={() => window.print()}>Print / save as PDF</Button>
          <Button variant="ghost" icon={<Download size={14} />} onClick={downloadCsv}>Points (CSV)</Button>
          <Button variant="ghost" icon={<Download size={14} />} onClick={downloadJson}>Raw figures (JSON)</Button>
        </div>
      </div>

      {/* Everything below is what gets printed. */}
      <div id="hp-sponsor-report" className="space-y-6 rounded-2xl">
        <header className="border-b border-line pb-4">
          <p className="text-xs uppercase tracking-widest text-muted">Participation report</p>
          <h1 className="hp-display mt-1 text-3xl">{r.sponsor.name ? `${r.sponsor.name} × ${r.event.name}` : r.event.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {r.sponsor.campaign && <>{r.sponsor.campaign} · </>}
            {r.event.venue_name && <>{r.event.venue_name} · </>}
            {r.event.live_at ? fmtDateTime(r.event.live_at, tz) : r.event.starts_at ? fmtDateTime(r.event.starts_at, tz) : 'date to be confirmed'}
            {r.organization && <> · organised by {r.organization.name}</>}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="People in the picture" value={shown.toLocaleString()} sub={r.delivery.peak_in_position_at ? `peak at ${fmtDateTime(r.delivery.peak_in_position_at, tz)}` : 'largest simultaneous count'} tone="pixel" />
          <Stat label="Checked in on the day" value={(r.delivery.peak_checked_in || 0).toLocaleString()} sub="phones that reported" />
          <Stat label="Registered" value={r.audience.registered.toLocaleString()} sub={r.audience.waitlisted > 0 ? `${r.audience.waitlisted.toLocaleString()} on the waitlist` : 'sign-ups'} />
          <Stat label="Turned up" value={`${conversion}%`} sub="of the people who registered" tone={conversion >= 70 ? 'ok' : conversion >= 50 ? 'warn' : undefined} />
        </div>

        {photoUrl && (
          <figure>
            <img src={photoUrl} alt="The formation from the air" className="w-full rounded-xl border border-line" />
            <figcaption className="mt-2 text-xs text-muted">
              {primary?.captured_at ? `Captured ${fmtDateTime(primary.captured_at, tz)}` : 'Official photograph'}
              {primary?.width && primary.height ? ` · ${primary.width}×${primary.height}px` : ''}
            </figcaption>
          </figure>
        )}

        <Card title="What the crowd spelled out">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              {r.design?.message && <p className="hp-display text-2xl leading-tight">{r.design.message.split('\n').join(' · ')}</p>}
              <p className="mt-2 text-sm text-muted">
                {r.design
                  ? `${r.design.pixels.toLocaleString()} positions${r.design.footprint_w_m ? `, ${r.design.footprint_w_m} × ${r.design.footprint_h_m} m on the ground` : ''}${r.design.font ? `, set in ${r.design.font}` : ''}.`
                  : 'No formation has been locked for this event yet.'}
              </p>
            </div>
            {(r.briefing.dressCode?.text || (r.briefing.dressCode?.colors?.length ?? 0) > 0 || r.briefing.collect) && (
              <div className="text-sm">
                <p className="text-xs uppercase tracking-widest text-muted">What participants were asked to do</p>
                {r.briefing.dressCode?.text && <p className="mt-1">{r.briefing.dressCode.text}</p>}
                {(r.briefing.dressCode?.colors?.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {r.briefing.dressCode!.colors!.map((c, i) => (
                      <span key={`${c}-${i}`} className="h-6 w-6 rounded-full border border-line" style={{ background: c }} aria-label={`Colour ${c}`} />
                    ))}
                  </div>
                )}
                {r.briefing.collect && <p className="mt-2"><span className="text-muted">Collected: </span>{r.briefing.collect}</p>}
                {r.briefing.bounty && <p className="mt-1"><span className="text-muted">After the photo: </span>{r.briefing.bounty}</p>}
              </div>
            )}
          </div>
        </Card>

        {r.pickups.length > 0 && (
          <Card title="Distribution points">
            <Table head={['Point', 'Type', 'Sent there', 'Turned up', 'Stock planned']}>
              {r.pickups.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="px-3 py-2">{p.name || 'Point'}{p.details && <span className="block text-xs text-muted">{p.details}</span>}</td>
                  <td className="px-3 py-2 text-muted">{KIND_LABEL[p.kind] ?? p.kind}</td>
                  <td className="hp-digits px-3 py-2">{p.assigned.toLocaleString()}</td>
                  <td className="hp-digits px-3 py-2">{p.checked_in.toLocaleString()}</td>
                  <td className="hp-digits px-3 py-2 text-muted">{p.capacity == null ? '—' : p.capacity.toLocaleString()}</td>
                </tr>
              ))}
            </Table>
            <p className="mt-3 text-xs text-muted">
              Each participant was sent to one point so the queues and the stock split evenly. "Turned up" counts people assigned to that
              point whose phone reported on the day — the platform does not scan the item itself, so it never claims one changed hands.
            </p>
          </Card>
        )}

        {r.curve.length > 1 && (
          <Card title="How the crowd built up">
            <AttendanceCurve curve={r.curve} tz={tz} />
          </Card>
        )}

        <Card title="How these numbers are made">
          <dl className="grid gap-3 text-sm md:grid-cols-3">
            <div><dt className="text-muted">Registered</dt><dd>Signed up and holding a position.</dd></div>
            <div><dt className="text-muted">Checked in</dt><dd>Their phone reported on the day of the event.</dd></div>
            <div><dt className="text-muted">In the picture</dt><dd>Their phone reported from inside its assigned position, within the tolerance radius, while the formation was live.</dd></div>
          </dl>
          <p className="mt-4 flex items-start gap-2 text-xs text-muted">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            Every figure comes from the event database; none is modelled or extrapolated. The headline is the largest count recorded at one
            moment, not a total across the day. Report sealed with SHA-256 <span className="hp-digits break-all">{r.sha256.slice(0, 32)}…</span>, generated {fmtDateTime(r.generated_at, tz)}.
          </p>
        </Card>
      </div>
    </div>
  );
}

/** Who the report is for. Kept on this page because it is where the question comes up. */
function SponsorIdentity({ eventId, sponsor, canEdit, onSaved }: { eventId: string; sponsor: { name?: string; campaign?: string }; canEdit: boolean; onSaved: () => void }) {
  const [name, setName] = useState(sponsor.name ?? '');
  const [campaign, setCampaign] = useState(sponsor.campaign ?? '');
  const dirty = name !== (sponsor.name ?? '') || campaign !== (sponsor.campaign ?? '');
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('events').update({ sponsor: { name: name.trim() || undefined, campaign: campaign.trim() || undefined } }).eq('id', eventId);
      if (error) throw new Error(error.message);
    },
    onSuccess: onSaved,
  });
  return (
    <Card title="Who this report is for">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label="Sponsor"><Input disabled={!canEdit} maxLength={120} placeholder="e.g. Chang Beer" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Campaign (optional)"><Input disabled={!canEdit} maxLength={120} placeholder="e.g. Full Moon 2026" value={campaign} onChange={(e) => setCampaign(e.target.value)} /></Field>
        <Button variant="primary" disabled={!canEdit || !dirty} busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
      {save.error && <div className="mt-3"><Alert tone="bad">{(save.error as Error).message}</Alert></div>}
    </Card>
  );
}

/** Check-ins and people in position over time: the shape of the build-up, without a chart library. */
function AttendanceCurve({ curve, tz }: { curve: { at: string; checked_in: number; in_position: number }[]; tz: string }) {
  const W = 800;
  const H = 180;
  const max = Math.max(1, ...curve.map((c) => Math.max(c.checked_in, c.in_position)));
  const t0 = new Date(curve[0]!.at).getTime();
  const t1 = new Date(curve[curve.length - 1]!.at).getTime();
  const span = Math.max(1, t1 - t0);
  const path = (key: 'checked_in' | 'in_position') =>
    curve
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${((new Date(c.at).getTime() - t0) / span) * W} ${H - (c[key] / max) * H}`)
      .join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Attendance over time">
        <path d={path('checked_in')} fill="none" stroke="var(--hp-line)" strokeWidth={3} />
        <path d={path('in_position')} fill="none" stroke="var(--hp-pixel)" strokeWidth={3} />
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-pixel" /> In the picture (peak {max.toLocaleString()})</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-line" /> Checked in</span>
        <span>{fmtDateTime(curve[0]!.at, tz)} → {fmtDateTime(curve[curve.length - 1]!.at, tz)}</span>
      </div>
    </div>
  );
}
