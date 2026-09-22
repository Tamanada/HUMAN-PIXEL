import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Banner, Button, Eyebrow, PixelMark, Screen } from '../components/ui';
import { cancelParticipation } from '../lib/api';
import { config } from '../lib/config';
import { useSession, useSunlight } from '../lib/hooks';
import { forgetEvent, joinedEvents, removeKeys } from '../lib/storage';
import { supabase } from '../lib/supabase';

export function Account() {
  const nav = useNavigate();
  const { session } = useSession();
  const [sun, setSun] = useSunlight();
  const [events, setEvents] = useState(joinedEvents());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const cancel = async (eventId: string) => {
    if (!window.confirm('Give up your pixel for this event? It will go to someone on the waitlist.')) return;
    setBusy(eventId);
    try {
      await cancelParticipation(eventId);
      forgetEvent(eventId);
      setEvents(joinedEvents());
      setMsg({ tone: 'info', text: 'Your participation was cancelled.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy('delete');
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch(`${config.supabaseUrl}/functions/v1/account-delete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${data.session?.access_token}`, apikey: config.supabaseAnonKey },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Deletion failed');
      removeKeys(() => true);
      await supabase.auth.signOut();
      nav('/', { replace: true });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
      setBusy(null);
    }
  };

  return (
    <Screen className="gap-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3"><PixelMark size={24} /><span className="text-sm font-bold tracking-[0.3em]">HUMAN PIXEL</span></Link>
      </header>
      <section className="space-y-2">
        <Eyebrow>Signed in as</Eyebrow>
        <p className="text-lg font-semibold">{session ? session.user.email ?? 'Guest (no email)' : 'Not signed in'}</p>
      </section>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <section className="space-y-3">
        <Eyebrow>Display</Eyebrow>
        <Button variant="ghost" onClick={() => setSun(!sun)}>{sun ? 'Switch to night mode' : 'Switch to sunlight mode (high contrast)'}</Button>
      </section>
      {events.length > 0 && (
        <section className="space-y-3">
          <Eyebrow>Your events</Eyebrow>
          {events.map((e) => (
            <div key={e.eventId} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
              <Link to={`/e/${e.eventId}`} className="font-semibold">{e.name}</Link>
              <button className="text-sm text-bad" disabled={busy === e.eventId} onClick={() => cancel(e.eventId)}>Cancel</button>
            </div>
          ))}
        </section>
      )}
      <section className="mt-auto space-y-3">
        <Link to="/privacy" className="block text-center text-sm text-muted underline">Privacy policy</Link>
        {session && <Button variant="ghost" onClick={() => supabase.auth.signOut().then(() => nav('/'))}>Sign out</Button>}
        {session && !confirmDelete && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete my account</Button>}
        {confirmDelete && (
          <div className="space-y-3 rounded-2xl border border-bad/40 p-4">
            <p className="text-sm">
              This permanently deletes your account. Upcoming pixels are released; past participation stays in event statistics without any link to you.
            </p>
            <Button variant="danger" busy={busy === 'delete'} onClick={deleteAccount}>Yes, delete everything</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep my account</Button>
          </div>
        )}
      </section>
    </Screen>
  );
}
