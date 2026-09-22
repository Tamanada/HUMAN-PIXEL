import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { countryName, flagEmoji } from '@human-pixel/core';
import { Banner, Button, Eyebrow, PixelMark, Screen } from '../components/ui';
import { getHallOfFame, type HallOfFame as Hall } from '../lib/api';
import { formatEventDate } from '../lib/hooks';

/**
 * Public Hall of Fame: first name + nationality of the participants who chose to be listed.
 * Everyone else is counted, never named. No positions, no ages, no pixel numbers.
 */
export function HallOfFame() {
  const { eventId = '' } = useParams();
  const [hall, setHall] = useState<Hall | null>(null);
  const [people, setPeople] = useState<Hall['people']>([]);
  const [country, setCountry] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getHallOfFame(eventId, 0, country)
      .then((h) => {
        if (!alive) return;
        setHall(h);
        setPeople(h?.people ?? []);
        setMore((h?.people.length ?? 0) === 200);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [eventId, country]);

  const loadMore = async () => {
    const h = await getHallOfFame(eventId, people.length, country);
    if (!h) return;
    setPeople((p) => [...p, ...h.people]);
    setMore(h.people.length === 200);
  };

  if (error) return <Screen className="justify-center"><Banner tone="bad">{error}</Banner></Screen>;
  if (!loading && !hall) return <Screen className="justify-center"><Banner>This Hall of Fame is not available.</Banner></Screen>;
  const anonymous = Math.max(0, (hall?.participants ?? 0) - (hall?.listed ?? 0));

  return (
    <Screen className="gap-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3"><PixelMark size={24} /><span className="text-sm font-bold tracking-[0.3em]">HUMAN PIXEL</span></Link>
      </header>
      {hall && (
        <section className="hp-rise space-y-2">
          <Eyebrow>Hall of Fame</Eyebrow>
          <h1 className="hp-display text-4xl">{hall.event.name}</h1>
          <p className="text-muted">{hall.event.venueName ?? ''}{hall.event.startsAt ? ` · ${formatEventDate(hall.event.startsAt, hall.event.timezone)}` : ''}</p>
          <div className="grid grid-cols-3 gap-2 pt-3 text-center">
            <Stat value={(hall.participants ?? 0).toLocaleString()} label="pixels" />
            <Stat value={hall.countries.toLocaleString()} label="countries" />
            <Stat value={anonymous.toLocaleString()} label="anonymous" />
          </div>
        </section>
      )}
      {hall && hall.byNationality.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip active={country === null} onClick={() => setCountry(null)}>All</Chip>
          {hall.byNationality.map((n) => (
            <Chip key={n.code} active={country === n.code} onClick={() => setCountry(n.code)}>
              {flagEmoji(n.code)} <span className="hp-digits">{n.count}</span>
            </Chip>
          ))}
        </div>
      )}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : people.length === 0 ? (
        <Banner>No one has chosen to appear here yet{country ? ` for ${countryName(country)}` : ''}.</Banner>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {people.map((p, i) => (
            <li key={i} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5" title={p.nationality ? countryName(p.nationality) : undefined}>
              <span className="text-lg" aria-hidden="true">{flagEmoji(p.nationality)}</span>
              <span className="truncate font-medium">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
      {more && <Button variant="ghost" onClick={() => void loadMore()}>Show more</Button>}
      <p className="pb-4 text-center text-xs text-muted">Only people who chose to be listed appear here. Everyone else was part of the image, anonymously.</p>
    </Screen>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <p className="hp-digits text-2xl font-bold text-pixel">{value}</p>
      <p className="text-[11px] uppercase tracking-[0.2em] text-muted">{label}</p>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${active ? 'border-pixel bg-pixel/10 text-text' : 'border-line text-muted'}`}>
      {children}
    </button>
  );
}
