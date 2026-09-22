/**
 * Browser-only mask producers (Canvas / OffscreenCanvas). Imported via
 * `@human-pixel/core/formation-browser` so Node code never touches the DOM.
 */
import { maskFromRgba, trimMask, type Mask } from './mask';

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
