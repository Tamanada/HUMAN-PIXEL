import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Stat, Table } from '../../components/ui';
import { canManage, useAuth, type OrgRole } from '../../lib/auth';
import { must, rpc, supabase } from '../../lib/supabase';

interface MemberRow {
  user_id: string;
  role: OrgRole;
  created_at: string;
}

export function OrgSettings() {
  const { orgId = '' } = useParams();
  const { memberships, isAdmin, session } = useAuth();
  const me = memberships.find((m) => m.org_id === orgId);
  const manage = canManage(me, isAdmin);
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');

  const org = useQuery({
    queryKey: ['org', orgId],
    queryFn: async () => must(await supabase.from('organizations').select('id, name, slug, status, contact_email, created_at').eq('id', orgId).single()),
  });
  const sub = useQuery({
    queryKey: ['org-sub', orgId],
    queryFn: async () => must(await supabase.from('organization_subscriptions').select('*').eq('org_id', orgId).maybeSingle()),
  });
  const members = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: async () => must(await supabase.from('organization_members').select('user_id, role, created_at').eq('org_id', orgId)) as MemberRow[],
  });

  const add = useMutation({
    mutationFn: () => rpc('add_organization_member', { p_org_id: orgId, p_email: email, p_role: role }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['org-members', orgId] });
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => rpc('remove_organization_member', { p_org_id: orgId, p_user_id: userId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org-members', orgId] }),
  });

  if (org.isLoading) return <Spinner />;
  if (org.error) return <Alert tone="bad">{(org.error as Error).message}</Alert>;
  const o = org.data as unknown as { name: string; slug: string; status: string; contact_email: string | null };
  const s = sub.data as { plan: string; max_participants_per_event: number; max_active_events: number; status: string } | null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="hp-display text-3xl">{o.name}</h1>
        <Badge tone={o.status === 'active' ? 'ok' : 'bad'}>{o.status}</Badge>
      </div>
      {s && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Plan" value={s.plan.toUpperCase()} sub={s.status} tone="pixel" />
          <Stat label="Max participants / event" value={s.max_participants_per_event.toLocaleString()} />
          <Stat label="Max active events" value={s.max_active_events} />
        </div>
      )}
      <Card title="Team">
        {members.isLoading ? <Spinner /> : (
          <Table head={['Member', 'Role', 'Since', '']}>
            {(members.data ?? []).map((m) => (
              <tr key={m.user_id}>
                <td className="px-4 py-2.5 font-mono text-xs">{m.user_id === session?.user.id ? `${session.user.email} (you)` : m.user_id}</td>
                <td className="px-4 py-2.5"><Badge tone={m.role === 'owner' ? 'pixel' : 'neutral'}>{m.role}</Badge></td>
                <td className="px-4 py-2.5 text-muted">{new Date(m.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 text-right">
                  {manage && m.user_id !== session?.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.user_id)}>Remove</Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {manage && (
          <form
            className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Invite by email (they must have signed in once)" className="min-w-64 flex-1">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
                <option value="member">Member (view only)</option>
                <option value="admin">Admin (manage events)</option>
                <option value="owner">Owner</option>
              </Select>
            </Field>
            <Button variant="primary" type="submit" busy={add.isPending}>Add</Button>
          </form>
        )}
        {(add.error || remove.error) && <div className="mt-3"><Alert tone="bad">{((add.error ?? remove.error) as Error).message}</Alert></div>}
      </Card>
    </div>
  );
}
