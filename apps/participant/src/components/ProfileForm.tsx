import { useMemo, useState, type FormEvent } from 'react';
import { SEX_OPTIONS, countryOptions } from '@human-pixel/core';
import { Banner, Button, Field, inputClass } from './ui';
import { saveMyProfile, type Profile } from '../lib/api';

/** First name, age, sex, nationality. Used at registration and in the account page. */
export function ProfileForm({ initial, submitLabel, onSaved }: { initial?: Profile | null; submitLabel: string; onSaved: (p: Profile) => void }) {
  const countries = useMemo(() => countryOptions(navigator.language), []);
  const [firstName, setFirstName] = useState(initial?.first_name ?? '');
  const [age, setAge] = useState(initial?.age != null ? String(initial.age) : '');
  const [sex, setSex] = useState(initial?.sex ?? '');
  const [nationality, setNationality] = useState(initial?.nationality ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveMyProfile({ firstName, age: Number(age), sex, nationality }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const valid = firstName.trim().length > 0 && Number(age) >= 5 && Number(age) <= 110 && sex && nationality;
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="First name">
        <input className={inputClass} value={firstName} maxLength={40} autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Age">
          <input className={`${inputClass} hp-digits`} inputMode="numeric" value={age} maxLength={3} onChange={(e) => setAge(e.target.value.replace(/\D/g, ''))} required />
        </Field>
        <Field label="Sex">
          <select className={inputClass} value={sex} onChange={(e) => setSex(e.target.value)} required>
            <option value="" disabled>Choose</option>
            {SEX_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Nationality">
        <select className={inputClass} value={nationality} onChange={(e) => setNationality(e.target.value)} required>
          <option value="" disabled>Choose your country</option>
          {countries.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
        </select>
      </Field>
      <p className="text-xs text-muted">
        Your age and sex are never shown publicly: organizers only see anonymous statistics. Your first name and flag appear in the Hall of Fame only if you choose so.
      </p>
      {error && <Banner tone="bad">{error}</Banner>}
      <Button type="submit" busy={busy} disabled={!valid}>{submitLabel}</Button>
    </form>
  );
}
