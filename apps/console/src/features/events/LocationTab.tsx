import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Crosshair, ImagePlus, PenLine, Plus, Trash2 } from 'lucide-react';
import { surfaceCapacity } from '@human-pixel/core';
import { Alert, Badge, Button, Card, Field, Input, Modal, Toggle } from '../../components/ui';
import { AREA_STYLE, MapView, type DrawMode, type EditMode } from '../../components/MapView';
import { rpc, supabase } from '../../lib/supabase';
import { isoToZonedLocal, zonedLocalToIso } from '../../lib/time';
import type { AreaRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { constraintsFromAreas } from './formationClient';
import { useAreas, useEventSymbols } from './hooks';
import { KIND_DRAG_TYPE, POINT_SYMBOLS, SAFETY, SymbolPill, customSymbol, imageToPngDataUrl, symbolOf, type PointSymbol } from '../../lib/symbols';

/** A point dropped on the map but not saved yet (position and type can still change). */
const PENDING_ID = '__pending__';

/** Points that serve people: t-shirt tents, ticket checks, post-event bounty. */
const PICKUP_KINDS: { kind: AreaRow['kind']; help: string }[] = [
  { kind: 'collection', help: 'Hands out t-shirts, wristbands, drinks… Each participant is sent to ONE of them, the least loaded.' },
  { kind: 'control', help: 'Where staff check people in or scan tickets.' },
  { kind: 'bounty', help: 'Where participants claim their reward after the photo.' },
];

const TOOLS: { kind: AreaRow['kind']; shape: 'polygon' | 'point'; help: string }[] = [
  { kind: 'perimeter', shape: 'polygon', help: 'The whole event ground. Required. Every pixel must be inside.' },
  { kind: 'formation_area', shape: 'polygon', help: 'Optional: restricts where the formation may be placed. Never shown to participants.' },
  { kind: 'exclusion', shape: 'polygon', help: 'Obstacles (rocks, trees, water, buildings). No pixel inside or within the safety buffer.' },
  { kind: 'no_go', shape: 'polygon', help: 'Restricted areas participants must not enter. Excluded from the formation.' },
  { kind: 'emergency', shape: 'polygon', help: 'Emergency corridors that must stay clear. Excluded from the formation.' },
  { kind: 'assembly', shape: 'polygon', help: 'Where people gather before walking to their pixel.' },
  { kind: 'entry_zone', shape: 'polygon', help: 'Participant entry areas.' },
];

export function LocationTab({ event, canEdit }: TabProps) {
  const areas = useAreas(event.id);
  const qc = useQueryClient();
  const [tool, setTool] = useState<(typeof TOOLS)[number] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Picked in the list: the map flies there.
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Just created: its editor opens at the top with the name field focused.
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [placingCenter, setPlacingCenter] = useState(false);
  const [pending, setPending] = useState<{ symbol?: string; kind?: AreaRow['kind']; lat: number; lng: number } | null>(null);
  const [typeModal, setTypeModal] = useState(false);
  const symbolsQ = useEventSymbols(event.id);
  const customs = useMemo(() => (symbolsQ.data ?? []).map(customSymbol), [symbolsQ.data]);
  const allSymbols = useMemo(() => [...POINT_SYMBOLS, ...customs], [customs]);
  const locked = !!event.active_formation_id;
  const frozenKinds = new Set(['perimeter', 'formation_area', 'exclusion', 'no_go', 'emergency']);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['areas', event.id] });
  };
  const save = useMutation({
    mutationFn: (a: { kind: AreaRow['kind']; geom: GeoJSON.Geometry; name?: string | null; buffer?: number; isPublic?: boolean | null; id?: string | null; symbol?: string | null; capacity?: number | null; opensAt?: string | null; closesAt?: string | null; details?: string | null }) =>
      rpc<string>('save_event_area', {
        p_event_id: event.id,
        p_kind: a.kind,
        p_geojson: a.geom,
        p_name: a.name ?? null,
        p_safety_buffer_m: a.buffer ?? (a.kind === 'exclusion' ? 2 : 0),
        p_is_public: a.isPublic ?? null,
        p_area_id: a.id ?? null,
        p_symbol: a.symbol ?? null,
        p_capacity: a.capacity ?? null,
        p_opens_at: a.opensAt ?? null,
        p_closes_at: a.closesAt ?? null,
        p_details: a.details ?? null,
      }),
    onSuccess: (id, vars) => {
      setSelected(id);
      if (!vars.id) setJustCreated(id);
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
                { kind: editing.kind, geom, id: editing.id, name: editing.name, buffer: editing.safety_buffer_m, isPublic: editing.is_public, symbol: editing.symbol },
                { onSuccess: () => setEditingId(null) },
              ),
            onCancel: () => setEditingId(null),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing?.id, editing?.geom, save.isPending],
  );
  const error = save.error ?? remove.error ?? setCenter.error;
  const pendingArea: AreaRow | null = pending
    ? {
        id: PENDING_ID,
        event_id: event.id,
        kind: pending.kind ?? 'access_point',
        name: pending.kind ? AREA_STYLE[pending.kind].label : symbolOf(pending.symbol, allSymbols)?.label ?? null,
        symbol: pending.symbol ?? null,
        geom: { type: 'Point', coordinates: [pending.lng, pending.lat] },
        safety_buffer_m: 0,
        is_public: true,
      }
    : null;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      {/* The map stays in view (sticky) while the tools on the right scroll. */}
      <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
        <div className="h-[620px] xl:h-[calc(100vh-2rem)]">
        <MapView
          areas={[...(areas.data ?? []).filter((a) => a.id !== editingId), ...(pendingArea ? [pendingArea] : [])]}
          customSymbols={customs}
          edit={edit}
          center={event.center_lat != null ? { lat: event.center_lat, lng: event.center_lng! } : null}
          draw={draw}
          selectedAreaId={selected}
          focus={focus}
          onAreaClick={(id) => id !== PENDING_ID && setSelected(id)}
          onMapClick={onMapClick}
          height="100%"
          defaultSatellite
          message={error ? (error as Error).message.replace(/^[A-Z_]+: /, '').replace(/^\w/, (c) => c.toUpperCase()) : null}
          bearingKey={event.id}
          onDropSymbol={
            canEdit
              ? (id, at) => {
                  // Not saved yet: adjust it (drag on the map, change type or name), then Save.
                  setTool(null);
                  setEditingId(null);
                  setSelected(null);
                  setPending({ symbol: id, lat: at.lat, lng: at.lng });
                }
              : undefined
          }
          onDropKind={canEdit ? (kind, at) => (setTool(null), setEditingId(null), setSelected(null), setPending({ kind, lat: at.lat, lng: at.lng })) : undefined}
          onMovePoint={
            canEdit
              ? (id, to) => {
                  if (id === PENDING_ID) return setPending((p) => p && { ...p, lat: to.lat, lng: to.lng });
                  const a = (areas.data ?? []).find((x) => x.id === id);
                  if (a) save.mutate({ kind: a.kind, geom: { type: 'Point', coordinates: [to.lng, to.lat] }, id, name: a.name, buffer: a.safety_buffer_m, isPublic: a.is_public, symbol: a.symbol });
                }
              : undefined
          }
        />
        </div>
        {placingCenter && <Alert>Click the map to set the event center (where the map opens when nothing is drawn yet).</Alert>}
      </div>
      <div className="space-y-4">
        {pending && pendingArea && (
          <AreaEditor
            key={`pending-${pending.symbol ?? pending.kind}`}
            area={pendingArea}
            isNew
            symbols={allSymbols}
            onAddType={() => setTypeModal(true)}
            canEdit={canEdit}
            editing={false}
            autoFocusName={false}
            onClose={() => setPending(null)}
            onEditShape={() => {}}
            onSymbolChange={(id) => setPending((p) => p && { ...p, symbol: id, kind: undefined })}
            timezone={event.timezone}
            onSave={(p) =>
              save.mutate(
                { kind: pendingArea.kind, geom: pendingArea.geom, name: p.name, isPublic: p.isPublic, symbol: p.symbol, capacity: p.capacity, opensAt: p.opensAt, closesAt: p.closesAt, details: p.details },
                { onSuccess: () => (setPending(null), setSelected(null), setJustCreated(null)) },
              )
            }
            onDelete={() => setPending(null)}
            busy={save.isPending}
          />
        )}
        {!pending && !(sel && sel.kind === 'access_point') && canEdit && (
          <Card title="Access points">
            <p className="mb-2.5 text-xs text-muted">Drag a type onto the map, adjust the point, then Save. Drag saved points to move them; click one to rename or delete it.</p>
            <div className="flex flex-wrap gap-1.5">
              {allSymbols.map((p) => <SymbolPill key={p.id} symbol={p} draggable />)}
              <AddTypePill onClick={() => setTypeModal(true)} />
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-xs text-muted">Service points — drag onto the map. Collection points share the crowd between them, so nobody queues at one tent.</p>
              <div className="flex flex-wrap gap-1.5">
                {PICKUP_KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    draggable
                    title={k.help}
                    onDragStart={(e) => (e.dataTransfer.setData(KIND_DRAG_TYPE, k.kind), (e.dataTransfer.effectAllowed = 'copy'))}
                    className="flex cursor-grab items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-text active:cursor-grabbing"
                    style={{ borderColor: AREA_STYLE[k.kind].color }}
                  >
                    <span className="h-3 w-3 rounded-[4px]" style={{ background: AREA_STYLE[k.kind].color }} />
                    {AREA_STYLE[k.kind].label}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}
        {sel && !pending && <AreaEditor key={sel.id} area={sel} symbols={allSymbols} timezone={event.timezone} onAddType={() => setTypeModal(true)} autoFocusName={justCreated === sel.id} onClose={() => (setSelected(null), setJustCreated(null))} canEdit={canEdit && !(locked && frozenKinds.has(sel.kind))} editing={editingId === sel.id} onEditShape={() => (setTool(null), setEditingId(sel.id))} onSave={(p) => save.mutate({ ...p, kind: sel.kind, geom: sel.geom, id: sel.id })} onDelete={() => remove.mutate(sel.id)} busy={save.isPending || remove.isPending} />}
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
                <button
                  onClick={() => (setSelected(a.id), setFocus({ id: a.id, n: Date.now() }))}
                  className={`flex w-full items-center justify-between gap-3 border-l-4 px-4 py-2.5 text-left text-sm transition ${a.id === selected ? 'border-pixel bg-pixel/20 font-semibold text-text' : 'border-transparent hover:bg-surface-2'}`}
                >
                  <span className="flex items-center gap-2.5">
                    <AreaMark area={a} symbols={allSymbols} />
                    {a.name || symbolOf(a.symbol, allSymbols)?.label || AREA_STYLE[a.kind].label}
                  </span>
                  <span className="hp-digits text-xs text-muted">{a.area_m2 ? `${Math.round(a.area_m2).toLocaleString()} m²` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <TypeModal open={typeModal} onClose={() => setTypeModal(false)} eventId={event.id} customs={customs} />
    </div>
  );
}

function AddTypePill({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 rounded-full border border-dashed border-muted px-2.5 py-1 text-xs text-muted hover:border-text hover:text-text" title="Create your own type: name, colour, logo">
      <Plus size={12} /> New type
    </button>
  );
}

const TYPE_COLORS = [SAFETY.green, SAFETY.blue, SAFETY.red, SAFETY.yellow, '#8C7CFF', '#FF7A1A', '#E23D8B', '#00A7A7', '#5B6270', '#111111'];

/** Create (and delete) the event's own access-point types: name, colour, optional logo or image. */
function TypeModal({ open, onClose, eventId, customs }: { open: boolean; onClose: () => void; eventId: string; customs: PointSymbol[] }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<string>(SAFETY.blue);
  const [icon, setIcon] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const reset = () => (setLabel(''), setColor(SAFETY.blue), setIcon(null), setFileError(null));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['symbols', eventId] });
  const create = useMutation({
    mutationFn: async () => {
      const id = 'c' + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
      const { error } = await supabase.from('event_symbols').insert({ id, event_id: eventId, label: label.trim(), color, icon });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => (refresh(), reset(), onClose()),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('event_symbols').delete().eq('event_id', eventId).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => (refresh(), void qc.invalidateQueries({ queryKey: ['areas', eventId] })),
  });
  const preview: PointSymbol = customSymbol({ id: 'cpreview', event_id: eventId, label: label.trim() || 'New type', color, icon });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New access-point type"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={create.isPending} disabled={!label.trim()} onClick={() => create.mutate()}>Create type</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name"><Input value={label} maxLength={40} autoFocus placeholder="e.g. Bar, Stage, Taxi, Shuttle" onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Colour">
          <div className="flex flex-wrap items-center gap-2">
            {TYPE_COLORS.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} className="h-7 w-7 rounded-full border-2" style={{ background: c, borderColor: color.toLowerCase() === c.toLowerCase() ? 'var(--hp-text)' : 'transparent' }} />
            ))}
            <label className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2 text-xs text-muted hover:text-text">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0" />
              Custom
            </label>
          </div>
        </Field>
        <Field label="Logo or image (optional)" hint="PNG with transparency works best. It is resized to a small icon.">
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted hover:border-muted hover:text-text">
              <ImagePlus size={16} /> {icon ? 'Replace image' : 'Import an image'}
              <input
                type="file"
                accept="image/png,image/svg+xml,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  try {
                    setFileError(null);
                    setIcon(await imageToPngDataUrl(f));
                  } catch (err) {
                    setFileError((err as Error).message);
                  }
                }}
              />
            </label>
            {icon && <button type="button" onClick={() => setIcon(null)} className="text-xs text-muted hover:text-text">Remove image</button>}
          </div>
          {fileError && <p className="mt-1 text-xs text-bad">{fileError}</p>}
        </Field>
        <div>
          <p className="mb-1.5 text-xs text-muted">Preview</p>
          <SymbolPill symbol={preview} />
        </div>
        {create.error && <Alert tone="bad">{(create.error as Error).message}</Alert>}
        {customs.length > 0 && (
          <div className="border-t border-line pt-4">
            <p className="mb-2 text-xs text-muted">Your types for this event (deleting one turns its points into plain points)</p>
            <div className="flex flex-wrap gap-2">
              {customs.map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <SymbolPill symbol={c} />
                  <button type="button" aria-label={`Delete ${c.label}`} onClick={() => del.mutate(c.id)} className="rounded p-1 text-muted hover:text-bad">
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
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

/** List marker: the symbol pictogram for typed points, the zone colour otherwise. */
function AreaMark({ area, symbols }: { area: AreaRow; symbols: PointSymbol[] }) {
  const s = symbolOf(area.symbol, symbols);
  if (!s) return <span className="h-2.5 w-2.5 rounded-sm" style={{ background: AREA_STYLE[area.kind].color }} />;
  const Icon = s.icon;
  return (
    <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-[5px]" style={{ background: s.color }} title={s.norm}>
      {s.image ? <img src={s.image} alt="" className="h-4 w-4 object-contain" /> : <Icon size={12} color={s.ink} strokeWidth={2.6} />}
    </span>
  );
}

function AreaEditor({ area, symbols, isNew = false, onAddType, onSymbolChange, timezone, canEdit, editing, autoFocusName, onClose, onEditShape, onSave, onDelete, busy }: { area: AreaRow; symbols: PointSymbol[]; isNew?: boolean; onAddType: () => void; onSymbolChange?: (id: string) => void; canEdit: boolean; editing: boolean; autoFocusName: boolean; onClose: () => void; onEditShape: () => void; timezone: string; onSave: (p: { name: string | null; buffer: number; isPublic: boolean; symbol: string | null; capacity: number | null; opensAt: string | null; closesAt: string | null; details: string | null }) => void; onDelete: () => void; busy: boolean }) {
  const [name, setName] = useState(area.name ?? '');
  const [buffer, setBuffer] = useState(area.safety_buffer_m);
  const [pub, setPub] = useState(area.is_public);
  const [symbol, setSymbol] = useState<string | null>(area.symbol ?? null);
  const [capacity, setCapacity] = useState<number | null>(area.capacity ?? null);
  const [opens, setOpens] = useState(isoToZonedLocal(area.opens_at ?? null, timezone));
  const [closes, setCloses] = useState(isoToZonedLocal(area.closes_at ?? null, timezone));
  const [details, setDetails] = useState(area.details ?? '');
  const isPickup = ['collection', 'control', 'bounty'].includes(area.kind);
  const payload = () => ({
    name: name.trim() || null,
    buffer,
    isPublic: pub,
    symbol,
    capacity: isPickup ? capacity : null,
    opensAt: isPickup && opens ? zonedLocalToIso(opens, timezone) : null,
    closesAt: isPickup && closes ? zonedLocalToIso(closes, timezone) : null,
    details: isPickup ? details.trim() || null : null,
  });
  const bufferMatters = ['exclusion', 'no_go', 'emergency'].includes(area.kind);
  return (
    <Card
      title={<span className="flex items-center gap-2">{isNew ? 'New access point' : AREA_STYLE[area.kind].label} {!area.is_public && <Badge>private</Badge>}</span>}
      actions={<button onClick={onClose} className="text-xs text-muted hover:text-text">Close</button>}
    >
      <div className="space-y-3">
        {isNew && <Alert>Not saved yet. Drag it on the map to adjust, pick another type if needed, then Save.</Alert>}
        <Field label="Name" hint={area.kind === 'access_point' ? 'Shown on the map and to participants (if public).' : undefined}>
          <Input
            value={name}
            disabled={!canEdit}
            autoFocus={autoFocusName}
            placeholder={area.kind === 'access_point' ? 'e.g. Medical point' : AREA_STYLE[area.kind].label}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canEdit && onSave(payload())}
          />
        </Field>
        {area.kind === 'access_point' && canEdit && (
          <div className="flex flex-wrap gap-1.5">
            {symbols.map((p) => (
              <SymbolPill key={p.id} symbol={p} draggable selected={symbol === p.id} onClick={() => (setName(p.label), setSymbol(p.id), onSymbolChange?.(p.id))} />
            ))}
            <AddTypePill onClick={onAddType} />
          </div>
        )}
        {isPickup && (
          <div className="space-y-3 rounded-xl border border-line p-3">
            <Field
              label={area.kind === 'collection' ? 'What people collect here' : area.kind === 'bounty' ? 'What people claim here' : 'What staff check here'}
              hint="Shown to the participants sent here."
            >
              <Input value={details} disabled={!canEdit} maxLength={200} placeholder="e.g. One sponsor t-shirt, size on the wristband" onChange={(e) => setDetails(e.target.value)} />
            </Field>
            {area.kind === 'collection' && (
              <Field label="People this point can serve" hint={`Empty = no limit.${area.assigned != null ? ` Currently assigned: ${area.assigned.toLocaleString()}.` : ''}`}>
                <Input type="number" min={1} max={1000000} value={capacity ?? ''} disabled={!canEdit} placeholder="No limit" onChange={(e) => setCapacity(e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Opens"><Input type="datetime-local" value={opens} disabled={!canEdit} onChange={(e) => setOpens(e.target.value)} /></Field>
              <Field label="Closes"><Input type="datetime-local" value={closes} disabled={!canEdit} onChange={(e) => setCloses(e.target.value)} /></Field>
            </div>
          </div>
        )}
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
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDelete} disabled={busy}>{isNew ? 'Discard' : 'Delete'}</Button>
            <Button variant="primary" size="sm" busy={busy} onClick={() => onSave(payload())}>Save</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
