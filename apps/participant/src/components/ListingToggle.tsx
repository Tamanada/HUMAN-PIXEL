import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { flagEmoji } from '@human-pixel/core';
import { getMyListing, getMyProfile, setMyListing, type Profile } from '../lib/api';
import { readJson, writeJson } from '../lib/storage';

/** Per-event Hall of Fame choice, changeable at any time. */
export function ListingToggle({ eventId }: { eventId: string }) {
  const [listed, setListed] = useState<boolean | null>(() => readJson<boolean>(`listed:${eventId}`));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.onLine) return;
    void getMyListing(eventId).then((v) => (setListed(v), writeJson(`listed:${eventId}`, v))).catch(() => {});
    void getMyProfile().then(setProfile).catch(() => {});
  }, [eventId]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await setMyListing(eventId, !listed);
      setListed(v);
      writeJson(`listed:${eventId}`, v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Hall of Fame</p>
          <p className="mt-1 truncate text-sm">
            {listed ? <>Listed as <strong>{profile?.first_name ?? '…'}</strong> {flagEmoji(profile?.nationality)}</> : 'You are anonymous'}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={!!listed}
          aria-label="Show my first name and flag in the Hall of Fame"
          disabled={busy || listed === null}
          onClick={() => void toggle()}
          className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${listed ? 'bg-pixel' : 'bg-line'}`}
        >
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition ${listed ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <Link to={`/hall/${eventId}`} className="mt-3 inline-block text-xs text-pixel underline-offset-4 hover:underline">View the Hall of Fame →</Link>
    </section>
  );
}
