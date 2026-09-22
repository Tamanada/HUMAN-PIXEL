/**
 * Map symbols for access points, coloured by the international safety-sign standards:
 *   ISO 3864-1 safety colours + ISO 7010 sign families
 *   - green  = safe condition   (E-series: emergency exit, first aid, assembly point)
 *   - red    = fire equipment   (F-series: fire extinguisher)
 *   - yellow = warning          (W-series: general danger), black glyph on yellow
 *   - blue   = mandatory action / information (M-series; ISO 7001 public information)
 * Colours are the usual sRGB renderings of the RAL references quoted by ISO 3864-4.
 */
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BadgeCheck,
  BriefcaseMedical,
  Cross,
  DoorOpen,
  Droplet,
  Drone,
  Info,
  LogIn,
  MapPin,
  PackageSearch,
  ShieldCheck,
  Toilet,
  type LucideProps,
} from 'lucide-react';

export const SAFETY = {
  green: '#009A44', // RAL 6032 signal green
  red: '#D52B1E', // RAL 3001 signal red
  yellow: '#F9A800', // RAL 1003 signal yellow
  blue: '#0059A3', // RAL 5005 signal blue
  grey: '#5B6270',
} as const;

export interface PointSymbol {
  id: string;
  label: string;
  color: string;
  /** Glyph colour: white, except black on the yellow warning family (ISO 3864). */
  ink: '#ffffff' | '#000000';
  icon: ComponentType<LucideProps>;
  /** Organizer-imported logo (PNG data URL); drawn instead of the pictogram. */
  image?: string;
  /** The standard the colour follows, shown as a tooltip. */
  norm: string;
  /** Created by the organizer for this event (can be deleted). */
  custom?: boolean;
}

/** Row of public.event_symbols. */
export interface EventSymbolRow {
  id: string;
  event_id: string;
  label: string;
  color: string;
  icon: string | null;
}

export function customSymbol(row: EventSymbolRow): PointSymbol {
  return { id: row.id, label: row.label, color: row.color, ink: inkFor(row.color), icon: MapPin, image: row.icon ?? undefined, norm: 'Custom type', custom: true };
}

/** White glyph on dark colours, black on light ones (as ISO does on yellow). */
export function inkFor(hex: string): '#ffffff' | '#000000' {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#000000' : '#ffffff';
}

/** Fits any image into a size×size transparent PNG (logo kept whole, centred): a few KB. */
export async function imageToPngDataUrl(file: File, size = 64): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('This file is not an image the browser can read.'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    const k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const POINT_SYMBOLS: PointSymbol[] = [
  { id: 'entrance', label: 'Entrance', color: SAFETY.blue, ink: '#ffffff', icon: LogIn, norm: 'ISO 7001 public information, blue' },
  { id: 'exit', label: 'Exit', color: SAFETY.green, ink: '#ffffff', icon: DoorOpen, norm: 'ISO 7010 E001 (emergency exit), safety green' },
  { id: 'medical', label: 'Medical point', color: SAFETY.green, ink: '#ffffff', icon: Cross, norm: 'ISO 7010 E003 (first aid), safety green' },
  { id: 'first_aid', label: 'First aid', color: SAFETY.green, ink: '#ffffff', icon: BriefcaseMedical, norm: 'ISO 7010 E003, safety green' },
  { id: 'staff', label: 'Staff', color: SAFETY.blue, ink: '#ffffff', icon: BadgeCheck, norm: 'Information family, safety blue' },
  { id: 'info', label: 'Info desk', color: SAFETY.blue, ink: '#ffffff', icon: Info, norm: 'ISO 7001 PI PF 004 (information), blue' },
  { id: 'water', label: 'Water', color: SAFETY.blue, ink: '#ffffff', icon: Droplet, norm: 'ISO 7001 PI PF 006 (drinking water), blue' },
  { id: 'toilets', label: 'Toilets', color: SAFETY.blue, ink: '#ffffff', icon: Toilet, norm: 'ISO 7001 PI PF 008 (toilets), blue' },
  { id: 'lost_found', label: 'Lost & found', color: SAFETY.blue, ink: '#ffffff', icon: PackageSearch, norm: 'ISO 7001 PI PF 011 (lost property), blue' },
  { id: 'security', label: 'Security', color: SAFETY.blue, ink: '#ffffff', icon: ShieldCheck, norm: 'Information / mandatory family, safety blue' },
  { id: 'drone', label: 'Drone team', color: SAFETY.yellow, ink: '#000000', icon: Drone, norm: 'Warning family (overhead drone operations), safety yellow' },
];

const BY_ID = new Map(POINT_SYMBOLS.map((s) => [s.id, s]));
/** Built-in lookup; pass the event's list to also find its custom types. */
export const symbolOf = (id: string | null | undefined, all?: PointSymbol[]): PointSymbol | undefined =>
  id ? (all ? all.find((s) => s.id === id) : BY_ID.get(id)) : undefined;
export const symbolImageId = (id: string) => `hp-sym-${id}`;

/**
 * Rasterises every symbol as a map icon: rounded square in the safety colour, white outline for
 * contrast on satellite imagery, lucide glyph in the ISO ink colour. Rendered at 2× for sharpness.
 */
export async function loadSymbolImages(add: (id: string, img: HTMLImageElement) => void, symbols: PointSymbol[] = POINT_SYMBOLS): Promise<void> {
  await Promise.all(
    symbols.map(
      (s) =>
        new Promise<void>((resolve) => {
          const Icon = s.icon;
          const glyph = s.image
            ? `<image href="${s.image}" x="8" y="8" width="32" height="32" preserveAspectRatio="xMidYMid meet"/>`
            : renderToStaticMarkup(<Icon color={s.ink} size={28} strokeWidth={2.4} x={10} y={10} />);
          const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
            `<rect x="2" y="2" width="44" height="44" rx="9" fill="${s.color}" stroke="#ffffff" stroke-width="3"/>` +
            glyph +
            `</svg>`;
          const img = new Image(48, 48);
          img.onload = () => {
            add(symbolImageId(s.id), img);
            resolve();
          };
          img.onerror = () => resolve(); // a missing icon falls back to the plain dot
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        }),
    ),
  );
}

/** MIME type used when a symbol pill is dragged onto the map. */
export const SYMBOL_DRAG_TYPE = 'application/x-hp-symbol';

/**
 * The access-point pill: outline and logo in the symbol's safety colour, filled when selected.
 * Used for choosing a type in the editor and, draggable, as the palette to drop points on the map.
 */
export function SymbolPill({ symbol: p, selected = false, draggable = false, onClick }: { symbol: PointSymbol; selected?: boolean; draggable?: boolean; onClick?: () => void }) {
  const Icon = p.icon;
  return (
    <button
      type="button"
      title={draggable ? `Drag onto the map to place: ${p.label}` : p.norm}
      draggable={draggable}
      onDragStart={draggable ? (e) => (e.dataTransfer.setData(SYMBOL_DRAG_TYPE, p.id), (e.dataTransfer.effectAllowed = 'copy')) : undefined}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-text ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={selected ? { background: p.color, borderColor: p.color, color: p.ink } : { borderColor: p.color }}
    >
      <span className="flex h-4 w-4 items-center justify-center overflow-hidden rounded-[4px]" style={{ background: selected ? 'transparent' : p.color }}>
        {p.image ? <img src={p.image} alt="" className="h-3.5 w-3.5 object-contain" draggable={false} /> : <Icon size={11} strokeWidth={2.8} color={p.ink} />}
      </span>
      {p.label}
    </button>
  );
}
