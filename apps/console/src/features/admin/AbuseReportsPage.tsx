import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { supabase, must, rpc } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import { Alert, Badge, Button, Card, Empty, Field, Modal, Select, Spinner, Table, Textarea } from '../../components/ui';
import { PageHeader, QueryError, ShortId, Td, adminKeys, errMessage, fmtNum } from './shared';

const STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'] as const;
type ReportStatus = (typeof STATUSES)[number];
type Reason = 'spam' | 'harassment' | 'unsafe_event' | 'impersonation' | 'privacy' | 'other';
const MAX_RESOLUTION = 2000;
const LIMIT = 200;

interface AbuseReport {
  id: string;
  reporter_id: string | null;
  event_id: string | null;
  org_id: string | null;
  target_user_id: string | null;
  reason: Reason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  handled_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

function statusTone(s: ReportStatus): 'bad' | 'warn' | 'ok' | 'neutral' {
  return s === 'open' ? 'bad' : s === 'reviewing' ? 'warn' : s === 'resolved' ? 'ok' : 'neutral';
}

function reasonTone(r: Reason): 'bad' | 'warn' | 'neutral' {
  return r === 'unsafe_event' || r === 'harassment' ? 'bad' : r === 'privacy' || r === 'impersonation' ? 'warn' : 'neutral';
}

export function AbuseReportsPage() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const [handling, setHandling] = useState<AbuseReport | null>(null);

  const q = useQuery({
    queryKey: adminKeys.reports(status),
    queryFn: async () =>
      must(
        await supabase
          .from('abuse_reports')
          .select('*')
          .eq('status', status)
          .order('created_at', { ascending: status === 'open' || status === 'reviewing' })
          .limit(LIMIT),
      ) as AbuseReport[],
  });

  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Abuse reports" sub="Open and reviewing reports are listed oldest first so nothing waits too long." />

      <div role="tablist" aria-label="Report status" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition ${
              status === s ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <Card padded={false}>
        {q.isPending ? (
          <Spinner label="Loading reports" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<Flag size={24} />} title={`No ${status} reports`}>
              {status === 'open' ? 'Nothing needs attention right now.' : undefined}
            </Empty>
          </div>
        ) : (
          <>
            <Table head={['Reported', 'Reason', 'Details', 'Subject', 'Status', <span className="sr-only">Actions</span>]}>
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td className="whitespace-nowrap text-xs text-muted" title={r.created_at}>
                    {fmtRelative(r.created_at)}
                    <div>
                      <span className="text-muted">by </span>
                      <ShortId id={r.reporter_id} />
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={reasonTone(r.reason)}>{r.reason.replace(/_/g, ' ')}</Badge>
                  </Td>
                  <Td className="max-w-md">
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">{r.details || <span className="text-muted">No details</span>}</p>
                    {r.resolution && (
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted">
                        <span className="font-semibold uppercase tracking-wider">Resolution:</span> {r.resolution}
                      </p>
                    )}
                  </Td>
                  <Td className="text-xs">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      {r.event_id && (
                        <>
                          <dt className="text-muted">event</dt>
                          <dd><ShortId id={r.event_id} /></dd>
                        </>
                      )}
                      {r.org_id && (
                        <>
                          <dt className="text-muted">org</dt>
                          <dd><ShortId id={r.org_id} /></dd>
                        </>
                      )}
                      {r.target_user_id && (
                        <>
                          <dt className="text-muted">user</dt>
                          <dd><ShortId id={r.target_user_id} /></dd>
                        </>
                      )}
                    </dl>
                    {!r.event_id && !r.org_id && !r.target_user_id && <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    {r.resolved_at && <div className="mt-1 text-[11px] text-muted" title={r.resolved_at}>{fmtRelative(r.resolved_at)}</div>}
                  </Td>
                  <Td>
                    <div className="flex justify-end">
                      <Button size="sm" variant={r.status === 'open' ? 'primary' : 'ghost'} onClick={() => setHandling(r)} aria-label={`Handle report ${r.id}`}>
                        {r.status === 'open' || r.status === 'reviewing' ? 'Handle' : 'Reopen / edit'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            {rows.length === LIMIT && (
              <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing the first {fmtNum(LIMIT)} reports.</p>
            )}
          </>
        )}
      </Card>

      {handling && <ResolveModal key={handling.id} report={handling} onClose={() => setHandling(null)} />}
    </div>
  );
}

function ResolveModal({ report, onClose }: { report: AbuseReport; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ReportStatus>(report.status === 'open' ? 'reviewing' : report.status);
  const [resolution, setResolution] = useState(report.resolution ?? '');
  const needsResolution = status === 'resolved' || status === 'dismissed';
  const trimmed = resolution.trim();
  const invalid = (needsResolution && trimmed.length === 0) || resolution.length > MAX_RESOLUTION;

  const mutation = useMutation({
    mutationFn: () =>
      rpc<null>('admin_resolve_report', { p_report_id: report.id, p_status: status, p_resolution: trimmed || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: adminKeys.reportsAll });
      await qc.invalidateQueries({ queryKey: adminKeys.health });
      onClose();
    },
  });

  const safeClose = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Modal
      open
      onClose={safeClose}
      title="Handle abuse report"
      footer={
        <>
          <Button variant="ghost" onClick={safeClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" busy={mutation.isPending} disabled={invalid} onClick={() => mutation.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={reasonTone(report.reason)}>{report.reason.replace(/_/g, ' ')}</Badge>
            <span className="text-xs text-muted">{fmtRelative(report.created_at)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words">{report.details || <span className="text-muted">No details provided.</span>}</p>
        </div>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={needsResolution ? 'Resolution (required)' : 'Notes'}
          hint={
            <span className={resolution.length > MAX_RESOLUTION ? 'text-bad' : ''}>
              {resolution.length.toLocaleString()} / {MAX_RESOLUTION.toLocaleString()}
            </span>
          }
        >
          <Textarea
            rows={5}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="What was done, and why. Visible to other admins."
          />
        </Field>
        {mutation.isError && <Alert tone="bad">{errMessage(mutation.error)}</Alert>}
      </div>
    </Modal>
  );
}
