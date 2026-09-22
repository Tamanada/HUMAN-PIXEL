/**
 * Formation pipeline glue: run the engine in a worker, then upload → validate → (lock).
 * The database re-validates everything; this client is never trusted for safety.
 */
import {
  chunk,
  coverageFraction,
  geoJsonPolygonToLatLng,
  pointsChecksum,
  toPointRows,
  type EngineRequest,
  type EngineResponse,
  type FormationInput,
  type FormationResult,
  type FormationStage,
  type LatLng,
  type Mask,
  type Polygon,
} from '@human-pixel/core';
import { rpc } from '../../lib/supabase';
import type { AreaRow } from '../../lib/types';

export const ENGINE_VERSION = 'hp-engine/1.0';

let seq = 0;
export function runEngine(input: Omit<FormationInput, 'onProgress'>, onProgress: (stage: FormationStage, f: number) => void): { promise: Promise<FormationResult>; cancel: () => void } {
  const worker = new Worker(new URL('../../workers/formation.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const promise = new Promise<FormationResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<EngineResponse>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress(m.stage, m.fraction);
      else if (m.type === 'done') {
        resolve(m.result);
        worker.terminate();
      } else {
        const err = new Error(m.message) as Error & { code?: string; details?: Record<string, number> };
        err.code = m.code;
        err.details = m.details;
        reject(err);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Engine crashed'));
      worker.terminate();
    };
    worker.postMessage({ id, type: 'generate', input } satisfies EngineRequest);
  });
  return { promise, cancel: () => worker.terminate() };
}

/** Converts console areas to engine constraints. Multi-polygons become several exclusions. */
export function constraintsFromAreas(areas: AreaRow[]): { perimeter: Polygon<LatLng> | null; formationArea: Polygon<LatLng> | null; exclusions: { polygon: Polygon<LatLng>; bufferM: number }[] } {
  const polys = (g: GeoJSON.Geometry): Polygon<LatLng>[] =>
    g.type === 'Polygon'
      ? [geoJsonPolygonToLatLng(g as never)]
      : g.type === 'MultiPolygon'
        ? g.coordinates.map((c) => geoJsonPolygonToLatLng({ type: 'Polygon', coordinates: c as [number, number][][] }))
        : [];
  const per = areas.find((a) => a.kind === 'perimeter');
  const fa = areas.find((a) => a.kind === 'formation_area');
  return {
    perimeter: per ? polys(per.geom)[0] ?? null : null,
    formationArea: fa ? polys(fa.geom)[0] ?? null : null,
    exclusions: areas
      .filter((a) => a.kind === 'exclusion' || a.kind === 'no_go' || a.kind === 'emergency')
      .flatMap((a) => polys(a.geom).map((polygon) => ({ polygon, bufferM: a.safety_buffer_m }))),
  };
}

/** Width that yields `targetSpacing` for N people given the design's ink coverage (hex packing). */
export function suggestWidth(mask: Mask, n: number, targetSpacing: number): number {
  const c = Math.max(1e-6, coverageFraction(mask));
  const aspect = mask.height / mask.width;
  const area = (n * Math.sqrt(3) * targetSpacing * targetSpacing) / 2;
  return Math.sqrt(area / (c * aspect));
}

export interface SaveProgress {
  phase: 'create' | 'upload' | 'validate';
  done: number;
  total: number;
}

export async function saveFormation(
  eventId: string,
  result: FormationResult,
  source: Record<string, unknown>,
  params: Record<string, unknown>,
  onProgress: (p: SaveProgress) => void,
): Promise<{ formationId: string; report: Record<string, unknown> & { ok: boolean } }> {
  const n = result.points.length;
  onProgress({ phase: 'create', done: 0, total: n });
  const formationId = await rpc<string>('formation_create', {
    p_event_id: eventId,
    p_source: source,
    p_params: params,
    p_point_count: n,
    p_seed: result.seed,
    p_engine_version: ENGINE_VERSION,
    p_metrics: result.metrics,
    p_warnings: result.warnings,
    p_zones: result.zones.map((z) => ({ zone: z.zone, label: z.label, count: z.count, lat: z.centroid.lat, lng: z.centroid.lng })),
  });
  const parts = chunk(toPointRows(result.points), 5000);
  let done = 0;
  // Three chunks in flight: fast, but gentle on the connection pool. Each chunk is idempotent.
  const queue = [...parts];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const part = queue.shift()!;
        await withRetry(() => rpc('formation_upload_points', { p_formation_id: formationId, p_rows: part }));
        done += part.length;
        onProgress({ phase: 'upload', done, total: n });
      }
    }),
  );
  onProgress({ phase: 'validate', done: n, total: n });
  const report = await rpc<Record<string, unknown> & { ok: boolean }>('formation_finalize', { p_formation_id: formationId, p_checksum: pointsChecksum(result.points) });
  return { formationId, report };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i * (0.5 + Math.random())));
    }
  }
  throw last;
}
