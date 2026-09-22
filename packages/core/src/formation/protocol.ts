/**
 * Worker protocol for running the engine off the main thread, plus the compact wire format used
 * to upload points to the database in chunks.
 */
import type { FormationInput, FormationResult, FormationStage } from './engine';
import type { FormationPoint } from './engine';

export type EngineRequest = { id: number; type: 'generate'; input: Omit<FormationInput, 'onProgress'> };

export type EngineResponse =
  | { id: number; type: 'progress'; stage: FormationStage; fraction: number }
  | { id: number; type: 'done'; result: FormationResult }
  | { id: number; type: 'error'; code: string; message: string; details?: Record<string, number> };

/** Columnar upload row, matching `formation_upload_points(p_points jsonb)` in SQL. */
export type PointRow = [idx: number, lat: number, lng: number, x: number, y: number, zone: number, fillRank: number, label: number];

export function toPointRows(points: FormationPoint[]): PointRow[] {
  return points.map((p) => [
    p.idx,
    Math.round(p.lat * 1e8) / 1e8,
    Math.round(p.lng * 1e8) / 1e8,
    Math.round(p.x * 1000) / 1000,
    Math.round(p.y * 1000) / 1000,
    p.zone,
    p.fillRank,
    p.label,
  ]);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Order-independent checksum that the server recomputes (sum of idx·label mod 2^31). */
export function pointsChecksum(points: Pick<FormationPoint, 'idx' | 'label'>[]): number {
  let s = 0;
  for (const p of points) s = (s + ((p.idx + 1) * p.label) % 2147483647) % 2147483647;
  return s;
}
