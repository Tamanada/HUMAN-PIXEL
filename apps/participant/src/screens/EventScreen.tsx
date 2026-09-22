import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { compassPoint, countdown, formatDistance, type AssignmentBundle } from '@human-pixel/core';
import { useEngine, useServerNow } from '../engine/useEngine';
import type { EngineSnapshot, ParticipantEngine } from '../engine/ParticipantEngine';
import { Banner, Button, Eyebrow, PixelMark, Screen, StatusPill } from '../components/ui';
import { DirectionArrow, Radar } from '../components/Radar';
import { CountdownClock, FinalCountdown, primeAudio } from '../components/Countdown';
import { formatClock, formatEventDate, formatEventTime, useSunlight } from '../lib/hooks';
import { openExternalDirections, requestCompass, requestGeolocation } from '../lib/platform';

export function EventScreen() {
  const { eventId = '' } = useParams();
  const location = useLocation();
  const initial = (location.state as { bundle?: AssignmentBundle } | null)?.bundle;
  const { engine, snap } = useEngine(eventId, initial);
  const now = useServerNow(engine, 4);
  const [params, setParams] = useSearchParams();
  const [sun, setSun] = useSunlight();
  const reveal = params.get('reveal') === '1';

  if (!snap.bundle) {
    return (
      <Screen className="items-center justify-center gap-6 text-center">
        <PixelMark size={64} />
        {snap.error ? <Banner tone="bad">{snap.error}</Banner> : <p className="text-muted">{snap.online ? 'Loading your pixel…' : 'Offline. Connect once to download your pixel.'}</p>}
        <Link to="/" className="text-sm text-muted underline">Home</Link>
      </Screen>
    );
  }

  if (reveal) return <Reveal bundle={snap.bundle} onDone={() => setParams({}, { replace: true })} />;

  const b = snap.bundle;
  const cfg = b.event.countdown;
  const startsAt = snap.startsAt;
  const cd = startsAt != null ? countdown(startsAt, now, { finalWindowMs: cfg.finalSeconds * 1000 }) : null;
  const showFinal = cd && (cd.phase === 'final' || (cd.phase === 'live' && -cd.remainingMs < 60_000)) && b.member.status === 'registered';

  return (
    <Screen className="gap-6">
      {showFinal && startsAt != null && <FinalCountdown startsAt={startsAt} now={now} cfg={cfg} />}
      <header className="flex items-center justify-between gap-3">
        <Link to="/" className="flex min-w-0 items-center gap-3" aria-label="Home">
          <PixelMark size={24} />
          <span className="truncate text-sm font-semibold">{b.event.name}</span>
        </Link>
        <div className="flex items-center gap-2">
          <button onClick={() => setSun(!sun)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted" aria-pressed={sun}>
            {sun ? 'Night' : 'Sunlight'}
          </button>
          <Link to="/account" className="rounded-full border border-line px-3 py-1.5 text-xs text-muted">Me</Link>
        </div>
      </header>

      {!snap.online && <Banner>Offline: everything you need is on your phone. Updates sync when you reconnect.</Banner>}
      {snap.manifest?.announcement && <Banner tone="warn">{snap.manifest.announcement}</Banner>}

      <PhaseView engine={engine} snap={snap} now={now} />
    </Screen>
  );
}

function PhaseView({ engine, snap, now }: { engine: ParticipantEngine; snap: EngineSnapshot; now: number }) {
  const b = snap.bundle!;
  const nav = useNavigate();
  const tz = b.event.timezone;

  if (snap.phase === 'cancelled') {
    return <Banner tone="bad">This event has been cancelled by the organizer. Thank you for being ready to take part.</Banner>;
  }
  if (b.member.status === 'waitlisted') {
    return (
      <section className="space-y-4">
        <Eyebrow>Standby</Eyebrow>
        <h1 className="hp-display text-4xl">You are on<br />the waitlist</h1>
        <p className="text-muted">
          All pixels are taken for now. If someone cancels or does not show up, a pixel is released to you automatically.
          On the event day, come to the venue: people on site get released pixels first.
        </p>
        <p className="hp-digits text-muted">Participant #{b.member.participant_number}</p>
        {snap.startsAt != null && <CountdownClock startsAt={snap.startsAt} now={now} />}
      </section>
    );
  }
  if (snap.phase === 'photo') {
    return (
      <section className="space-y-6 py-6 text-center">
        <Eyebrow>It's here</Eyebrow>
        <h1 className="hp-display text-5xl">Now you can see<br />what you created.</h1>
        <Button onClick={() => nav(`/e/${b.event.id}/photo`)}>Reveal the photo</Button>
      </section>
    );
  }
  if (snap.phase === 'waiting_photo' || (snap.phase === 'live' && snap.startsAt != null && now - snap.startsAt > 60_000) || snap.phase === 'ended') {
    return (
      <section className="space-y-5 py-8 text-center">
        <div className="mx-auto h-5 w-5 rounded bg-pixel hp-glow hp-breathe" />
        <h1 className="hp-display text-4xl">You were<br />the message.</h1>
        <p className="text-muted">
          The image is being developed. You will see it right here as soon as the organizer releases it.
        </p>
        <PixelCard snap={snap} compact />
      </section>
    );
  }

  const pixel = b.pixel;
  return (
    <>
      <PixelCard snap={snap} />
      {!pixel ? (
        <Banner>Your pixel will be assigned when the organizer finalizes the formation. You don't need to do anything.</Banner>
      ) : !pixel.released ? (
        <section className="space-y-4 rounded-3xl border border-line bg-surface p-5">
          <Eyebrow>Your exact position</Eyebrow>
          <p className="text-lg">
            Unlocks {b.event.positions_release_at ? <>at <strong>{formatEventTime(b.event.positions_release_at, tz, true)}</strong></> : 'on the event day'}.
            Keep this app installed: once unlocked, it is saved on your phone and works without internet.
          </p>
        </section>
      ) : (
        <Navigation engine={engine} snap={snap} now={now} />
      )}
      {snap.startsAt != null && !snap.tracker?.inPosition && <CountdownClock startsAt={snap.startsAt} now={now} />}
      <p className="text-center text-xs text-muted">
        {snap.pendingReport ? 'Status will sync when possible' : 'Status synced'} · clock ±{Math.round(snap.clock?.uncertaintyMs ?? 999)} ms
      </p>
    </>
  );
}

function PixelCard({ snap, compact = false }: { snap: EngineSnapshot; compact?: boolean }) {
  const b = snap.bundle!;
  const tz = b.event.timezone;
  return (
    <section className="rounded-3xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between">
        <div>
          <Eyebrow>Your pixel</Eyebrow>
          <p className="hp-digits mt-1 text-5xl font-bold text-pixel">#{b.pixel?.label ?? '····'}</p>
        </div>
        {b.pixel && (
          <div className="text-right">
            <Eyebrow>Zone</Eyebrow>
            <p className="hp-display mt-1 text-5xl">{b.pixel.zone}</p>
          </div>
        )}
      </div>
      {!compact && (
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm">
          <div>
            <dt className="text-muted">Arrive before</dt>
            <dd className="hp-digits text-lg font-semibold">{formatEventTime(b.event.arrival_deadline, tz)}</dd>
          </div>
          <div>
            <dt className="text-muted">Formation starts</dt>
            <dd className="hp-digits text-lg font-semibold">{formatEventTime(snap.startsAt ?? b.event.starts_at, tz)}</dd>
          </div>
          <div>
            <dt className="text-muted">Date</dt>
            <dd className="font-semibold">{formatEventDate(b.event.starts_at, tz)}</dd>
          </div>
          <div>
            <dt className="text-muted">Participant</dt>
            <dd className="hp-digits text-lg font-semibold">#{b.member.participant_number}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function Navigation({ engine, snap, now }: { engine: ParticipantEngine; snap: EngineSnapshot; now: number }) {
  const b = snap.bundle!;
  const [compassAsked, setCompassAsked] = useState(false);
  const ev = snap.tracker?.evaluation;
  const target = b.pixel!.target!;

  useEffect(() => {
    if (snap.navigating && snap.heading == null && !compassAsked) {
      // Android grants orientation silently; iOS needs the button below.
      engine.enableCompass();
    }
  }, [snap.navigating, snap.heading, compassAsked, engine]);

  if (!snap.navigating) {
    return (
      <section className="space-y-4">
        <Button
          onClick={async () => {
            primeAudio();
            const p = await requestGeolocation();
            if (p === 'denied') return;
            setCompassAsked(true);
            if (await requestCompass()) engine.enableCompass();
            await engine.startNavigation();
          }}
        >
          Navigate to my pixel
        </Button>
        {snap.gpsPermission === 'denied' && (
          <Banner tone="bad">Location is blocked. Allow location for HUMAN PIXEL in your phone settings to find your pixel.</Banner>
        )}
      </section>
    );
  }

  const status = snap.tracker?.gpsLost ? 'NO_FIX' : ev?.status ?? 'NO_FIX';
  const inPosition = snap.tracker?.inPosition ?? false;
  const ready = snap.participantState === 'READY';

  if (inPosition) {
    return (
      <section className="space-y-5 text-center" aria-live="polite">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl bg-ok/15">
          <div className="h-10 w-10 rounded-lg bg-ok hp-breathe" style={{ boxShadow: '0 0 30px var(--hp-ok)' }} />
        </div>
        <h1 className="hp-display text-4xl text-ok">You are<br />in position</h1>
        <p className="text-lg">Hold your position.</p>
        <p className="hp-digits text-5xl font-bold">{formatClock(now, b.event.timezone)}</p>
        {snap.startsAt != null && <CountdownClock startsAt={snap.startsAt} now={now} />}
        {!ready ? (
          <Button onClick={() => engine.tapReady()}>I'm ready</Button>
        ) : (
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-ok">Ready ✓</p>
        )}
        <p className="text-xs text-muted">±{Math.round(ev?.accuracy ?? 0)} m GPS · keep the screen on, phone in hand</p>
      </section>
    );
  }

  return (
    <section className="space-y-5 text-center">
      <StatusPill status={status} detail={ev && Number.isFinite(ev.accuracy) ? `±${Math.round(ev.accuracy)} m` : undefined} />
      {ev && Number.isFinite(ev.distance) ? (
        <div>
          <p className="hp-digits text-7xl font-bold">{formatDistance(ev.distance)}</p>
          <div className="mt-3 flex items-center justify-center gap-3 text-muted">
            <DirectionArrow bearing={ev.bearing} heading={snap.heading} size={36} />
            <span>{snap.heading != null ? 'Follow the arrow' : `Walk ${compassPoint(ev.bearing)} (${Math.round(ev.bearing)}°)`}</span>
          </div>
        </div>
      ) : (
        <p className="text-muted">{snap.gpsError ?? 'Getting your position… step into open sky.'}</p>
      )}
      {ev && Number.isFinite(ev.distance) && (
        <Radar
          distance={ev.distance}
          bearing={ev.bearing}
          heading={snap.heading}
          accuracy={ev.accuracy}
          radius={b.event.tolerance_radius_m}
          inPosition={false}
          size={Math.min(320, window.innerWidth - 48)}
        />
      )}
      {status === 'GPS_LOW' && (
        <Banner tone="bad">GPS accuracy is too low (±{Math.round(ev?.accuracy ?? 0)} m, need ±{b.event.required_accuracy_m} m). Hold the phone flat, away from your body, under open sky.</Banner>
      )}
      {ev && ev.distance > 300 && (
        <Button variant="ghost" onClick={() => openExternalDirections(target.lat, target.lng)}>Walking directions (maps app)</Button>
      )}
      {snap.heading == null && (
        <button
          className="text-sm text-muted underline"
          onClick={async () => {
            if (await requestCompass()) engine.enableCompass();
          }}
        >
          Enable compass
        </button>
      )}
    </section>
  );
}

function Reveal({ bundle, onDone }: { bundle: AssignmentBundle; onDone: () => void }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t = [setTimeout(() => setStage(1), 900), setTimeout(() => setStage(2), 2200)];
    return () => t.forEach(clearTimeout);
  }, []);
  const tz = bundle.event.timezone;
  return (
    <Screen className="items-center justify-center gap-8 text-center">
      <div className="hp-rise"><PixelMark size={120} lit={Math.abs(bundle.pixel?.label ?? 12) % 25} /></div>
      <h1 className="hp-display hp-rise text-5xl">You are<br /><span className="text-pixel">a pixel</span></h1>
      {stage >= 1 && (
        <div className="hp-rise space-y-1">
          <p className="hp-digits text-6xl font-bold">#{bundle.pixel?.label ?? '····'}</p>
          {bundle.pixel && <p className="text-lg text-muted">Zone {bundle.pixel.zone}</p>}
          {!bundle.pixel && <p className="text-muted">{bundle.member.status === 'waitlisted' ? 'You are on the waitlist' : 'Your pixel is being prepared'}</p>}
        </div>
      )}
      {stage >= 2 && (
        <div className="hp-rise w-full space-y-6">
          <p className="text-muted">
            {formatEventDate(bundle.event.starts_at, tz)} · Formation at {formatEventTime(bundle.event.starts_at, tz)}
          </p>
          <p className="text-sm text-muted">You don't know what you are creating. You only know where you belong.</p>
          <Button onClick={onDone}>Continue</Button>
        </div>
      )}
    </Screen>
  );
}
