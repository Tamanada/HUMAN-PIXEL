/**
 * Uniform spatial hash over point arrays (counting sort, no per-point allocations).
 * Nearest-neighbour queries are O(1) on average for quasi-uniform point sets.
 */
export class SpatialGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly order: Int32Array;

  constructor(
    readonly xs: Float64Array,
    readonly ys: Float64Array,
    readonly n: number,
    readonly cell: number,
    readonly minX: number,
    readonly minY: number,
    maxX: number,
    maxY: number,
  ) {
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    const cells = this.cols * this.rows;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(xs[i]!, ys[i]!);
      cellOf[i] = c;
      counts[c + 1]!++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts;
    this.order = new Int32Array(n);
    const fill = counts.slice(0, cells);
    for (let i = 0; i < n; i++) this.order[fill[cellOf[i]!]!++] = i;
  }

  cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.cols + cx;
  }

  /** Visit indices in the (2r+1)² block of cells around (x, y). */
  forEachNear(x: number, y: number, r: number, fn: (i: number) => void): void {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cy = Math.floor((y - this.minY) / this.cell);
    for (let gy = Math.max(0, cy - r); gy <= Math.min(this.rows - 1, cy + r); gy++) {
      for (let gx = Math.max(0, cx - r); gx <= Math.min(this.cols - 1, cx + r); gx++) {
        const c = gy * this.cols + gx;
        for (let k = this.cellStart[c]!; k < this.cellStart[c + 1]!; k++) fn(this.order[k]!);
      }
    }
  }

  /** Nearest point index (excluding `skip`), searching outward up to maxRing cells. */
  nearest(x: number, y: number, skip = -1, maxRing = 3): { index: number; dist2: number } {
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= maxRing; r++) {
      this.forEachNear(x, y, r, (i) => {
        if (i === skip) return;
        const dx = this.xs[i]! - x;
        const dy = this.ys[i]! - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      // A hit within r cells is guaranteed nearest if closer than r·cell.
      if (best >= 0 && bestD <= (r * this.cell) ** 2) break;
    }
    return { index: best, dist2: bestD };
  }
}
