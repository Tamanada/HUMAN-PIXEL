/**
 * Coverage masks: the design as seen from above. 0 = empty ground, 255 = fully "ink".
 * Anti-aliased coverage (not a 1-bit bitmap) lets the engine place edges with sub-pixel accuracy.
 */

export interface Mask {
  width: number;
  height: number;
  /** Row-major, row 0 at the TOP of the design. */
  data: Uint8Array;
}

export function createMask(width: number, height: number): Mask {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Mask dimensions must be positive integers');
  }
  return { width, height, data: new Uint8Array(width * height) };
}

/** Bilinear coverage sample in [0, 1] at continuous pixel coordinates (pixel centres at +0.5). */
export function sampleMask(m: Mask, u: number, v: number): number {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xi: number, yi: number) =>
    xi < 0 || yi < 0 || xi >= m.width || yi >= m.height ? 0 : m.data[yi * m.width + xi]!;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return (top * (1 - fy) + bottom * fy) / 255;
}

export function coverageFraction(m: Mask): number {
  let s = 0;
  for (let i = 0; i < m.data.length; i++) s += m.data[i]!;
  return s / (255 * m.data.length);
}

/** Crops to the bounding box of pixels with coverage > threshold, plus padding. */
export function trimMask(m: Mask, threshold = 8, pad = 2): Mask {
  let minX = m.width;
  let minY = m.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (m.data[y * m.width + x]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return createMask(1, 1);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(m.width - 1, maxX + pad);
  maxY = Math.min(m.height - 1, maxY + pad);
  const out = createMask(maxX - minX + 1, maxY - minY + 1);
  for (let y = 0; y < out.height; y++) {
    const src = (y + minY) * m.width + minX;
    out.data.set(m.data.subarray(src, src + out.width), y * out.width);
  }
  return out;
}

/** Converts RGBA pixels to coverage. `alpha`: use transparency; `luminance`: dark = ink. */
export function maskFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mode: 'alpha' | 'luminance' | 'auto' = 'auto',
  invert = false,
): Mask {
  const m = createMask(width, height);
  let resolved = mode;
  if (mode === 'auto') {
    // If the image has meaningful transparency, trust alpha; otherwise use luminance.
    let transparent = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 250) transparent++;
    resolved = transparent > (width * height) / 50 ? 'alpha' : 'luminance';
  }
  for (let i = 0, p = 0; p < m.data.length; i += 4, p++) {
    const a = rgba[i + 3]! / 255;
    let c: number;
    if (resolved === 'alpha') {
      c = a;
    } else {
      const lum = (0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!) / 255;
      // Transparent pixels count as background (white).
      c = (1 - lum) * a;
    }
    if (invert) c = 1 - c;
    m.data[p] = Math.round(c * 255);
  }
  return m;
}

/** Paints a filled axis-aligned rectangle (pixel units). Used by tests and simple shapes. */
export function fillRect(m: Mask, x: number, y: number, w: number, h: number, value = 255): void {
  for (let j = Math.max(0, y); j < Math.min(m.height, y + h); j++) {
    m.data.fill(value, j * m.width + Math.max(0, x), j * m.width + Math.min(m.width, x + w));
  }
}

/** Anti-aliased filled ellipse (4×4 supersampling). */
export function fillEllipse(m: Mask, cx: number, cy: number, rx: number, ry: number, ringInner = 0): void {
  const ss = 4;
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    if (y < 0 || y >= m.height) continue;
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      if (x < 0 || x >= m.width) continue;
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = (x + (sx + 0.5) / ss - cx) / rx;
          const dy = (y + (sy + 0.5) / ss - cy) / ry;
          const d = dx * dx + dy * dy;
          if (d <= 1 && d >= ringInner * ringInner) hit++;
        }
      }
      const idx = y * m.width + x;
      m.data[idx] = Math.max(m.data[idx]!, Math.round((hit / (ss * ss)) * 255));
    }
  }
}
