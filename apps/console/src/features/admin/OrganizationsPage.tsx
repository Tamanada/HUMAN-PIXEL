import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Pencil, Search } from 'lucide-react';
import { rpc } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, Table } from '../../components/ui';
import { PageHeader, QueryError, Td, adminKeys, errMessage, fmtNum, useDebounced } from './shared';

type Plan = 'free' | 'pro' | 'enterprise';
type OrgStatus = 'active' | 'suspended';

interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  plan: string | null;
  max_participants_per_event: number | null;
  max_active_events: number | null;
  members: number;
  events: number;
  created_at: string;
}

const PLANS: Plan[] = ['free', 'pro', 'enterprise'];
const PLAN_PRESETS: Record<Plan, { maxParticipants: number; maxEvents: number }> = {
  free: { maxParticipants: 1000, maxEvents: 1 },
  pro: { maxParticipants: 15000, maxEvents: 5 },
  enterprise: { maxParticipants: 250000, maxEvents: 100 },
};
const MAX_PARTICIPANTS = 250000;
const MAX_EVENTS = 10000;

function isPlan(p: string | null): p is Plan {
  return p !== null && (PLANS as string[]).includes(p);
}

function planTone(p: string | null): 'neutral' | 'pixel' | 'ok' {
  return p === 'enterprise' ? 'pixel' : p === 'pro' ? 'ok' : 'neutral';
}

export function OrganizationsPage() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput.trim(), 300);
  const [editing, setEditing] = useState<AdminOrgRow | null>(null);

  const q = useQuery({
    queryKey: adminKeys.orgs(search),
    queryFn: () => rpc<AdminOrgRow[]>('admin_list_organizations', { p_search: search || null }),
  });
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Organizations" sub="Plans, limits and suspension. Showing up to 200, newest first." />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <label className="relative w-full max-w-sm">
            <span className="sr-only">Search organizations by name or slug</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search name or slug" className="pl-9" />
          </label>
          {q.isFetching && !q.isPending && <span className="text-xs text-muted">Updating…</span>}
        </div>

        {q.isPending ? (
          <Spinner label="Loading organizations" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<Building2 size={24} />} title={search ? 'No matching organizations' : 'No organizations yet'} />
          </div>
        ) : (
          <Table head={['Organization', 'Status', 'Plan', 'Max / event', 'Max active', 'Members', 'Events', 'Created', <span className="sr-only">Actions</span>]}>
            {rows.map((o) => (
              <tr key={o.id}>
                <Td>
                  <div className="flex flex-col">
                    <span className="font-medium">{o.name}</span>
                    <span className="hp-digits text-xs text-muted">{o.slug}</span>
                  </div>
                </Td>
                <Td>{o.status === 'suspended' ? <Badge tone="bad">suspended</Badge> : <Badge tone="ok">active</Badge>}</Td>
                <Td>{o.plan ? <Badge tone={planTone(o.plan)}>{o.plan}</Badge> : <span className="text-xs text-muted">default</span>}</Td>
                <Td className="hp-digits">{fmtNum(o.max_participants_per_event)}</Td>
                <Td className="hp-digits">{fmtNum(o.max_active_events)}</Td>
                <Td className="hp-digits">{fmtNum(Number(o.members))}</Td>
                <Td className="hp-digits">{fmtNum(Number(o.events))}</Td>
                <Td className="text-xs text-muted" title={o.created_at}>{fmtRelative(o.created_at)}</Td>
                <Td>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(o)} aria-label={`Edit ${o.name}`}>
                      Edit
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && <EditOrgModal key={editing.id} org={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditOrgModal({ org, onClose }: { org: AdminOrgRow; onClose: () => void }) {
  const qc = useQueryClient();
  const initialPlan: Plan = isPlan(org.plan) ? org.plan : 'free';
  const [status, setStatus] = useState<OrgStatus>(org.status);
  const [plan, setPlan] = useState<Plan>(initialPlan);
  const [maxParticipants, setMaxParticipants] = useState(String(org.max_participants_per_event ?? PLAN_PRESETS[initialPlan].maxParticipants));
  const [maxEvents, setMaxEvents] = useState(String(org.max_active_events ?? PLAN_PRESETS[initialPlan].maxEvents));
  const [validation, setValidation] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (v: { status: OrgStatus; plan: Plan; maxParticipants: number; maxEvents: number }) =>
      rpc<null>('admin_set_organization', {
        p_org_id: org.id,
        p_status: v.status,
        p_plan: v.plan,
        p_max_participants: v.maxParticipants,
        p_max_events: v.maxEvents,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: adminKeys.orgsAll });
      onClose();
    },
  });

  const onPlanChange = (p: Plan) => {
    setPlan(p);
    setMaxParticipants(String(PLAN_PRESETS[p].maxParticipants));
    setMaxEvents(String(PLAN_PRESETS[p].maxEvents));
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const mp = Number(maxParticipants);
    const me = Number(maxEvents);
    if (!Number.isInteger(mp) || mp < 1 || mp > MAX_PARTICIPANTS) {
      setValidation(`Max participants per event must be a whole number between 1 and ${MAX_PARTICIPANTS.toLocaleString()}.`);
      return;
    }
    if (!Number.isInteger(me) || me < 1 || me > MAX_EVENTS) {
      setValidation(`Max active events must be a whole number between 1 and ${MAX_EVENTS.toLocaleString()}.`);
      return;
    }
    setValidation(null);
    mutation.mutate({ status, plan, maxParticipants: mp, maxEvents: me });
  };

  const safeClose = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Modal
      open
      onClose={safeClose}
      title={`Edit ${org.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={safeClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" busy={mutation.isPending} onClick={() => submit()}>
            Save changes
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as OrgStatus)}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
          </Field>
          <Field label="Plan" hint="Changing the plan prefills its limits.">
            <Select value={plan} onChange={(e) => onPlanChange(e.target.value as Plan)}>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p} ({PLAN_PRESETS[p].maxParticipants.toLocaleString()} / {PLAN_PRESETS[p].maxEvents})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Max participants per event" hint={`1 – ${MAX_PARTICIPANTS.toLocaleString()}`}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_PARTICIPANTS}
              step={1}
              value={maxParticipants}
              onChange={(e) => setMaxParticipants(e.target.value)}
              className="hp-digits"
            />
          </Field>
          <Field label="Max active events">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_EVENTS}
              step={1}
              value={maxEvents}
              onChange={(e) => setMaxEvents(e.target.value)}
              className="hp-digits"
            />
          </Field>
        </div>
        {status === 'suspended' && org.status !== 'suspended' && (
          <Alert tone="warn">Suspending blocks new participant joins and state changes on this organization's events, and hides its events from the public.</Alert>
        )}
        {validation && <Alert tone="bad">{validation}</Alert>}
        {mutation.isError && <Alert tone="bad">{errMessage(mutation.error)}</Alert>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
