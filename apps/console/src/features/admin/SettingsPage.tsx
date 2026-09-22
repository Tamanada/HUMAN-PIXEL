import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Settings2 } from 'lucide-react';
import { supabase, must, rpc } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Spinner, Table, Textarea, Toggle } from '../../components/ui';
import { PageHeader, QueryError, Td, adminKeys, errMessage } from './shared';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

interface PlatformSetting {
  key: string;
  value: Json;
  is_public: boolean;
  updated_at: string;
}

const KEY_RE = /^[a-z0-9_.]{2,64}$/;
const REGISTRATION_KEY = 'registration_enabled';

type ParseResult = { ok: true; value: Json } | { ok: false; error: string };

function parseJson(text: string): ParseResult {
  if (!text.trim()) return { ok: false, error: 'Value is required. Use valid JSON, e.g. true, 42, "text" or {"a": 1}.' };
  try {
    const value = JSON.parse(text) as Json;
    // PostgREST maps a top-level JSON null argument to SQL NULL, which the NOT NULL column rejects.
    if (value === null) return { ok: false, error: 'A bare null cannot be stored. Use false, "" or {} to clear a setting.' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${errMessage(e)}` };
  }
}

function preview(v: Json): string {
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export function SettingsPage() {
  const [editing, setEditing] = useState<PlatformSetting | 'new' | null>(null);

  const q = useQuery({
    queryKey: adminKeys.settings,
    queryFn: async () =>
      must(await supabase.from('platform_settings').select('key, value, is_public, updated_at').order('key')) as PlatformSetting[],
  });
  const rows = q.data ?? [];
  const registration = rows.find((r) => r.key === REGISTRATION_KEY);
  const registrationOff = registration !== undefined && registration.value === false;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Platform settings"
        sub="Global configuration stored as JSON. Public settings are readable by participant apps without signing in."
        actions={
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            Add setting
          </Button>
        }
      />

      <Alert tone={registrationOff ? 'bad' : 'warn'}>
        {registrationOff ? (
          <>
            <strong className="uppercase tracking-wider">Registrations are disabled platform-wide.</strong> <code className="hp-digits">{REGISTRATION_KEY}</code> is{' '}
            <code className="hp-digits">false</code>: nobody can join any event until it is set back to <code className="hp-digits">true</code>.
          </>
        ) : (
          <>
            <strong className="uppercase tracking-wider">Caution:</strong> setting <code className="hp-digits">{REGISTRATION_KEY}</code> to{' '}
            <code className="hp-digits">false</code> immediately stops all joins on every event, platform-wide.
          </>
        )}
      </Alert>

      <Card padded={false}>
        {q.isPending ? (
          <Spinner label="Loading settings" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<Settings2 size={24} />} title="No settings defined" />
          </div>
        ) : (
          <Table head={['Key', 'Value', 'Visibility', 'Updated', <span className="sr-only">Actions</span>]}>
            {rows.map((s) => (
              <tr key={s.key} className={s.key === REGISTRATION_KEY && registrationOff ? 'bg-bad/5' : ''}>
                <Td className="hp-digits text-xs font-semibold">{s.key}</Td>
                <Td>
                  <code className="hp-digits break-all text-xs" title={JSON.stringify(s.value)}>
                    {preview(s.value)}
                  </code>
                </Td>
                <Td>{s.is_public ? <Badge tone="warn">public</Badge> : <Badge>private</Badge>}</Td>
                <Td className="text-xs text-muted" title={s.updated_at}>{fmtRelative(s.updated_at)}</Td>
                <Td>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(s)} aria-label={`Edit ${s.key}`}>
                      Edit
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <EditSettingModal
          key={editing === 'new' ? '__new__' : editing.key}
          setting={editing === 'new' ? null : editing}
          existingKeys={rows.map((r) => r.key)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EditSettingModal({ setting, existingKeys, onClose }: { setting: PlatformSetting | null; existingKeys: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = setting === null;
  const [key, setKey] = useState(setting?.key ?? '');
  const [text, setText] = useState(setting ? JSON.stringify(setting.value, null, 2) : '');
  const [isPublic, setIsPublic] = useState(setting?.is_public ?? false);
  const [touched, setTouched] = useState(false);

  const parsed = parseJson(text);
  const keyError = !isNew
    ? null
    : !KEY_RE.test(key)
      ? 'Key must be 2–64 characters: lowercase letters, digits, "_" or ".".'
      : existingKeys.includes(key)
        ? 'This key already exists. Edit it from the list instead.'
        : null;
  const effectiveKey = setting?.key ?? key;
  const disablesRegistration = effectiveKey === REGISTRATION_KEY && parsed.ok && parsed.value === false;

  const mutation = useMutation({
    mutationFn: (value: Json) => rpc<null>('admin_set_setting', { p_key: effectiveKey, p_value: value, p_is_public: isPublic }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: adminKeys.settings });
      onClose();
    },
  });

  const save = () => {
    setTouched(true);
    if (!parsed.ok || keyError) return;
    mutation.mutate(parsed.value);
  };

  const format = () => {
    if (parsed.ok) setText(JSON.stringify(parsed.value, null, 2));
  };

  const safeClose = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Modal
      open
      onClose={safeClose}
      title={isNew ? 'Add platform setting' : <span className="hp-digits">{setting.key}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={safeClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant={disablesRegistration ? 'danger' : 'primary'}
            busy={mutation.isPending}
            disabled={touched && (!parsed.ok || keyError !== null)}
            onClick={save}
          >
            {disablesRegistration ? 'Disable all registrations' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isNew && (
          <Field label="Key" hint={touched && keyError ? <span className="text-bad">{keyError}</span> : 'e.g. health.report_rate_high'}>
            <Input value={key} onChange={(e) => setKey(e.target.value.trim())} className="hp-digits" autoFocus spellCheck={false} />
          </Field>
        )}

        <Field
          label="Value (JSON)"
          hint={
            parsed.ok ? (
              <span className="flex items-center justify-between gap-2">
                <span className="text-ok">Valid JSON · {Array.isArray(parsed.value) ? 'array' : typeof parsed.value}</span>
                <button type="button" onClick={format} className="text-muted underline-offset-2 hover:text-text hover:underline">
                  Format
                </button>
              </span>
            ) : (
              <span className="text-bad">{parsed.error}</span>
            )
          }
        >
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="hp-digits text-xs leading-relaxed"
            spellCheck={false}
            aria-invalid={!parsed.ok}
          />
        </Field>

        <Toggle checked={isPublic} onChange={setIsPublic} label="Public (readable without authentication)" />
        {isPublic && !setting?.is_public && (
          <Alert tone="warn">This value will be exposed to anyone, including unauthenticated participant apps. Never make secrets public.</Alert>
        )}

        {effectiveKey === REGISTRATION_KEY && (
          <Alert tone={disablesRegistration ? 'bad' : 'warn'}>
            <strong className="uppercase tracking-wider">Platform-wide switch.</strong> <code className="hp-digits">false</code> stops all joins on every
            event immediately, including events that are live right now. Use <code className="hp-digits">true</code> to re-enable.
          </Alert>
        )}

        {mutation.isError && <Alert tone="bad">{errMessage(mutation.error)}</Alert>}
      </div>
    </Modal>
  );
}
