import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dices, Lock, RotateCcw, Sparkles, Upload, Wand2 } from 'lucide-react';
import { deepestPoint, formationEditable, geoJsonPolygonToLatLng, randomSeed, type FormationResult, type FormationStage, type Mask } from '@human-pixel/core';
import { ensureFontLoaded, maskToRgba, renderImageMask, renderTextMask, renderTextSegmentMasks } from '@human-pixel/core/formation-browser';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Stat, Textarea } from '../../components/ui';
import { MapView, readBearing, type PointsLayer } from '../../components/MapView';
import { rpc, supabase } from '../../lib/supabase';
import type { FormationRow } from '../../lib/types';
import type { TabProps } from './EventLayout';
import { constraintsFromAreas, runEngine, saveFormation, suggestWidth, ENGINE_VERSION, type SaveProgress } from './formationClient';
import { useAreas, useFontAssets, useFormationPoints, useFormations } from './hooks';
import { FONT_ACCEPT, deleteFont, ensureAssetFont, familyForAsset, fontDisplayName, importFont, type FontChoice } from '../../lib/fonts';

// A stroke is a row of people: thin letters break up the moment somebody is missing, so the heavy
// faces come first and the list says what each one is for.
const BUILTIN_FONTS: FontChoice[] = [
  { family: 'Anton', weight: 400, label: 'Anton — condensed, very bold', group: 'Heaviest (best from the air)' },
  { family: 'Archivo Black', weight: 400, label: 'Archivo Black — wide, heavy', group: 'Heaviest (best from the air)' },
  { family: 'Alfa Slab One', weight: 400, label: 'Alfa Slab One — slab, thickest strokes', group: 'Heaviest (best from the air)' },
  { family: 'Bungee', weight: 400, label: 'Bungee — signage, blocky', group: 'Heaviest (best from the air)' },
  { family: 'Titan One', weight: 400, label: 'Titan One — rounded, heavy', group: 'Heaviest (best from the air)' },
  { family: 'Passion One', weight: 900, label: 'Passion One Black — heavy condensed', group: 'Condensed (fits long messages)' },
  { family: 'Bebas Neue', weight: 400, label: 'Bebas Neue — tall condensed caps', group: 'Condensed (fits long messages)' },
  { family: 'Fjalla One', weight: 400, label: 'Fjalla One — condensed', group: 'Condensed (fits long messages)' },
  { family: 'Space Grotesk Variable', weight: 700, label: 'Space Grotesk Bold', group: 'Lighter (use with many people)' },
  { family: 'Inter Variable', weight: 900, label: 'Inter Black', group: 'Lighter (use with many people)' },
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
  const [font, setFont] = useState<FontChoice>(BUILTIN_FONTS[0]!);
  const [letterSpacing, setLetterSpacing] = useState(0.04);
  const [file, setFile] = useState<File | null>(null);
  const [imgMode, setImgMode] = useState<'auto' | 'alpha' | 'luminance'>('auto');
  const [invert, setInvert] = useState(false);
  const [mask, setMask] = useState<Mask | null>(null);
  const [maskError, setMaskError] = useState<string | null>(null);
  // Curved layout: the message is cut at the spaces and laid along the shape of the area.
  // Fonts the organizer imported for this event: registered with the document so the canvas that
  // renders the design mask can draw with them.
  const fontAssets = useFontAssets(event.id);
  const [fontError, setFontError] = useState<string | null>(null);
  const [importingFont, setImportingFont] = useState(false);
  const [facesReady, setFacesReady] = useState(0);
  const importedFonts = useMemo<FontChoice[]>(
    () =>
      (fontAssets.data ?? []).map((a) => ({
        family: familyForAsset(a.id),
        weight: 400,
        label: fontDisplayName(a.file_name),
        group: 'Imported',
        assetId: a.id,
        storagePath: a.storage_path,
      })),
    [fontAssets.data],
  );
  const fonts = useMemo(() => [...BUILTIN_FONTS, ...importedFonts], [importedFonts]);
  const [curved, setCurved] = useState(false);
  const [segmentMasks, setSegmentMasks] = useState<Mask[] | null>(null);
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const f of importedFonts) {
        try {
          await ensureAssetFont(f.assetId!, f.storagePath!);
        } catch (e) {
          if (alive) setFontError((e as Error).message);
        }
      }
      // The design is drawn on canvas, so it must be redrawn once the face is actually available.
      if (alive && importedFonts.length > 0) setFacesReady((n) => n + 1);
    })();
    return () => {
      alive = false;
    };
  }, [importedFonts]);

  // A font deleted elsewhere (or by us) must not stay selected: the canvas would fall back silently.
  useEffect(() => {
    if (font.assetId && fontAssets.data && !importedFonts.some((f) => f.assetId === font.assetId)) setFont(BUILTIN_FONTS[0]!);
  }, [importedFonts, font, fontAssets.data]);

  const onImportFont = async (file: File) => {
    setFontError(null);
    setImportingFont(true);
    try {
      const { id, storagePath } = await importFont(event.id, file);
      await qc.invalidateQueries({ queryKey: ['fonts', event.id] });
      setFont({ family: familyForAsset(id), weight: 400, label: fontDisplayName(file.name), group: 'Imported', assetId: id, storagePath });
    } catch (e) {
      setFontError((e as Error).message);
    } finally {
      setImportingFont(false);
    }
  };

  const onDeleteFont = async (f: FontChoice) => {
    setFontError(null);
    try {
      await deleteFont(f.assetId!, f.storagePath!);
      setFont(BUILTIN_FONTS[0]!);
      await qc.invalidateQueries({ queryKey: ['fonts', event.id] });
    } catch (e) {
      setFontError((e as Error).message);
    }
  };

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        let m: Mask | null = null;
        let segs: Mask[] | null = null;
        if (mode === 'text' && text.trim()) {
          await ensureFontLoaded(font.family, font.weight);
          const o = { text, fontFamily: font.family, fontWeight: font.weight, letterSpacingEm: letterSpacing, resolution: 2400 };
          m = renderTextMask(o);
          if (curved) segs = renderTextSegmentMasks(o);
        } else if (mode === 'image' && file) {
          m = await renderImageMask(file, { mode: imgMode, invert, resolution: 2400 });
        }
        if (alive) {
          setMask(m);
          setSegmentMasks(segs);
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
  }, [mode, text, font, letterSpacing, file, imgMode, invert, curved, facesReady]);

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const auto = sizing === 'fit' && autoPlace;
  // A curved layout needs the engine to choose the placement: it solves the whole curve at once.
  const useCurved = curved && mode === 'text' && auto && (segmentMasks?.length ?? 0) > 0;
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
    setCurved(false);
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
        segments: useCurved ? { masks: segmentMasks! } : undefined,
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
        // A curved layout has one rotation per segment, so there is nothing to put in the slider.
        if (!res.blocks) setRotation(Math.round(res.rotationDeg));
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
        source = { kind: 'text', text, fontFamily: font.family, fontName: font.label, fontAssetId: font.assetId, fontWeight: font.weight, letterSpacingEm: letterSpacing, lineHeightEm: 1.05, curved: useCurved, segments: useCurved ? words : undefined };
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
      const params = { sizing, targetCount: result.points.length, targetSpacingM: targetSpacing, widthM: result.widthM, heightM: result.heightM, rotationDeg: result.rotationDeg, autoPlace: auto, minSpacingM: minSpacing, anchor: result.anchor, seed, zoneSize, engine: ENGINE_VERSION, curved: useCurved, blocks: result.blocks };
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
  // Either boundary is enough: the formation area alone is the stricter one.
  const noArea = !constraintsCount.perimeter && !constraintsCount.formationArea;

  const previewLayer: PointsLayer | null = useMemo(
    () => (result ? { lat: result.points.map((p) => p.lat), lng: result.points.map((p) => p.lng) } : null),
    [result],
  );

  return (
    <div className="space-y-6">
      {!formationEditable(event.state) && <Alert tone="warn">The formation is frozen at this stage of the event ({event.state}).</Alert>}
      {noArea && <Alert tone="warn">Draw the event perimeter (or a formation area) in "Location &amp; safety" first: the engine keeps every pixel inside it.</Alert>}
      {!noArea && !constraintsCount.perimeter && (
        <Alert>Using the formation area as the boundary. A perimeter is still required before you can open registration.</Alert>
      )}
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
                {/* The import control sits OUTSIDE Field: Field is a <label>, and a nested one
                    would hand the click to the select instead of the file input. */}
                <div>
                  <Field label="Font">
                    <Select value={font.family} onChange={(e) => setFont(fonts.find((f) => f.family === e.target.value) ?? BUILTIN_FONTS[0]!)}>
                      {[...new Set(fonts.map((f) => f.group))].map((g) => (
                        <optgroup key={g} label={g}>
                          {fonts.filter((f) => f.group === g).map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <label className={`inline-flex cursor-pointer items-center gap-1.5 underline hover:text-text ${importingFont ? 'pointer-events-none opacity-50' : ''}`}>
                      <Upload size={12} />
                      {importingFont ? 'Importing…' : 'Import a font'}
                      <input
                        type="file"
                        accept={FONT_ACCEPT}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void onImportFont(f);
                        }}
                      />
                    </label>
                    <span>.ttf, .otf, .woff, .woff2 — up to 5 MB</span>
                    {font.assetId && (
                      <button type="button" className="underline hover:text-text" onClick={() => void onDeleteFont(font)}>
                        Remove "{font.label}"
                      </button>
                    )}
                  </div>
                  {fontError && <div className="mt-2"><Alert tone="bad">{fontError}</Alert></div>}
                </div>
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
              {sizing === 'fit' && mode === 'text' && (
                <label className={`col-span-2 flex items-start gap-2.5 rounded-lg border p-2.5 text-sm ${autoPlace ? 'cursor-pointer border-line' : 'cursor-not-allowed border-line/40 opacity-50'}`}>
                  <input type="checkbox" disabled={!autoPlace} checked={curved} onChange={(e) => setCurved(e.target.checked)} className="mt-0.5 accent-[var(--hp-pixel)]" />
                  <span>
                    <span className="block">Follow the shape of the area{words.length > 1 ? ` (${words.length} segments)` : ''}</span>
                    <span className="block text-xs text-muted">
                      The message is cut at the spaces and laid along the curve, every segment turned to the ground under it and all the same size.
                      On a bent beach the letters get far bigger than one straight block allows.
                    </span>
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
                hint={useCurved ? 'One rotation per segment: the message follows the curve.' : auto ? 'Chosen automatically to fill the area.' : rotation === alignedRotation ? 'Reads left→right in the map view.' : undefined}
              >
                <input type="range" min={-180} max={180} value={rotation} disabled={auto} onChange={(e) => setRotation(Number(e.target.value))} className="w-full accent-[var(--hp-pixel)]" />
                {!auto && rotation !== alignedRotation && (
                  <Button size="sm" variant="ghost" onClick={() => setRotation(alignedRotation)}>Align with the map view ({alignedRotation}°)</Button>
                )}
              </Field>
              <Field label="Min. spacing (m)" hint="Crowd safety floor"><Input type="number" min={0.6} max={5} step={0.05} value={minSpacing} onChange={(e) => setMinSpacing(Number(e.target.value))} /></Field>
              {/* Zones are marshalling groups (A, B, C…) of the SAME people: never extra participants. */}
              <Field label="Zones" hint="Marshalling groups on the day, not extra people">
                <Input disabled value={result ? `${result.zones.length} (${result.zones.map((z) => z.label).join(' ')})` : ''} placeholder="—" />
              </Field>
              <div className="col-span-2">
                <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-muted underline hover:text-text">
                  {showAdvanced ? 'Hide advanced' : 'Advanced: zone size'}
                </button>
                {showAdvanced && (
                  <div className="mt-2">
                    <Field label="People per zone" hint="How many people one marshal group holds. Only splits the crowd into zones A, B, C…; the pixel count never changes.">
                      <Input type="number" min={100} max={20000} step={100} value={zoneSize} onChange={(e) => setZoneSize(Number(e.target.value))} />
                    </Field>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Anchor {anchor ? `${anchor.lat.toFixed(6)}, ${anchor.lng.toFixed(6)}` : 'not set'}</span>
              <Button size="sm" variant="ghost" disabled={auto} onClick={() => setPlacingAnchor((v) => !v)}>{placingAnchor ? 'Click on the map…' : 'Move anchor'}</Button>
              <Button size="sm" variant="ghost" icon={<Dices size={14} />} onClick={() => setSeed(randomSeed())}>Seed {seed}</Button>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" icon={<Wand2 size={16} />} disabled={!editable || !mask || !anchor || (sizing === 'count' && !width) || noArea || !!progress} onClick={generate}>Generate</Button>
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
          {result && sizing === 'fit' && mode === 'text' && !useCurved && text.includes(String.fromCharCode(10)) && result.metrics.footprintHeightM * 3 > result.metrics.footprintWidthM && (
            <Alert>Your area is long and narrow: a message on a single line would fill much more of it (more people, thicker letters).</Alert>
          )}
          {result && useCurved && result.blocks && result.blocks.length > 1 && bendOf(result.blocks) > 45 && (
            <Alert tone="warn">
              The message bends by {Math.round(bendOf(result.blocks))}° across the area. It reads well from straight above, but from a low
              drone angle the far end will be read at a slant — check the shot before the day.
            </Alert>
          )}
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
    // A curved message lies along the ground, not along the design axes, so the preview is turned
    // to its average heading: a beach running north–south would otherwise draw a tower of pixels.
    const view = result.blocks?.length ? -meanHeading(result.blocks) : 0;
    const rad = (view * Math.PI) / 180;
    const cs = Math.cos(rad);
    const sn = Math.sin(rad);
    const at = (p: { dx: number; dy: number }) => ({ x: p.dx * cs - p.dy * sn, y: p.dx * sn + p.dy * cs });
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of result.points) {
      const q = at(p);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    const pad = result.metrics.spacingM * 2;
    const spanX = Math.max(1, maxX - minX + pad * 2);
    const spanY = Math.max(1, maxY - minY + pad * 2);
    const H = Math.max(80, Math.round((W * spanY) / spanX));
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e9dcc0'; // sand
    ctx.fillRect(0, 0, W, H);
    const sx = W / spanX;
    const k = Math.floor((result.points.length * turnout) / 100);
    const r = Math.max(0.8, Math.min(4, (result.metrics.spacingM * sx) / 2.4));
    ctx.fillStyle = '#16121f';
    for (const p of result.points) {
      if (p.fillRank >= k) continue;
      const q = at(p);
      ctx.beginPath();
      ctx.arc((q.x - minX + pad) * sx, (maxY + pad - q.y) * sx, r, 0, Math.PI * 2);
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

/** Average heading of the segments (circular mean, so headings near ±180° still average sanely). */
function meanHeading(blocks: { rotationDeg: number; widthM: number }[]): number {
  let x = 0;
  let y = 0;
  for (const b of blocks) {
    const r = (b.rotationDeg * Math.PI) / 180;
    x += Math.cos(r) * b.widthM;
    y += Math.sin(r) * b.widthM;
  }
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** How much a curved message turns between its first and last segment. */
function bendOf(blocks: { rotationDeg: number }[]): number {
  const r = blocks.map((b) => b.rotationDeg);
  return Math.max(...r) - Math.min(...r);
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
        <Stat
          label="Footprint"
          value={`${Math.round(m.footprintWidthM)}×${Math.round(m.footprintHeightM)}`}
          sub={result.blocks && result.blocks.length > 1 ? `m · ${result.blocks.length} segments, ${Math.round(result.blocks[0]!.heightM)} m tall, bends ${Math.round(bendOf(result.blocks))}°` : 'metres'}
        />
        <Stat label="Stroke width" value={`${m.strokePersonsP20.toFixed(1)}`} sub="people (thinnest 20%)" />
        <Stat label="Density" value={m.densityPerM2.toFixed(2)} sub="people / m²" />
        <Stat label="Zones" value={result.zones.length} sub={result.zones.map((z) => z.label).join(' ')} />
        <Stat label="Clipped" value={`${(m.clippedFraction * 100).toFixed(1)}%`} sub="by safety areas" />
        <Stat label="Engine" value={`${(m.generationMs / 1000).toFixed(1)} s`} sub={`${m.lloydIterations} relax passes`} />
      </div>
      <p className="mt-4 text-xs text-muted">
        Readability rates the aerial photo, not this preview (which shows every pixel, i.e. a perfect turnout).
        It weighs stroke thickness ({m.strokePersonsP20.toFixed(1)} people, 60 %), spacing ({m.nnMeanM.toFixed(2)} m, 25 %)
        and how much of the design was clipped ({(m.clippedFraction * 100).toFixed(1)} %, 15 %). Thin strokes lose the
        most: at {m.strokePersonsP20.toFixed(1)} people wide, missing participants open gaps in the letters.
      </p>
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
