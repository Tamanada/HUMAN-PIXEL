import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banner, Button, Eyebrow, Field, PixelMark, Screen, inputClass } from '../components/ui';
import { ApiError, getEventPreview, getMyProfile, joinEvent, type EventPreview, type Profile } from '../lib/api';
import { BriefingCard } from '../components/Briefing';
import { ProfileForm } from '../components/ProfileForm';
import { flagEmoji } from '@human-pixel/core';
import { formatEventDate, formatEventTime, useOnline, useSession } from '../lib/hooks';
import { rememberEvent } from '../lib/storage';
import { supabase } from '../lib/supabase';

type Step = 'loading' | 'preview' | 'email' | 'otp' | 'profile' | 'consent' | 'joining' | 'error';

export function Join() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const online = useOnline();
  const { session, loading: sessionLoading } = useSession();
  const [preview, setPreview] = useState<EventPreview | null>(null);
  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState({ location: false, photo: false, terms: false });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [listed, setListed] = useState(false);
  const groupCode = params.get('g') ?? undefined;

  useEffect(() => {
    if (!online) return;
    let alive = true;
    getEventPreview(code)
      .then((p) => {
        if (!alive) return;
        if (!p) {
          setError('We could not find an event with this code.');
          setStep('error');
        } else {
          setPreview(p);
          setStep('preview');
        }
      })
      .catch((e: ApiError) => {
        if (!alive) return;
        setError(e.message);
        setStep('error');
      });
    return () => {
      alive = false;
    };
  }, [code, online]);

  const next = () => {
    if (!preview) return;
    if (!preview.registrationOpen) {
      setError('Registration for this event is closed.');
      return;
    }
    if (session) void afterAuth();
    else setStep('email');
  };

  /** Signed in: collect the profile once, then consent. */
  const afterAuth = async () => {
    try {
      const p = await getMyProfile();
      setProfile(p);
      setStep(p.complete ? 'consent' : 'profile');
    } catch (e) {
      setError((e as ApiError).message);
      setStep('profile');
    }
  };

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) return setError(err.message);
    setStep('otp');
  };

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: otp.trim(), type: 'email' });
    setBusy(false);
    if (err) return setError('That code is not valid or has expired.');
    await afterAuth();
  };

  const instant = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInAnonymously();
    setBusy(false);
    if (err) return setError(err.message);
    await afterAuth();
  };

  const join = async () => {
    if (!preview) return;
    setStep('joining');
    setError(null);
    try {
      const bundle = await joinEvent(code, preview.consentVersion, groupCode, listed);
      rememberEvent({ eventId: bundle.event.id, name: bundle.event.name, joinedAt: new Date().toISOString() });
      nav(`/e/${bundle.event.id}?reveal=1`, { replace: true, state: { bundle } });
    } catch (e) {
      setError((e as ApiError).message);
      setStep('consent');
    }
  };

  const allConsent = consent.location && consent.photo && consent.terms;

  if (!online && step === 'loading') {
    return (
      <Screen className="justify-center">
        <Banner tone="warn">You are offline. Joining an event needs a connection once; after that, HUMAN PIXEL works offline.</Banner>
      </Screen>
    );
  }

  return (
    <Screen>
      <header className="flex items-center gap-3">
        <Link to="/" aria-label="Home"><PixelMark size={28} /></Link>
        <span className="text-sm font-bold tracking-[0.3em]">HUMAN PIXEL</span>
      </header>

      <div className="flex flex-1 flex-col justify-center gap-8 py-10">
        {step === 'loading' || sessionLoading ? (
          <p className="text-muted">Finding your event…</p>
        ) : step === 'error' ? (
          <div className="space-y-6">
            <Banner tone="bad">{error}</Banner>
            <Button variant="ghost" onClick={() => nav('/')}>Try another code</Button>
          </div>
        ) : (
          <>
            {preview && (
              <section className="hp-rise space-y-3">
                <Eyebrow>You are invited to become a pixel</Eyebrow>
                <h1 className="hp-display text-4xl">{preview.name}</h1>
                <p className="text-muted">
                  {preview.venueName ?? 'Location revealed to participants'}
                  {preview.startsAt && (
                    <>
                      {' · '}
                      {formatEventDate(preview.startsAt, preview.timezone)} · {formatEventTime(preview.startsAt, preview.timezone)}
                    </>
                  )}
                </p>
              </section>
            )}

            {step === 'preview' && (
              <div className="space-y-4">
                <p className="text-lg">
                  Thousands of people. One secret image. You will receive one exact spot, and only the sky will see what you create together.
                </p>
                {/* What the organizer asks: seen BEFORE joining, so people come dressed right. */}
                {preview && <BriefingCard briefing={preview.briefing} />}
                {error && <Banner tone="bad">{error}</Banner>}
                <Button onClick={next} disabled={!preview?.registrationOpen}>
                  {preview?.registrationOpen ? 'Become a pixel' : 'Registration closed'}
                </Button>
              </div>
            )}

            {step === 'email' && (
              <form onSubmit={sendOtp} className="space-y-4">
                <Field label="Your email">
                  <input className={inputClass} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </Field>
                <p className="text-sm text-muted">We send a 6-digit code. No password. Your email is only used to secure your pixel and send you the final photo.</p>
                {error && <Banner tone="bad">{error}</Banner>}
                <Button type="submit" busy={busy}>Send my code</Button>
                {preview?.allowAnonymousJoin && (
                  <Button type="button" variant="ghost" onClick={instant} busy={busy}>Join instantly without email</Button>
                )}
              </form>
            )}

            {step === 'otp' && (
              <form onSubmit={verifyOtp} className="space-y-4">
                <Field label={`Code sent to ${email}`}>
                  <input
                    className={`${inputClass} hp-digits text-center text-3xl tracking-[0.5em]`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                </Field>
                {error && <Banner tone="bad">{error}</Banner>}
                <Button type="submit" busy={busy} disabled={otp.length !== 6}>Verify</Button>
                <Button type="button" variant="ghost" onClick={() => setStep('email')}>Use another email</Button>
              </form>
            )}

            {step === 'profile' && (
              <div className="space-y-4">
                <Eyebrow>About you</Eyebrow>
                <ProfileForm initial={profile} submitLabel="Continue" onSaved={(p) => (setProfile(p), setStep('consent'))} />
              </div>
            )}

            {(step === 'consent' || step === 'joining') && (
              <div className="space-y-5">
                <Eyebrow>Before you join</Eyebrow>
                <Consent checked={consent.location} onChange={(v) => setConsent({ ...consent, location: v })}>
                  My location is processed <strong>on my phone only</strong> to guide me to my pixel. Only my status (e.g. "in position") is shared with the organizer, never my coordinates.
                </Consent>
                <Consent checked={consent.photo} onChange={(v) => setConsent({ ...consent, photo: v })}>
                  I understand the event is photographed from above and the official image will be shared by the organizer.
                </Consent>
                <Consent checked={consent.terms} onChange={(v) => setConsent({ ...consent, terms: v })}>
                  I accept the participation terms and the <Link to="/privacy" className="text-pixel underline">privacy policy</Link>, and I will follow the organizer's safety instructions.
                </Consent>
                <HallChoice profile={profile} listed={listed} onChange={setListed} />
                {error && <Banner tone="bad">{error}</Banner>}
                <Button onClick={join} disabled={!allConsent} busy={step === 'joining'}>Receive my pixel</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}

function Consent({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer gap-4 rounded-2xl border border-line bg-surface p-4">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--hp-pixel)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm leading-relaxed">{children}</span>
    </label>
  );
}

/** Opt-in to the public Hall of Fame (first name + flag). Anonymous by default; under-16s cannot opt in. */
function HallChoice({ profile, listed, onChange }: { profile: Profile | null; listed: boolean; onChange: (v: boolean) => void }) {
  const minor = (profile?.age ?? 0) < 16;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted">Hall of Fame</p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onChange(false)} className={`rounded-xl border p-3 text-left text-sm ${!listed ? 'border-pixel bg-pixel/10' : 'border-line'}`}>
          <span className="block font-semibold">Stay anonymous</span>
          <span className="text-xs text-muted">Counted, never named</span>
        </button>
        <button type="button" disabled={minor} onClick={() => onChange(true)} className={`rounded-xl border p-3 text-left text-sm disabled:opacity-40 ${listed ? 'border-pixel bg-pixel/10' : 'border-line'}`}>
          <span className="block font-semibold">{profile?.first_name ?? 'My name'} {flagEmoji(profile?.nationality)}</span>
          <span className="text-xs text-muted">Show my first name and flag</span>
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">{minor ? 'Participants under 16 always stay anonymous.' : 'You can change this at any time. Your age and sex are never shown.'}</p>
    </div>
  );
}
