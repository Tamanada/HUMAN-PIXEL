/**
 * What the organizer asks of the participant: what to wear, what to bring, what to collect and
 * where, and the bounty after the photo. The collection point is personal: everyone is sent to a
 * different tent so the queues (and the stock) split evenly.
 */
import type { Briefing as BriefingData, PickupPoint } from '@human-pixel/core';
import { formatEventDate, formatEventTime } from '../lib/hooks';
import { Eyebrow } from './ui';

export function BriefingCard({ briefing }: { briefing?: BriefingData | null }) {
  // Bundles cached on the phone before this feature existed have no briefing at all.
  const b = briefing ?? {};
  const dress = b.dressCode?.text?.trim();
  const colors = b.dressCode?.colors ?? [];
  const rows: [string, string][] = [
    ['Bring', b.bring?.trim() ?? ''],
    ['Collect', b.collect?.trim() ?? ''],
    ['After the photo', b.bounty?.trim() ?? ''],
  ];
  const hasRows = rows.some(([, v]) => v);
  if (!dress && colors.length === 0 && !hasRows) return null;
  return (
    <section className="space-y-3 rounded-3xl border border-line bg-surface p-5">
      <Eyebrow>Before you come</Eyebrow>
      {(dress || colors.length > 0) && (
        <div>
          <p className="text-lg">{dress || 'Dress code'}</p>
          {colors.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {colors.map((c, i) => (
                <span key={`${c}-${i}`} className="h-7 w-7 rounded-full border border-line" style={{ background: c }} aria-label={`Colour ${c}`} />
              ))}
            </div>
          )}
        </div>
      )}
      {rows.map(([label, value]) =>
        value ? (
          <p key={label} className="text-sm">
            <span className="text-muted">{label}: </span>
            {value}
          </p>
        ) : null,
      )}
    </section>
  );
}

const KIND_TITLE: Record<PickupPoint extends null ? never : NonNullable<PickupPoint>['kind'], string> = {
  collection: 'Your collection point',
  control: 'Your check-in point',
  bounty: 'Your bounty point',
};

export function PickupCard({ pickup, timezone }: { pickup: NonNullable<PickupPoint>; timezone: string }) {
  const opens = pickup.opens_at ? new Date(pickup.opens_at) : null;
  const closes = pickup.closes_at ? new Date(pickup.closes_at) : null;
  return (
    <section className="space-y-3 rounded-3xl border border-line bg-surface p-5">
      <Eyebrow>{KIND_TITLE[pickup.kind]}</Eyebrow>
      <p className="hp-display text-2xl">{pickup.name || 'Pickup point'}</p>
      {pickup.details && <p className="text-sm">{pickup.details}</p>}
      {(opens || closes) && (
        <p className="text-sm text-muted">
          {opens && closes
            ? `Open ${formatEventTime(pickup.opens_at!, timezone)} – ${formatEventTime(pickup.closes_at!, timezone)}, ${formatEventDate(pickup.closes_at!, timezone)}`
            : opens
              ? `Opens ${formatEventTime(pickup.opens_at!, timezone)}, ${formatEventDate(pickup.opens_at!, timezone)}`
              : `Closes ${formatEventTime(pickup.closes_at!, timezone)}, ${formatEventDate(pickup.closes_at!, timezone)}`}
        </p>
      )}
      <a
        className="inline-block rounded-xl border border-line px-4 py-2 text-sm"
        href={`https://www.google.com/maps/search/?api=1&query=${pickup.lat},${pickup.lng}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in maps
      </a>
      <p className="text-xs text-muted">This point is yours: going to another one may leave you waiting, or without stock.</p>
    </section>
  );
}
