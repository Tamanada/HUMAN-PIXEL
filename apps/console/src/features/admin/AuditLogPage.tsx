import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { supabase, must } from '../../lib/supabase';
import { fmtRelative } from '../../lib/time';
import { Badge, Button, Card, Empty, Input, Select, Spinner, Table } from '../../components/ui';
import { PageHeader, QueryError, ShortId, Td, adminKeys, fmtNum, useDebounced } from './shared';

const LIMIT = 200;
const PRESETS = ['event.', 'admin.', 'formation.', 'privacy.', 'scheduler.'] as const;
const CUSTOM = '__custom__';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  org_id: string | null;
  event_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Json;
}

/** Escape LIKE wildcards so a user-typed prefix is matched literally. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function actionTone(action: string): 'neutral' | 'pixel' | 'warn' | 'bad' {
  if (action.startsWith('admin.')) return 'pixel';
  if (action.startsWith('privacy.')) return 'warn';
  if (action.endsWith('.error')) return 'bad';
  return 'neutral';
}

function hasDetails(d: Json): boolean {
  if (d === null) return false;
  if (typeof d === 'object') return Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0;
  return true;
}

export function AuditLogPage() {
  const [preset, setPreset] = useState('');
  const [customInput, setCustomInput] = useState('');
  const custom = useDebounced(customInput.trim(), 300);
  const prefix = preset === CUSTOM ? custom : preset;
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const q = useQuery({
    queryKey: adminKeys.audit(prefix),
    queryFn: async () => {
      let query = supabase
        .from('audit_logs')
        .select('id, at, actor_id, org_id, event_id, action, target_type, target_id, details')
        .order('at', { ascending: false })
        .limit(LIMIT);
      if (prefix) query = query.like('action', likePrefix(prefix));
      return must(await query) as AuditRow[];
    },
  });

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        sub={`Latest ${LIMIT} entries, newest first. Append-only.`}
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} busy={q.isFetching} onClick={() => void q.refetch()}>
            Refresh
          </Button>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <label className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Action</span>
            <Select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-48">
              <option value="">All actions</option>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}*
                </option>
              ))}
              <option value={CUSTOM}>Custom prefix…</option>
            </Select>
          </label>
          {preset === CUSTOM && (
            <label className="w-full max-w-xs">
              <span className="sr-only">Custom action prefix</span>
              <Input value={customInput} onChange={(e) => setCustomInput(e.target.value)} placeholder="e.g. event.state" className="hp-digits" autoFocus />
            </label>
          )}
          {q.data && <span className="hp-digits ml-auto text-xs text-muted">{fmtNum(rows.length)} entries</span>}
        </div>

        {q.isPending ? (
          <Spinner label="Loading audit log" />
        ) : q.isError ? (
          <div className="p-4">
            <QueryError error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty icon={<ScrollText size={24} />} title="No audit entries">
              {prefix ? `No actions start with “${prefix}”.` : undefined}
            </Empty>
          </div>
        ) : (
          <Table head={[<span className="sr-only">Expand</span>, 'When', 'Action', 'Actor', 'Target', 'Org', 'Event']}>
            {rows.map((r) => {
              const open = expanded.has(r.id);
              const expandable = hasDetails(r.details);
              return (
                <Fragment key={r.id}>
                  <tr className={open ? 'bg-surface-2' : ''}>
                    <Td className="w-8 pr-0">
                      {expandable && (
                        <button
                          type="button"
                          onClick={() => toggle(r.id)}
                          aria-expanded={open}
                          aria-controls={`audit-details-${r.id}`}
                          aria-label={`${open ? 'Hide' : 'Show'} details for ${r.action}`}
                          className="text-muted hover:text-text"
                        >
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted" title={r.at}>
                      {fmtRelative(r.at)}
                    </Td>
                    <Td>
                      <Badge tone={actionTone(r.action)}>{r.action}</Badge>
                    </Td>
                    <Td>{r.actor_id ? <ShortId id={r.actor_id} /> : <span className="text-xs text-muted">system</span>}</Td>
                    <Td className="text-xs">
                      {r.target_type ? (
                        <span>
                          <span className="text-muted">{r.target_type}</span> <ShortId id={r.target_id} />
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <ShortId id={r.org_id} />
                    </Td>
                    <Td>
                      <ShortId id={r.event_id} />
                    </Td>
                  </tr>
                  {open && (
                    <tr id={`audit-details-${r.id}`} className="bg-surface-2">
                      <td colSpan={7} className="px-4 pb-3">
                        <pre className="hp-digits max-h-80 overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-relaxed">
                          {JSON.stringify(r.details, null, 2)}
                        </pre>
                        <p className="mt-1.5 text-[11px] text-muted">
                          #{r.id} · {new Date(r.at).toISOString()}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
