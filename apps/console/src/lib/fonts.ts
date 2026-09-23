/**
 * Fonts an organizer imports for their own message.
 *
 * The file lives in storage next to the design images, so a saved design stays reproducible: the
 * formation records the CSS family (`hp-font-<asset id>`) and the console can load that face again
 * months later. The family is derived from the asset id rather than the file's own name, so two
 * imports called "Brand-Bold.ttf" never collide, and nothing can shadow a built-in face.
 */
import { supabase } from './supabase';

export interface FontChoice {
  /** CSS family name, used verbatim by the canvas that renders the design mask. */
  family: string;
  weight: number;
  /** What the organizer sees in the list. */
  label: string;
  group: string;
  /** Set for imported fonts: the formation_assets row backing this face. */
  assetId?: string;
  storagePath?: string;
}

const MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2';
const MAX_BYTES = 5 * 1024 * 1024;

export const familyForAsset = (assetId: string) => `hp-font-${assetId}`;

/** "Brand_Bold-Regular.woff2" → "Brand Bold Regular": a name to show in the list. */
export function fontDisplayName(fileName: string): string {
  return (
    fileName
      .replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Imported font'
  );
}

const loaded = new Map<string, FontFace>();

/** Registers an imported face with the document, once. Safe to call on every render pass. */
export async function ensureAssetFont(assetId: string, storagePath: string): Promise<void> {
  const family = familyForAsset(assetId);
  if (loaded.has(family)) return;
  const signed = await supabase.storage.from('formation-assets').createSignedUrl(storagePath, 3600);
  if (signed.error) throw new Error(signed.error.message);
  const face = new FontFace(family, `url("${signed.data.signedUrl}")`);
  await face.load();
  document.fonts.add(face);
  loaded.set(family, face);
}

function forget(family: string): void {
  const face = loaded.get(family);
  if (face) {
    document.fonts.delete(face);
    loaded.delete(family);
  }
}

/**
 * Validates a font file, stores it and registers it. The face is loaded BEFORE the upload so a
 * file the browser cannot read never reaches storage.
 */
export async function importFont(eventId: string, file: File): Promise<{ id: string; storagePath: string }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME[ext];
  if (!mime) throw new Error('Use a .ttf, .otf, .woff or .woff2 file.');
  if (file.size > MAX_BYTES) throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; fonts must stay under 5 MB.`);
  const buffer = await file.arrayBuffer();
  try {
    await new FontFace('hp-font-probe', buffer).load();
  } catch {
    throw new Error('This file is not a font the browser can read. Try the .ttf or .otf version.');
  }
  const path = `${eventId}/${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from('formation-assets').upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error(up.error.message);
  const { data: u } = await supabase.auth.getUser();
  const ins = await supabase
    .from('formation_assets')
    .insert({ event_id: eventId, storage_path: path, file_name: file.name, mime_type: mime, bytes: file.size, created_by: u.user?.id })
    .select('id')
    .single();
  if (ins.error) {
    await supabase.storage.from('formation-assets').remove([path]);
    throw new Error(ins.error.message);
  }
  const face = new FontFace(familyForAsset(ins.data.id), buffer);
  await face.load();
  document.fonts.add(face);
  loaded.set(familyForAsset(ins.data.id), face);
  return { id: ins.data.id, storagePath: path };
}

export async function deleteFont(assetId: string, storagePath: string): Promise<void> {
  const del = await supabase.from('formation_assets').delete().eq('id', assetId);
  if (del.error) throw new Error(del.error.message);
  await supabase.storage.from('formation-assets').remove([storagePath]);
  forget(familyForAsset(assetId));
}
