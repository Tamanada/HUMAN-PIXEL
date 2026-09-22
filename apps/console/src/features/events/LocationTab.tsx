import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Crosshair, PenLine, Trash2 } from 'lucide-react';
import { surfaceCapacity } from '@human-pixel/core';
import { Alert, Badge, Button, Card, Field, Input, Toggle } from '../../components/ui';
import { AREA_STYLE, MapView, type DrawMode, type EditMode } from '../../components/MapView';
import { rpc, supabase } from '../../lib/supabase';
import type { AreaRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { constraintsFromAreas } from './formationClient';
import { useAreas } from './hooks';

const TOOLS: { kind: AreaRow['kind']; shape: 'polygon' | 'point'; help: string }[] = [
  { kind: 'perimeter', shape: 'polygon', help: 'The whole event ground. Required. Every pixel must be inside.' },
  { kind: 'formation_area', shape: 'polygon', help: 'Optional: restricts where the formation may be placed. Never shown to participants.' },
  { kind: 'exclusion', shape: 'polygon', help: 'Obstacles (rocks, trees, water, buildings). No pixel inside or within the safety buffer.' },
  { kind: 'no_go', shape: 'polygon', help: 'Restricted areas participants must not enter. Excluded from the formation.' },
  { kind: 'emergency', shape: 'polygon', help: 'Emergency corridors that must stay clear. Excluded from the formation.' },
  { kind: 'assembly', shape: 'polygon', help: 'Where people gather before walking to their pixel.' },
  { kind: 'entry_zone', shape: 'polygon', help: 'Participant entry areas.' },
  { kind: 'access_point', shape: 'point', help: 'Entrances, first aid, staff points.' },
];

export function LocationTab({ event, canEdit }: TabProps) {
  const areas = useAreas(event.id);
  const qc = useQueryClient();
  const [tool, setTool] = useState<(typeof TOOLS)[number] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [placingCenter, setPlacingCenter] = useState(false);
  const locked = !!event.active_formation_id;
  const frozenKinds = new Set(['perimeter', 'formation_area', 'exclusion', 'no_go', 'emergency']);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['areas', event.id] });
  };
  const save = useMutation({
    mutationFn: (a: { kind: AreaRow['kind']; geom: GeoJSON.Geometry; name?: string | null; buffer?: number; isPublic?: boolean | null; id?: string | null }) =>
      rpc<string>('save_event_area', {
        p_event_id: event.id,
        p_kind: a.kind,
        p_geojson: a.geom,
        p_name: a.name ?? null,
        p_safety_buffer_m: a.buffer ?? (a.kind === 'exclusion' ? 2 : 0),
        p_is_public: a.isPublic ?? null,
        p_area_id: a.id ?? null,
      }),
    onSuccess: (id) => {
      setSelected(id);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('event_areas').delete().eq('id', id);
      if (error) throw new Error(error.message.includes('FORMATION_LOCKED') ? 'Frozen while a formation is locked.' : error.message);
    },
    onSuccess: () => {
      setSelected(null);
      invalidate();
    },
  });
  const setCenter = useMutation({
    mutationFn: async (p: { lat: number; lng: number }) => {
      const { error } = await supabase.from('events').update({ center_lat: p.lat, center_lng: p.lng }).eq('id', event.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setPlacingCenter(false);
      void qc.invalidateQueries({ queryKey: ['event', event.id] });
    },
  });

  const draw: DrawMode = useMemo(
    () =>
      tool
        ? { kind: tool.shape, color: AREA_STYLE[tool.kind].color, onDone: (geom) => (save.mutate({ kind: tool.kind, geom }), setTool(null)), onCancel: () => setTool(null) }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool],
  );
  const onMapClick = useCallback((p: { lat: number; lng: number }) => placingCenter && setCenter.mutate(p), [placingCenter, setCenter]);
  const sel = (areas.data ?? []).find((a) => a.id === selected) ?? null;
  const editing = (areas.data ?? []).find((a) => a.id === editingId && a.geom.type === 'Polygon') ?? null;
  const edit: EditMode = useMemo(
    () =>
      editing
        ? {
            geom: editing.geom as GeoJSON.Polygon,
            color: AREA_STYLE[editing.kind].color,
            busy: save.isPending,
            onSave: (geom) =>
              save.mutate(
                { kind: editing.kind, geom, id: editing.id, name: editing.name, buffer: editing.safety_buffer_m, isPublic: editing.is_public },
                { onSuccess: () => setEditingId(null) },
              ),
            onCancel: () => setEditingId(null),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing?.id, editing?.geom, save.isPending],
  );
  const error = save.error ?? remove.error ?? setCenter.error;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        <MapView
          areas={(areas.data ?? []).filter((a) => a.id !== editingId)}
          edit={edit}
          center={event.center_lat != null ? { lat: event.center_lat, lng: event.center_lng! } : null}
          draw={draw}
          selectedAreaId={selected}
          onAreaClick={setSelected}
          onMapClick={onMapClick}
          height={620}
          defaultSatellite
          message={error ? (error as Error).message.replace(/^INVALID_GEOMETRY: /, '').replace(/^\w/, (c) => c.toUpperCase()) : null}
          bearingKey={event.id}
        />
        {placingCenter && <Alert>Click the map to set the event center (used as the default formation anchor).</Alert>}
        {error && <Alert tone="bad">{(error as Error).message}</Alert>}
      </div>
      <div className="space-y-4">
        <SurfaceCard areas={areas.data ?? []} eventId={event.id} />
        {locked && <Alert tone="warn">A formation is locked: perimeter, formation area, exclusions, no-go and emergency zones are frozen. Access, assembly and entry areas can still change.</Alert>}
        {canEdit && (
          <Card title="Draw">
            <div className="grid gap-2">
              {TOOLS.map((t) => {
                const disabled = locked && frozenKinds.has(t.kind);
                return (
                  <button
                    key={t.kind}
                    disabled={disabled}
                    onClick={() => (setEditingId(null), setTool(tool?.kind === t.kind ? null : t))}
                    className={`flex items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-40 ${tool?.kind === t.kind ? 'border-pixel bg-pixel/10' : 'border-line hover:border-muted'}`}
                  >
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: AREA_STYLE[t.kind].color }} />
                    <span>
                      <span className="block text-sm font-medium">{AREA_STYLE[t.kind].label}</span>
                      <span className="block text-xs text-muted">{t.help}</span>
                    </span>
                  </button>
                );
              })}
              <Button variant="ghost" size="sm" icon={<Crosshair size={14} />} onClick={() => setPlacingCenter((v) => !v)}>
                {placingCenter ? 'Cancel' : 'Set event center'}
              </Button>
            </div>
          </Card>
        )}
        <Card title={`Areas (${areas.data?.length ?? 0})`} padded={false}>
          <ul className="divide-y divide-line">
            {(areas.data ?? []).map((a) => (
              <li key={a.id}>
                <button onClick={() => setSelected(a.id)} className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${a.id === selected ? 'bg-surface-2' : ''}`}>
                  <span className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: AREA_STYLE[a.kind].color }} />
                    {a.name || AREA_STYLE[a.kind].label}
                  </span>
                  <span className="hp-digits text-xs text-muted">{a.area_m2 ? `${Math.round(a.area_m2).toLocaleString()} m²` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {sel && <AreaEditor key={sel.id} area={sel} canEdit={canEdit && !(locked && frozenKinds.has(sel.kind))} editing={editingId === sel.id} onEditShape={() => (setTool(null), setEditingId(sel.id))} onSave={(p) => save.mutate({ ...p, kind: sel.kind, geom: sel.geom, id: sel.id })} onDelete={() => remove.mutate(sel.id)} busy={save.isPending || remove.isPending} />}
      </div>
    </div>
  );
}

/** First number of the plan: what the ground can hold. The formation step turns it into a head count. */
function SurfaceCard({ areas, eventId }: { areas: AreaRow[]; eventId: string }) {
  const cap = useMemo(() => surfaceCapacity(constraintsFromAreas(areas)), [areas]);
  if (!cap) {
    return <Alert>Draw the perimeter: the console then shows how many people the surface can hold.</Alert>;
  }
  const at13 = cap.bySpacing.find((b) => b.spacingM === 1.3)?.people ?? 0;
  return (
    <Card title="What this surface holds">
      <p className="hp-digits text-2xl">{Math.round(cap.usableAreaM2).toLocaleString()} m²</p>
      <p className="mb-3 text-xs text-muted">usable, after exclusions and their safety buffers</p>
      <dl className="space-y-1 text-sm">
        {cap.bySpacing.map((b) => (
          <div key={b.spacingM} className="flex justify-between border-b border-line py-1">
            <dt className="text-muted">Filled solid at {b.spacingM} m</dt>
            <dd className="hp-digits">{b.people.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        A message only covers part of its surface (letters and gaps): typically 25–45 %, so about{' '}
        <span className="hp-digits text-text">{Math.round(at13 * 0.25).toLocaleString()}–{Math.round(at13 * 0.45).toLocaleString()}</span> people at 1.3 m.
        The exact number comes from the design in <Link to={`/events/${eventId}/formation`} className="text-pixel underline">Formation</Link>.
      </p>
    </Card>
  );
}

function AreaEditor({ area, canEdit, editing, onEditShape, onSave, onDelete, busy }: { area: AreaRow; canEdit: boolean; editing: boolean; onEditShape: () => void; onSave: (p: { name: string | null; buffer: number; isPublic: boolean }) => void; onDelete: () => void; busy: boolean }) {
  const [name, setName] = useState(area.name ?? '');
  const [buffer, setBuffer] = useState(area.safety_buffer_m);
  const [pub, setPub] = useState(area.is_public);
  const bufferMatters = ['exclusion', 'no_go', 'emergency'].includes(area.kind);
  return (
    <Card title={<span className="flex items-center gap-2">{AREA_STYLE[area.kind].label} {!area.is_public && <Badge>private</Badge>}</span>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} /></Field>
        {bufferMatters && (
          <Field label="Safety buffer (m)" hint="Pixels are kept at least this far from the zone.">
            <Input type="number" min={0} max={200} step={0.5} value={buffer} disabled={!canEdit} onChange={(e) => setBuffer(Number(e.target.value))} />
          </Field>
        )}
        {area.kind !== 'formation_area' && <Toggle checked={pub} onChange={setPub} label="Shown to participants" />}
        {canEdit && area.geom.type === 'Polygon' && (
          <Button variant="ghost" size="sm" icon={<PenLine size={14} />} disabled={editing} onClick={onEditShape}>
            {editing ? 'Editing on the map…' : 'Edit shape (move corners)'}
          </Button>
        )}
        {canEdit && (
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDelete} disabled={busy}>Delete</Button>
            <Button variant="primary" size="sm" busy={busy} onClick={() => onSave({ name: name || null, buffer, isPublic: pub })}>Save</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
