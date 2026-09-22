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
  /** The standard the colour follows, shown as a tooltip. */
  norm: string;
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
export const symbolOf = (id: string | null | undefined): PointSymbol | undefined => (id ? BY_ID.get(id) : undefined);
export const symbolImageId = (id: string) => `hp-sym-${id}`;

/**
 * Rasterises every symbol as a map icon: rounded square in the safety colour, white outline for
 * contrast on satellite imagery, lucide glyph in the ISO ink colour. Rendered at 2× for sharpness.
 */
export async function loadSymbolImages(add: (id: string, img: HTMLImageElement) => void): Promise<void> {
  await Promise.all(
    POINT_SYMBOLS.map(
      (s) =>
        new Promise<void>((resolve) => {
          const Icon = s.icon;
          const glyph = renderToStaticMarkup(<Icon color={s.ink} size={28} strokeWidth={2.4} x={10} y={10} />);
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
