import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { joinCodeSchema } from '@human-pixel/core';
import { Button, Eyebrow, PixelMark, Screen, inputClass } from '../components/ui';
import { joinedEvents } from '../lib/storage';

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** Extracts an event code from a scanned QR payload (full link or bare code). */
export function codeFromQr(raw: string): string | null {
  const m = raw.match(/\/j\/([A-Za-z0-9]{6,10})/);
  const candidate = m?.[1] ?? raw.trim();
  const parsed = joinCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function Home() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const events = joinedEvents();
  const canScan = typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = joinCodeSchema.safeParse(code);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid code');
    nav(`/j/${parsed.data}`);
  };

  return (
    <Screen className="justify-between">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <PixelMark size={28} />
          <span className="text-sm font-bold tracking-[0.3em]">HUMAN PIXEL</span>
        </div>
        <Link to="/account" className="text-sm text-muted underline-offset-4 hover:underline">Account</Link>
      </header>

      <section className="py-10">
        <div className="hp-rise mb-10"><PixelMark size={96} /></div>
        <h1 className="hp-display hp-rise text-5xl" style={{ animationDelay: '0.1s' }}>
          You are<br />one pixel.
        </h1>
        <p className="hp-rise mt-5 max-w-xs text-lg text-muted" style={{ animationDelay: '0.25s' }}>
          Together, thousands of people become the message. You won't know what you're creating, only where you belong.
        </p>
      </section>

      <section className="space-y-4">
        {events.length > 0 && (
          <div className="space-y-2">
            <Eyebrow>Your events</Eyebrow>
            {events.map((e) => (
              <Link key={e.eventId} to={`/e/${e.eventId}`} className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-4">
                <span className="font-semibold">{e.name}</span>
                <span className="text-pixel">Open →</span>
              </Link>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="code" className="block text-xs font-semibold uppercase tracking-[0.2em] text-muted">Event code</label>
          <input
            id="code"
            className={`${inputClass} hp-digits text-center text-2xl uppercase tracking-[0.3em]`}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
              setError(null);
            }}
            placeholder="ABCD2345"
            autoCapitalize="characters"
            autoComplete="off"
            inputMode="text"
            aria-invalid={!!error}
          />
          {error && <p className="text-sm text-bad">{error}</p>}
          <Button type="submit" disabled={code.length < 6}>Join event</Button>
          {canScan && (
            <Button type="button" variant="ghost" onClick={() => setScanning(true)}>Scan QR code</Button>
          )}
        </form>
        <p className="text-center text-xs text-muted">
          <Link to="/privacy" className="underline-offset-4 hover:underline">Privacy</Link> · Your location never leaves your phone.
        </p>
      </section>
      {scanning && <QrScanner onCode={(c) => nav(`/j/${c}`)} onClose={() => setScanning(false)} />}
    </Screen>
  );
}

function QrScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const BD = (globalThis as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = new BD({ formats: ['qr_code'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const codes = await detector.detect(video.current).catch(() => []);
          const hit = codes.map((c) => codeFromQr(c.rawValue)).find(Boolean);
          if (hit) return onCode(hit);
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setErr('Camera unavailable. Type the code instead.');
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <video ref={video} className="h-full w-full object-cover" playsInline muted />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-64 w-64 rounded-3xl border-2 border-pixel hp-glow" />
      </div>
      {err && <p className="absolute inset-x-6 top-1/3 rounded-xl bg-surface p-4 text-center text-bad">{err}</p>}
      <div className="hp-safe absolute inset-x-0 bottom-0">
        <Button variant="ghost" onClick={onClose} className="bg-black/60">Close</Button>
      </div>
    </div>
  );
}
