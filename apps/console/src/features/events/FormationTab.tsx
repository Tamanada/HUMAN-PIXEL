import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dices, Lock, RotateCcw, Sparkles, Upload, Wand2 } from 'lucide-react';
import { deepestPoint, formationEditable, geoJsonPolygonToLatLng, randomSeed, type FormationResult, type FormationStage, type Mask } from '@human-pixel/core';
import { ensureFontLoaded, maskToRgba, renderImageMask, renderTextMask } from '@human-pixel/core/formation-browser';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Stat, Textarea } from '../../components/ui';
import { MapView, readBearing, type PointsLayer } from '../../components/MapView';
import { rpc, supabase } from '../../lib/supabase';
import type { FormationRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { constraintsFromAreas, runEngine, saveFormation, suggestWidth, ENGINE_VERSION, type SaveProgress } from './formationClient';
import { useAreas, useFormationPoints, useFormations } from './hooks';

const FONTS = [
  { family: 'Anton', weight: 400, label: 'Anton (condensed, very bold)' },
  { family: 'Archivo Black', weight: 400, label: 'Archivo Black (wide, heavy)' },
  { family: 'Space Grotesk Variable', weight: 700, label: 'Space Grotesk Bold' },
  { family: 'Inter Variable', weight: 900, label: 'Inter Black' },
];

const STAGE_LABEL: Record<FormationStage, string> = {
  field: 'Rasterizing design and safety constraints',
  spacing: 'Solving human spacing',
  relax: 'Relaxing positions (Lloyd)',
  separate: 'Enforcing minimum spacing',
  metrics: 'Measuring readability',
  finalize: 'Finalizing',
};

export function FormationTab({ event, canEdit }: TabProps) {
  const areas = useAreas(event.id);
  const formations = useFormations(event.id);
  const qc = useQueryClient();
  const editable = canEdit && formationEditable(event.state);

  // ---- design --------------------------------------------------------------------------------
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('LOVE\nPHANGAN');
  const [font, setFont] = useState(FONTS[0]!);
  const [letterSpacing, setLetterSpacing] = useState(0.04);
  const [file, setFile] = useState<File | null>(null);
  const [imgMode, setImgMode] = useState<'auto' | 'alpha' | 'luminance'>('auto');
  const [invert, setInvert] = useState(false);
  const [mask, setMask] = useState<Mask | null>(null);
  const [maskError, setMaskError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        let m: Mask | null = null;
        if (mode === 'text' && text.trim()) {
          await ensureFontLoaded(font.family, font.weight);
          m = renderTextMask({ text, fontFamily: font.family, fontWeight: font.weight, letterSpacingEm: letterSpacing, resolution: 2400 });
        } else if (mode === 'image' && file) {
          m = await renderImageMask(file, { mode: imgMode, invert, resolution: 2400 });
        }
        if (alive) {
          setMask(m);
          setMaskError(null);
        }
      } catch (e) {
        if (alive) setMaskError((e as Error).message);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, text, font, letterSpacing, file, imgMode, invert]);

  // ---- placement -----------------------------------------------------------------------------
  // Sizing: "fit" = the surface decides (largest design, head count computed); "count" = a known
  // audience decides (design sized for N people). Capacity is derived from the result either way.
  const [sizing, setSizing] = useState<'fit' | 'count'>(event.capacity == null ? 'fit' : 'count');
  const [count, setCount] = useState(event.capacity ?? 5000);
  const [targetSpacing, setTargetSpacing] = useState(1.3);
  const [widthOverride, setWidthOverride] = useState<number | null>(null);
  // Rotation is counter-clockwise; a map turned so the beach reads left→right has bearing b, so the
  // message reads the same way on the ground at rotation −b. Default: follow the saved map view.
  const [viewBearing, setViewBearing] = useState(() => readBearing(event.id));
  const alignedRotation = Math.round(-(((viewBearing + 180) % 360 + 360) % 360 - 180));
  const [rotation, setRotation] = useState(alignedRotation);
  // Fill mode: let the engine choose rotation + position so the message covers the most of the area.
  const [autoPlace, setAutoPlace] = useState(true);
  const auto = sizing === 'fit' && autoPlace;
  const [minSpacing, setMinSpacing] = useState(0.9);
  const [zoneSize, setZoneSize] = useState(1500);
  const [seed, setSeed] = useState(() => randomSeed());
  // Default anchor: the point deepest inside the formation area (else the perimeter), where a
  // centred design has the most room. The event centre is only a fallback without any area.
  const [anchor, setAnchor] = useState<{ lat: number; lng: number } | null>(null);
  const [placingAnchor, setPlacingAnchor] = useState(false);
  const autoWidth = mask && sizing === 'count' ? suggestWidth(mask, count, targetSpacing) : 0;
  const width = widthOverride ?? Math.round(autoWidth);
  const height = mask ? Math.round((width * mask.height) / mask.width) : 0;

  useEffect(() => {
    if (anchor || !areas.data) return;
    setAnchor(defaultAnchor());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas.data, anchor]);

  function defaultAnchor(): { lat: number; lng: number } | null {
    const fa = areas.data?.find((a) => a.kind === 'formation_area') ?? areas.data?.find((a) => a.kind === 'perimeter');
    if (fa && fa.geom.type === 'Polygon') return deepestPoint(geoJsonPolygonToLatLng(fa.geom as never));
    return event.center_lat != null ? { lat: event.center_lat, lng: event.center_lng! } : null;
  }

  /** Placement back to the recommended values (the design itself is kept). */
  const resetPlacement = () => {
    setSizing(event.capacity == null ? 'fit' : 'count');
    setCount(event.capacity ?? 5000);
    setTargetSpacing(1.3);
    setWidthOverride(null);
    setRotation(alignedRotation);
    setMinSpacing(0.9);
    setZoneSize(1500);
    setAnchor(defaultAnchor());
    setPlacingAnchor(false);
    setAutoPlace(true);
  };

  // ---- generation ----------------------------------------------------------------------------
  const [result, setResult] = useState<FormationResult | null>(null);
  const [progress, setProgress] = useState<{ stage: FormationStage; fraction: number } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const generate = async () => {
    if (!mask || !anchor) return;
    const c = constraintsFromAreas(areas.data ?? []);
    setGenError(null);
    setResult(null);
    setProgress({ stage: 'field', fraction: 0 });
    const job = runEngine(
      {
        mask,
        anchor,
        // Fit mode without a manual width: the engine finds the largest width inside the area.
        widthM: auto || (sizing === 'fit' && widthOverride == null) ? undefined : width,
        rotationDeg: rotation,
        autoPlace: auto ? { preferredRotationDeg: alignedRotation } : undefined,
        targetCount: sizing === 'count' ? count : undefined,
        targetSpacingM: targetSpacing,
        minSpacingM: minSpacing,
        perimeter: c.perimeter,
        formationArea: c.formationArea,
        exclusions: c.exclusions,
        seed,
        zoneSize,
      },
      (stage, fraction) => setProgress({ stage, fraction }),
    );
    cancelRef.current = job.cancel;
    try {
      const res = await job.promise;
      setResult(res);
      if (auto) {
        // Show what the engine chose; switching auto off keeps it as a starting point to tweak.
        setRotation(Math.round(res.rotationDeg));
        setAnchor(res.anchor);
      }
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setProgress(null);
      cancelRef.current = null;
    }
  };

  // ---- save / lock ---------------------------------------------------------------------------
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!result || !mask) throw new Error('Generate first');
      let source: Record<string, unknown>;
      if (mode === 'text') {
        source = { kind: 'text', text, fontFamily: font.family, fontWeight: font.weight, letterSpacingEm: letterSpacing, lineHeightEm: 1.05 };
      } else {
        const assetId = crypto.randomUUID();
        const ext = file!.name.split('.').pop()?.toLowerCase() ?? 'png';
        const path = `${event.id}/${assetId}.${ext}`;
        const up = await supabase.storage.from('formation-assets').upload(path, file!, { contentType: file!.type, upsert: false });
        if (up.error) throw new Error(up.error.message);
        const { data: u } = await supabase.auth.getUser();
        const ins = await supabase.from('formation_assets').insert({ event_id: event.id, storage_path: path, file_name: file!.name, mime_type: file!.type, bytes: file!.size, created_by: u.user?.id }).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        source = { kind: 'image', assetId: ins.data.id, fileName: file!.name, mode: imgMode, invert };
      }
      const params = { sizing, targetCount: result.points.length, targetSpacingM: targetSpacing, widthM: result.widthM, heightM: result.heightM, rotationDeg: result.rotationDeg, autoPlace: auto, minSpacingM: minSpacing, anchor: result.anchor, seed, zoneSize, engine: ENGINE_VERSION };
      return saveFormation(event.id, result, source, params, setSaveProgress);
    },
    onSuccess: ({ report: r, formationId }) => {
      setReport(r);
      setSavedId(r.ok ? formationId : null);
      setSaveProgress(null);
      void qc.invalidateQueries({ queryKey: ['formations', event.id] });
    },
    onError: () => setSaveProgress(null),
  });

  const constraintsCount = useMemo(() => constraintsFromAreas(areas.data ?? []), [areas.data]);
  const noPerimeter = !constraintsCount.perimeter;

  const previewLayer: PointsLayer | null = useMemo(
    () => (result ? { lat: result.points.map((p) => p.lat), lng: result.points.map((p) => p.lng) } : null),
    [result],
  );

  return (
    <div className="space-y-6">
      {!formationEditable(event.state) && <Alert tone="warn">The formation is frozen at this stage of the event ({event.state}).</Alert>}
      {noPerimeter && <Alert tone="warn">Draw the event perimeter in "Location & safety" first: the engine keeps every pixel inside it.</Alert>}
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <div className="space-y-4">
          <Card title="1 · Secret design">
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
              {(['text', 'image'] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded-md py-1.5 text-sm capitalize ${mode === m ? 'bg-surface-2 text-text' : 'text-muted'}`}>{m}</button>
              ))}
            </div>
            {mode === 'text' ? (
              <div className="space-y-3">
                <Field label="Message (new line = new row)"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value.toUpperCase())} className="hp-display text-lg" /></Field>
                <Field label="Font">
                  <Select value={font.family} onChange={(e) => setFont(FONTS.find((f) => f.family === e.target.value)!)}>
                    {FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
                  </Select>
                </Field>
                <Field label={`Letter spacing ${letterSpacing.toFixed(2)} em`}>
                  <input type="range" min={-0.05} max={0.5} step={0.01} value={letterSpacing} onChange={(e) => setLetterSpacing(Number(e.target.value))} className="w-full accent-[var(--hp-pixel)]" />
                </Field>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line p-5 text-sm text-muted hover:border-pixel">
                  <Upload size={16} /> {file ? file.name : 'SVG, PNG (transparent), JPG, WebP'}
                  <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Read shape from">
                    <Select value={imgMode} onChange={(e) => setImgMode(e.target.value as typeof imgMode)}>
                      <option value="auto">Auto</option>
                      <option value="alpha">Transparency</option>
                      <option value="luminance">Dark = people</option>
                    </Select>
                  </Field>
                  <Field label="Invert"><Select value={invert ? '1' : '0'} onChange={(e) => setInvert(e.target.value === '1')}><option value="0">No</option><option value="1">Yes</option></Select></Field>
                </div>
              </div>
            )}
            <MaskPreview mask={mask} />
            {maskError && <Alert tone="bad">{maskError}</Alert>}
          </Card>

          <Card
            title="2 · Placement"
            actions={<Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={resetPlacement} title="Spacing 1.3 m, min 0.9 m, 1,500 per zone, aligned with the map, anchor at the heart of the area">Reset to defaults</Button>}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
                {([['fit', 'Fill the surface'], ['count', 'I know my head count']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => (setSizing(k), setWidthOverride(null))} className={`rounded-md py-1.5 text-sm ${sizing === k ? 'bg-surface-2 text-text' : 'text-muted'}`}>{label}</button>
                ))}
              </div>
              <p className="col-span-2 text-xs text-muted">
                {sizing === 'fit'
                  ? 'The message is drawn as large as the area allows; the number of people is calculated from it.'
                  : 'The message is sized for this many people; the area only has to contain it.'}
              </p>
              {sizing === 'fit' && (
                <label className="col-span-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-2.5 text-sm">
                  <input type="checkbox" checked={autoPlace} onChange={(e) => setAutoPlace(e.target.checked)} className="mt-0.5 accent-[var(--hp-pixel)]" />
                  <span>
                    <span className="block">Cover the most of the formation area</span>
                    <span className="block text-xs text-muted">Rotation and position are chosen automatically (text reads as in your map view). Untick to set them by hand.</span>
                  </span>
                </label>
              )}
              {sizing === 'fit' && (
                <Field label="Human pixels" hint={result ? 'Calculated from the area and the spacing' : 'Calculated when you generate'}>
                  <Input disabled value={result ? result.points.length.toLocaleString() : ''} placeholder="—" />
                </Field>
              )}
              {sizing === 'count' && (
                <Field label="Human pixels"><Input type="number" min={1} max={250000} value={count} onChange={(e) => setCount(Math.min(250000, Math.max(1, Number(e.target.value))))} /></Field>
              )}
              <Field label="Target spacing (m)" hint={sizing === 'fit' ? 'Sets the head count' : 'Drives the size'}>
                <Input type="number" min={minSpacing} max={10} step={0.1} value={targetSpacing} onChange={(e) => { setTargetSpacing(Number(e.target.value)); if (sizing === 'count') setWidthOverride(null); }} />
              </Field>
              <Field label="Width (m)" hint={widthOverride != null ? 'manual' : sizing === 'fit' ? 'fitted to the area' : 'auto'}>
                <Input
                  type="number"
                  min={5}
                  disabled={auto}
                  placeholder={sizing === 'fit' ? (result ? String(Math.round(result.widthM)) : 'auto') : ''}
                  value={widthOverride ?? (sizing === 'count' ? width || '' : '')}
                  onChange={(e) => setWidthOverride(Number(e.target.value) || null)}
                />
              </Field>
              <Field label="Height (m)"><Input disabled value={sizing === 'fit' && widthOverride == null ? (result ? Math.round(result.heightM) : '') : height || ''} /></Field>
              <Field
                label={`Rotation ${rotation}°`}
                className="col-span-2"
                hint={auto ? 'Chosen automatically to fill the area.' : rotation === alignedRotation ? 'Reads left→right in the map view.' : undefined}
              >
                <input type="range" min={-180} max={180} value={rotation} disabled={auto} onChange={(e) => setRotation(Number(e.target.value))} className="w-full accent-[var(--hp-pixel)]" />
                {!auto && rotation !== alignedRotation && (
                  <Button size="sm" variant="ghost" onClick={() => setRotation(alignedRotation)}>Align with the map view ({alignedRotation}°)</Button>
                )}
              </Field>
              <Field label="Min. spacing (m)" hint="Crowd safety floor"><Input type="number" min={0.6} max={5} step={0.05} value={minSpacing} onChange={(e) => setMinSpacing(Number(e.target.value))} /></Field>
              <Field
                label="People per zone"
                hint={`Marshalling only: splits the crowd into zones A, B, C… It never changes the number of pixels.${result ? ` Now ${result.zones.length} zone${result.zones.length > 1 ? 's' : ''}.` : ''}`}
              >
                <Input type="number" min={100} max={20000} step={100} value={zoneSize} onChange={(e) => setZoneSize(Number(e.target.value))} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Anchor {anchor ? `${anchor.lat.toFixed(6)}, ${anchor.lng.toFixed(6)}` : 'not set'}</span>
              <Button size="sm" variant="ghost" disabled={auto} onClick={() => setPlacingAnchor((v) => !v)}>{placingAnchor ? 'Click on the map…' : 'Move anchor'}</Button>
              <Button size="sm" variant="ghost" icon={<Dices size={14} />} onClick={() => setSeed(randomSeed())}>Seed {seed}</Button>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" icon={<Wand2 size={16} />} disabled={!editable || !mask || !anchor || (sizing === 'count' && !width) || noPerimeter || !!progress} onClick={generate}>Generate</Button>
              {progress && <Button variant="ghost" onClick={() => cancelRef.current?.()}>Cancel</Button>}
            </div>
            {progress && (
              <div className="mt-3 space-y-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-pixel transition-all" style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
                <p className="text-xs text-muted">{STAGE_LABEL[progress.stage]}…</p>
              </div>
            )}
            {genError && <div className="mt-3"><Alert tone="bad">{genError}</Alert></div>}
          </Card>
        </div>

        <div className="space-y-4">
          <MapView
            areas={areas.data ?? []}
            points={previewLayer}
            center={anchor}
            height={440}
            onMapClick={placingAnchor ? (p) => (setAnchor(p), setPlacingAnchor(false)) : undefined}
            bearingKey={event.id}
            onBearingChange={setViewBearing}
          />
          {result && <ResultPanel result={result} />}
          {result && editable && (
            <Card title="3 · Save & validate">
              <p className="mb-3 text-sm text-muted">
                The points are uploaded and re-checked by the database: count, uniqueness, inside the perimeter, outside every exclusion and its buffer, and minimum spacing between all people.
              </p>
              <Button variant="primary" icon={<Sparkles size={16} />} busy={save.isPending} onClick={() => save.mutate()}>Save as new version</Button>
              {saveProgress && (
                <p className="mt-3 text-xs text-muted">
                  {saveProgress.phase === 'upload' ? `Uploading ${saveProgress.done.toLocaleString()} / ${saveProgress.total.toLocaleString()} points…` : saveProgress.phase === 'validate' ? 'Server validation…' : 'Creating version…'}
                </p>
              )}
              {save.error && <div className="mt-3"><Alert tone="bad">{(save.error as Error).message}</Alert></div>}
              {report && <ValidationReport report={report} />}
              {savedId && !event.active_formation_id && result && (
                <CapacityFromFormation eventId={event.id} formationId={savedId} pixels={result.points.length} current={event.capacity} />
              )}
            </Card>
          )}
        </div>
      </div>
      <Versions formations={formations.data ?? []} activeId={event.active_formation_id} editable={editable} eventId={event.id} />
    </div>
  );
}

/** Before locking: adopt this version's pixel count as the registration capacity (so registration can open). */
function CapacityFromFormation({ eventId, formationId, pixels, current }: { eventId: string; formationId: string; pixels: number; current: number | null }) {
  const qc = useQueryClient();
  const apply = useMutation({
    mutationFn: () => rpc<number>('set_capacity_from_formation', { p_formation_id: formationId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['event', eventId] }),
  });
  if (current === pixels) return <div className="mt-3"><Alert tone="ok">Registration capacity: {pixels.toLocaleString()} (this design).</Alert></div>;
  return (
    <div className="mt-4 rounded-xl border border-pixel/40 bg-pixel/5 p-4 text-sm">
      <p>
        This design needs <span className="hp-digits text-text">{pixels.toLocaleString()}</span> people.
        {current == null ? ' The event has no capacity yet.' : ` Current capacity: ${current.toLocaleString()}.`}
      </p>
      <p className="mt-1 text-xs text-muted">Locking the version also sets it automatically. Setting it now lets you open registration while the design stays editable.</p>
      <div className="mt-3">
        <Button size="sm" variant="primary" busy={apply.isPending} onClick={() => apply.mutate()}>Use {pixels.toLocaleString()} as capacity</Button>
      </div>
      {apply.error && <div className="mt-2"><Alert tone="bad">{(apply.error as Error).message}</Alert></div>}
    </div>
  );
}

function MaskPreview({ mask }: { mask: Mask | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !mask) return;
    c.width = mask.width;
    c.height = mask.height;
    const ctx = c.getContext('2d')!;
    ctx.putImageData(new ImageData(maskToRgba(mask, [140, 124, 255]) as unknown as Uint8ClampedArray<ArrayBuffer>, mask.width, mask.height), 0, 0);
  }, [mask]);
  if (!mask) return null;
  return <canvas ref={ref} className="mt-4 w-full rounded-lg border border-line bg-bg" aria-label="Design preview" />;
}

/** The drone's view: every pixel as a dot, plus a turnout slider demonstrating progressive fill. */
function SkyPreview({ result }: { result: FormationResult }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [turnout, setTurnout] = useState(100);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = 1200;
    const H = Math.round((W * result.heightM) / result.widthM) || 400;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e9dcc0'; // sand
    ctx.fillRect(0, 0, W, H);
    const sx = W / result.widthM;
    const k = Math.floor((result.points.length * turnout) / 100);
    const r = Math.max(0.8, Math.min(4, (result.metrics.spacingM * sx) / 2.4));
    ctx.fillStyle = '#16121f';
    for (const p of result.points) {
      if (p.fillRank >= k) continue;
      ctx.beginPath();
      ctx.arc(W / 2 + p.dx * sx, H / 2 - p.dy * sx, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [result, turnout]);
  return (
    <div className="space-y-2">
      <canvas ref={ref} className="w-full rounded-xl border border-line" aria-label="Aerial preview of the formation" />
      <label className="flex items-center gap-3 text-xs text-muted">
        <span className="w-40">Simulated turnout {turnout}%</span>
        <input type="range" min={10} max={100} value={turnout} onChange={(e) => setTurnout(Number(e.target.value))} className="flex-1 accent-[var(--hp-pixel)]" />
      </label>
    </div>
  );
}

function ResultPanel({ result }: { result: FormationResult }) {
  const m = result.metrics;
  const tone = m.readabilityScore >= 75 ? 'ok' : m.readabilityScore >= 50 ? 'warn' : 'bad';
  return (
    <Card title="Sky view" actions={<Badge tone={tone}>Readability {m.readabilityScore}/100</Badge>}>
      <SkyPreview result={result} />
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pixels" value={m.pointCount.toLocaleString()} />
        <Stat label="Spacing" value={`${m.nnMeanM.toFixed(2)} m`} sub={`min ${m.nnMinM.toFixed(2)} m`} />
        <Stat label="Footprint" value={`${Math.round(m.footprintWidthM)}×${Math.round(m.footprintHeightM)}`} sub="metres" />
        <Stat label="Stroke width" value={`${m.strokePersonsP20.toFixed(1)}`} sub="people (thinnest 20%)" />
        <Stat label="Density" value={m.densityPerM2.toFixed(2)} sub="people / m²" />
        <Stat label="Zones" value={result.zones.length} sub={result.zones.map((z) => z.label).join(' ')} />
        <Stat label="Clipped" value={`${(m.clippedFraction * 100).toFixed(1)}%`} sub="by safety areas" />
        <Stat label="Engine" value={`${(m.generationMs / 1000).toFixed(1)} s`} sub={`${m.lloydIterations} relax passes`} />
      </div>
      {result.warnings.length > 0 && (
        <div className="mt-4 space-y-2">
          {result.warnings.map((w) => <Alert key={w.code} tone="warn">{w.message}</Alert>)}
        </div>
      )}
    </Card>
  );
}

function ValidationReport({ report }: { report: Record<string, unknown> }) {
  const ok = report.ok === true;
  const rows: [string, unknown][] = [
    ['Points', `${report.count} / ${report.expected}`],
    ['Checksum', report.checksum_ok ? 'match' : 'MISMATCH'],
    ['Outside perimeter', report.outside_perimeter],
    ['Outside formation area', report.outside_formation_area],
    ['Inside exclusions (+buffer)', report.inside_exclusions],
    ['Spacing violations', report.spacing_violations],
  ];
  return (
    <div className="mt-4 space-y-2">
      <Alert tone={ok ? 'ok' : 'bad'}>{ok ? 'Validated by the database. You can lock this version.' : 'Rejected by the database. Adjust the design or areas and regenerate.'}</Alert>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-line py-1"><dt className="text-muted">{k}</dt><dd className="hp-digits">{String(v)}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function Versions({ formations, activeId, editable, eventId }: { formations: FormationRow[]; activeId: string | null; editable: boolean; eventId: string }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<FormationRow | null>(null);
  const [view, setView] = useState<string | null>(null);
  const pts = useFormationPoints(view);
  const lock = useMutation({
    mutationFn: (id: string) => rpc<{ assigned: number; released: number; waitlisted: number }>('formation_lock', { p_formation_id: id }),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['formations', eventId] });
      void qc.invalidateQueries({ queryKey: ['event', eventId] });
    },
  });
  if (formations.length === 0) return null;
  return (
    <Card title="Versions" padded={false}>
      <ul className="divide-y divide-line">
        {formations.map((f) => {
          const src = f.source as { kind?: string; text?: string; fileName?: string };
          return (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="hp-digits text-muted">v{f.version}</span>
                <span className="hp-display">{src.kind === 'text' ? src.text?.replace(/\n/g, ' / ') : src.fileName ?? 'image'}</span>
                <Badge tone={f.id === activeId ? 'pixel' : f.status === 'ready' ? 'ok' : f.status === 'rejected' ? 'bad' : 'neutral'}>{f.id === activeId ? 'active' : f.status}</Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="hp-digits">{f.point_count.toLocaleString()} pixels</span>
                {f.metrics.readabilityScore != null && <span>readability {f.metrics.readabilityScore}</span>}
                <Button size="sm" variant="ghost" onClick={() => setView(view === f.id ? null : f.id)}>{view === f.id ? 'Hide' : 'View'}</Button>
                {editable && f.status === 'ready' && <Button size="sm" variant="primary" icon={<Lock size={14} />} onClick={() => setConfirm(f)}>Lock</Button>}
              </div>
              {view === f.id && pts.data && (
                <div className="w-full pt-2">
                  <MapView points={{ lat: pts.data.lat, lng: pts.data.lng }} height={360} bearingKey={eventId} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Lock version ${confirm?.version}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" busy={lock.isPending} onClick={() => confirm && lock.mutate(confirm.id)}>Lock and assign</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>This version becomes the event's formation. Every registered participant is assigned a pixel in one transaction; if another version was active, everyone is remapped and phones refresh automatically.</p>
          <p className="text-muted">Registration capacity becomes {confirm?.point_count.toLocaleString()} (one person per pixel). Constraint areas (perimeter, exclusions…) are frozen while a formation is locked.</p>
          {lock.error && <Alert tone="bad">{(lock.error as Error).message}</Alert>}
          {lock.data && <Alert tone="ok">Assigned {lock.data.assigned.toLocaleString()} · waitlisted {lock.data.waitlisted.toLocaleString()}</Alert>}
        </div>
      </Modal>
    </Card>
  );
}
