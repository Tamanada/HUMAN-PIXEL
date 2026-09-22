/**
 * Progressive fill order. Rank points so that EVERY prefix of the order is spread evenly over the
 * whole design. Assigning participants in this order means an event with 70% turnout still shows
 * the complete image at 70% density, instead of a complete top half and a missing bottom.
 *
 * Method: hierarchical grid decimation, coarse to fine. At each level, every grid cell that does
 * not yet contain a selected point contributes its point nearest the cell centre. Cell visit order
 * is shuffled per level so that partial levels have no directional bias.
 */
import { mulberry32, shuffleInPlace } from './random';

export function progressiveFillOrder(xs: Float64Array, ys: Float64Array, n: number, spacing: number, seed = 1): Int32Array {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  const extent = Math.max(maxX - minX, maxY - minY, spacing);
  const selected = new Uint8Array(n);
  const order = new Int32Array(n);
  let count = 0;

  let cell = spacing;
  while (cell < extent) cell *= 2;

  for (; cell >= spacing * 0.5 && count < n; cell /= 2) {
    const cols = Math.ceil((maxX - minX) / cell) + 1;
    const rows = Math.ceil((maxY - minY) / cell) + 1;
    const cells = cols * rows;
    const occupied = new Uint8Array(cells);
    const bestIdx = new Int32Array(cells).fill(-1);
    const bestD = new Float64Array(cells).fill(Infinity);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((xs[i]! - minX) / cell);
      const cy = Math.floor((ys[i]! - minY) / cell);
      const c = cy * cols + cx;
      if (selected[i]) {
        occupied[c] = 1;
        continue;
      }
      const dx = xs[i]! - (minX + (cx + 0.5) * cell);
      const dy = ys[i]! - (minY + (cy + 0.5) * cell);
      const d = dx * dx + dy * dy;
      if (d < bestD[c]!) {
        bestD[c] = d;
        bestIdx[c] = i;
      }
    }
    const visit = new Int32Array(cells);
    for (let c = 0; c < cells; c++) visit[c] = c;
    shuffleInPlace(visit, rand);
    for (let k = 0; k < cells; k++) {
      const c = visit[k]!;
      const i = bestIdx[c]!;
      if (i >= 0 && !occupied[c]) {
        selected[i] = 1;
        order[count++] = i;
      }
    }
  }
  // Leftovers (cells holding several points at the finest level), in random order.
  if (count < n) {
    const rest: number[] = [];
    for (let i = 0; i < n; i++) if (!selected[i]) rest.push(i);
    shuffleInPlace(rest, rand);
    for (const i of rest) order[count++] = i;
  }
  // Convert "order" (rank -> index) into "rank" (index -> rank).
  const rank = new Int32Array(n);
  for (let r = 0; r < n; r++) rank[order[r]!] = r;
  return rank;
}
