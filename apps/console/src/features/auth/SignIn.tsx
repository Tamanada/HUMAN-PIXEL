import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, PixelMark } from '../../components/ui';
import { supabase } from '../../lib/supabase';

/** Passwordless sign-in (email one-time code): no organizer passwords to leak or reuse. */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) setError(err.message);
    else setSent(true);
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (err) setError('Invalid or expired code.');
  };

  return (
    <div className="grid min-h-full md:grid-cols-2">
      <div className="relative hidden overflow-hidden border-r border-line bg-surface md:block">
        <PixelField />
        <div className="absolute bottom-10 left-10 max-w-sm">
          <p className="hp-display text-4xl leading-tight">The server coordinates the event.<br /><span className="text-pixel">The phone executes the experience.</span></p>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center gap-3">
            <PixelMark size={32} />
            <div>
              <p className="text-sm font-bold tracking-[0.28em]">HUMAN PIXEL</p>
              <p className="text-xs text-muted">Organizer console</p>
            </div>
          </div>
          {!sent ? (
            <form onSubmit={send} className="space-y-4">
              <Field label="Work email">
                <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@organization.com" />
              </Field>
              {error && <Alert tone="bad">{error}</Alert>}
              <Button variant="primary" className="w-full" busy={busy} type="submit">Send sign-in code</Button>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <Field label={`6-digit code sent to ${email}`}>
                <Input className="hp-digits text-center text-xl tracking-[0.5em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
              </Field>
              {error && <Alert tone="bad">{error}</Alert>}
              <Button variant="primary" className="w-full" busy={busy} type="submit" disabled={code.length !== 6}>Sign in</Button>
              <Button variant="ghost" className="w-full" type="button" onClick={() => setSent(false)}>Use another email</Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/** Decorative crowd of dim pixels with a few lit ones. */
function PixelField() {
  const cells = Array.from({ length: 22 * 30 }, (_, i) => i);
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 440 600" aria-hidden="true">
      {cells.map((i) => {
        const x = (i % 22) * 20 + 4;
        const y = Math.floor(i / 22) * 20 + 4;
        const lit = (i * 7919) % 97 === 0;
        return <rect key={i} x={x} y={y} width="12" height="12" rx="2.5" fill={lit ? 'var(--hp-pixel)' : 'var(--hp-line)'} opacity={lit ? 1 : 0.55} />;
      })}
    </svg>
  );
}
