import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Field, Input } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { rpc } from '../../lib/supabase';

export function Onboarding() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rpc('create_organization', { p_name: name, p_contact_email: email || null });
      refresh();
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="hp-display mb-2 text-3xl">Create your organization</h1>
      <p className="mb-8 text-muted">Organizations own events. You can invite co-organizers afterwards.</p>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Organization name"><Input required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Phangan Festivals Co." /></Field>
          <Field label="Contact email (shown on event evidence reports)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {error && <Alert tone="bad">{error}</Alert>}
          <Button variant="primary" busy={busy} type="submit">Create organization</Button>
        </form>
      </Card>
    </div>
  );
}
