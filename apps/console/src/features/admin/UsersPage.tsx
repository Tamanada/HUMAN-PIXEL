import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { rpc } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/time';
import { Alert, Badge, Button, Card, Empty, Input, Modal, Spinner, Table } from '../../components/ui';
import { PageHeader, QueryError, ShortId, Td, adminKeys, errMessage, fmtNum, useDebounced } from './shared';

const PAGE_SIZE = 50;

interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  platform_role: 'user' | 'admin' | null;
  is_suspended: boolean | null;
  organizations: number;
  events_joined: number;
}

type PendingAction = { user: AdminUserRow; kind: 'role' | 'suspend' };

function nextState(a: PendingAction): { role: 'user' | 'admin'; suspended: boolean } {
  const role = a.user.platform_role ?? 'user';
  const suspended = a.user.is_suspended ?? false;
  return a.kind === 'role' ? { role: role === 'admin' ? 'user' : 'admin', suspended } : { role, suspended: !suspended };
}

export function UsersPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput.trim(), 300);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // Reset to the first page whenever the effective search changes.
  const [lastSearch, setLastSearch] = useState(search);
  if (lastSearch !== search) {
    setLastSearch(search);
    setPage(0);
  }

  const q = useQuery({
    queryKey: adminKeys.users(search, page),
    queryFn: () =>
      rpc<AdminUserRow[]>('admin_list_users', { p_search: search || null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const mutation = useMutation({
    mutationFn: (a: PendingAction) => {
      const s = nextState(a);
      return rpc<null>('admin_set_user', { p_user_id: a.user.id, p_role: s.role, p_suspended: s.suspended });
    },
    onSuccess: async () => {
      setPending(null);
      await qc.invalidateQueries({ queryKey: adminKeys.usersAll });
    },
  });

  const rows = q.data ?? [];
  const hasNext = rows.length === PAGE_SIZE;

  const close = () => {
    if (mutation.isPending) return;
    setPending(null);
    mutation.reset();
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Users" sub="All accounts on the platform. Role and suspension changes are audited." />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <label className="relative w-full max-w-sm">
            <span className="sr-only">Search users by email or id</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search email or exact user id"
              className="pl-9"
            />
          </label>
          {q.isFetching && !q.isPending && <span className="text-xs text-muted">Updating…</span>}
        </div>

        {q.isPending ? (
          <Spinner label="Loading users" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<Users size={24} />} title={search ? 'No matching users' : 'No users yet'}>
              {search ? `Nothing matches “${search}”.` : undefined}
            </Empty>
          </div>
        ) : (
          <Table head={['User', 'Role', 'Status', 'Orgs', 'Events', 'Created', 'Last sign-in', <span className="sr-only">Actions</span>]}>
            {rows.map((u) => {
              const isSelf = u.id === profile?.id;
              const isAdmin = u.platform_role === 'admin';
              const suspended = u.is_suspended === true;
              return (
                <tr key={u.id} className={suspended ? 'opacity-70' : ''}>
                  <Td>
                    <div className="flex flex-col">
                      <span className="truncate font-medium">
                        {u.email ?? <span className="text-muted">(no email · anonymous)</span>}
                        {isSelf && <span className="ml-2 text-xs text-pixel">you</span>}
                      </span>
                      <ShortId id={u.id} />
                    </div>
                  </Td>
                  <Td>{isAdmin ? <Badge tone="pixel">admin</Badge> : <Badge>user</Badge>}</Td>
                  <Td>{suspended ? <Badge tone="bad">suspended</Badge> : <Badge tone="ok">active</Badge>}</Td>
                  <Td className="hp-digits">{fmtNum(Number(u.organizations))}</Td>
                  <Td className="hp-digits">{fmtNum(Number(u.events_joined))}</Td>
                  <Td className="text-xs text-muted" title={u.created_at}>{fmtRelative(u.created_at)}</Td>
                  <Td className="text-xs text-muted" title={u.last_sign_in_at ?? undefined}>{fmtRelative(u.last_sign_in_at)}</Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isSelf}
                        title={isSelf ? 'You cannot change your own role' : undefined}
                        onClick={() => setPending({ user: u, kind: 'role' })}
                        aria-label={`${isAdmin ? 'Revoke admin from' : 'Make admin'} ${u.email ?? u.id}`}
                      >
                        {isAdmin ? 'Revoke admin' : 'Make admin'}
                      </Button>
                      <Button
                        size="sm"
                        variant={suspended ? 'secondary' : 'danger'}
                        disabled={isSelf}
                        title={isSelf ? 'You cannot suspend yourself' : undefined}
                        onClick={() => setPending({ user: u, kind: 'suspend' })}
                        aria-label={`${suspended ? 'Unsuspend' : 'Suspend'} ${u.email ?? u.id}`}
                      >
                        {suspended ? 'Unsuspend' : 'Suspend'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-xs text-muted">
          <span className="hp-digits">
            {rows.length > 0 ? `${fmtNum(page * PAGE_SIZE + 1)}–${fmtNum(page * PAGE_SIZE + rows.length)}` : '0'} · page {page + 1}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
            <Button size="sm" variant="ghost" disabled={!hasNext || q.isFetching} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Card>

      <Modal
        open={pending !== null}
        onClose={close}
        title={pending ? confirmTitle(pending) : ''}
        footer={
          pending && (
            <>
              <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button
                variant={isDestructive(pending) ? 'danger' : 'primary'}
                busy={mutation.isPending}
                onClick={() => mutation.mutate(pending)}
              >
                Confirm
              </Button>
            </>
          )
        }
      >
        {pending && (
          <div className="space-y-3 text-sm">
            <p>
              <span className="text-muted">Account:</span> <span className="font-medium">{pending.user.email ?? pending.user.id}</span>
            </p>
            <p className="text-muted">{confirmBody(pending)}</p>
            {mutation.isError && <Alert tone="bad">{errMessage(mutation.error)}</Alert>}
          </div>
        )}
      </Modal>
    </div>
  );
}

function isDestructive(a: PendingAction): boolean {
  const s = nextState(a);
  return a.kind === 'suspend' ? s.suspended : s.role === 'user';
}

function confirmTitle(a: PendingAction): string {
  const s = nextState(a);
  if (a.kind === 'role') return s.role === 'admin' ? 'Grant platform admin?' : 'Revoke platform admin?';
  return s.suspended ? 'Suspend account?' : 'Unsuspend account?';
}

function confirmBody(a: PendingAction): string {
  const s = nextState(a);
  if (a.kind === 'role') {
    return s.role === 'admin'
      ? 'This user will get full access to every organization, event, user and platform setting.'
      : 'This user will lose platform administration access immediately.';
  }
  return s.suspended
    ? 'The user will be blocked from joining events and using the console until unsuspended.'
    : 'The user will regain normal access to the platform.';
}
