/**
 * Browser-only mask producers (Canvas / OffscreenCanvas). Imported via
 * `@human-pixel/core/formation-browser` so Node code never touches the DOM.
 */
import { createMask, maskFromRgba, trimMask, type Mask } from './mask';

export interface TextMaskOptions {
  text: string;
  fontFamily: string;
  fontWeight?: number;
  /** Letter spacing in em. */
  letterSpacingEm?: number;
  /** Line height in em (multi-line text). */
  lineHeightEm?: number;
  /** Resolution of the longest side, pixels. */
  resolution?: number;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: AnyCtx } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

export async function ensureFontLoaded(fontFamily: string, weight: number): Promise<void> {
  const fonts = (globalThis as { document?: Document }).document?.fonts ?? (globalThis as unknown as { fonts?: FontFaceSet }).fonts;
  if (fonts?.load) await fonts.load(`${weight} 100px "${fontFamily}"`);
}

export function renderTextMask(o: TextMaskOptions): Mask {
  const lines = o.text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('Text is empty');
  const resolution = o.resolution ?? 2400;
  const weight = o.fontWeight ?? 800;
  const size = 200;
  const font = `${weight} ${size}px "${o.fontFamily}", sans-serif`;
  const probe = makeCanvas(8, 8).ctx;
  probe.font = font;
  const spacingPx = (o.letterSpacingEm ?? 0.04) * size;
  const measure = (l: string) => probe.measureText(l).width + spacingPx * Math.max(0, [...l].length - 1);
  const lineH = (o.lineHeightEm ?? 1.05) * size;
  const textW = Math.max(...lines.map(measure));
  const textH = lineH * lines.length;
  const pad = size * 0.3;
  const scale = resolution / Math.max(textW + pad * 2, textH + pad * 2);
  const w = Math.max(8, Math.ceil((textW + pad * 2) * scale));
  const h = Math.max(8, Math.ceil((textH + pad * 2) * scale));
  const { ctx } = makeCanvas(w, h);
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  lines.forEach((line, li) => {
    const lw = measure(line);
    let x = pad + (textW - lw) / 2;
    const y = pad + lineH * (li + 0.5);
    if (spacingPx === 0) {
      ctx.fillText(line, x, y);
    } else {
      for (const ch of line) {
        ctx.fillText(ch, x, y);
        x += probe.measureText(ch).width + spacingPx;
      }
    }
  });
  const img = ctx.getImageData(0, 0, w, h);
  return trimMask(maskFromRgba(img.data, w, h, 'alpha'), 8, Math.round(4 * scale));
}

/** Rectangle of a mask, as a new mask. */
function crop(m: Mask, x0: number, y0: number, w: number, h: number): Mask {
  const out = createMask(Math.max(1, w), Math.max(1, h));
  for (let y = 0; y < out.height; y++) {
    const src = (y + y0) * m.width + x0;
    out.data.set(m.data.subarray(src, src + out.width), y * out.width);
  }
  return out;
}

/** Columns of a mask that carry ink. */
function inkColumns(m: Mask, threshold: number): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  for (let x = 0; x < m.width; x++) {
    let on = false;
    for (let y = 0; y < m.height && !on; y++) on = m.data[y * m.width + x]! > threshold;
    if (on) {
      if (from < 0) from = x;
      to = x;
    }
  }
  return from < 0 ? null : { from, to };
}

/**
 * One mask per segment of the message, cut at spaces and line breaks, ALL THE SAME HEIGHT.
 *
 * A curved layout gives every segment the same height on the ground, so the masks must share their
 * vertical box: trimmed one by one, a word without descenders would come out taller than its
 * neighbours and its letters bigger. They are cropped together to the band the whole message
 * really uses, then each one is trimmed horizontally so it hugs its own word.
 */
export function renderTextSegmentMasks(o: TextMaskOptions): Mask[] {
  const words = o.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('Text is empty');
  const weight = o.fontWeight ?? 800;
  const size = 200;
  const font = `${weight} ${size}px "${o.fontFamily}", sans-serif`;
  const probe = makeCanvas(8, 8).ctx;
  probe.font = font;
  const spacingPx = (o.letterSpacingEm ?? 0.04) * size;
  const measure = (l: string) => probe.measureText(l).width + spacingPx * Math.max(0, [...l].length - 1);
  const lineH = (o.lineHeightEm ?? 1.05) * size;
  const padX = size * 0.15;
  const padY = size * 0.3;
  // A common box height in pixels: every segment is rendered into the same vertical frame.
  const boxH = Math.min(o.resolution ?? 2400, 720);
  const scale = boxH / (lineH + padY * 2);
  const masks = words.map((word) => {
    const w = Math.max(8, Math.ceil((measure(word) + padX * 2) * scale));
    const { ctx } = makeCanvas(w, boxH);
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    let x = padX;
    const y = padY + lineH / 2;
    if (spacingPx === 0) ctx.fillText(word, x, y);
    else {
      for (const ch of word) {
        ctx.fillText(ch, x, y);
        x += probe.measureText(ch).width + spacingPx;
      }
    }
    return maskFromRgba(ctx.getImageData(0, 0, w, boxH).data, w, boxH, 'alpha');
  });
  // Crop every segment to the same band: the rows the message as a whole actually uses.
  let top = boxH;
  let bottom = -1;
  for (const m of masks) {
    for (let y = 0; y < m.height; y++) {
      let on = false;
      for (let x = 0; x < m.width && !on; x++) on = m.data[y * m.width + x]! > 8;
      if (on) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (bottom < 0) throw new Error('Text is empty');
  const pad = Math.round(boxH * 0.02);
  const y0 = Math.max(0, top - pad);
  const h = Math.min(boxH - y0, bottom - top + 1 + pad * 2);
  return masks.map((m) => {
    const cols = inkColumns(m, 8);
    const x0 = cols ? Math.max(0, cols.from - pad) : 0;
    const w = cols ? Math.min(m.width - x0, cols.to - cols.from + 1 + pad * 2) : m.width;
    return crop(m, x0, y0, w, h);
  });
}

export interface ImageMaskOptions {
  mode?: 'alpha' | 'luminance' | 'auto';
  invert?: boolean;
  resolution?: number;
}

/** Decodes PNG / JPEG / WebP / SVG blobs into a coverage mask. */
export async function renderImageMask(blob: Blob, o: ImageMaskOptions = {}): Promise<Mask> {
  const resolution = o.resolution ?? 2400;
  let source: ImageBitmap | HTMLImageElement;
  let sw: number;
  let sh: number;
  if (blob.type === 'image/svg+xml') {
    // SVGs have no intrinsic raster size: load through <img> so the browser rasterizes vectors.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      sw = img.naturalWidth || 1000;
      sh = img.naturalHeight || 1000;
      source = img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  } else {
    source = await createImageBitmap(blob);
    sw = source.width;
    sh = source.height;
  }
  const scale = resolution / Math.max(sw, sh);
  const w = Math.max(8, Math.round(sw * scale));
  const h = Math.max(8, Math.round(sh * scale));
  const { ctx } = makeCanvas(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return trimMask(maskFromRgba(data, w, h, o.mode ?? 'auto', o.invert ?? false));
}

/** Rasterizes a mask to an ImageData-compatible RGBA buffer for previews. */
export function maskToRgba(m: Mask, rgb: [number, number, number] = [255, 255, 255]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(m.width * m.height * 4);
  for (let p = 0, i = 0; p < m.data.length; p++, i += 4) {
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = m.data[p]!;
  }
  return out;
}
