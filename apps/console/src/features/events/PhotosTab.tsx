import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Star } from 'lucide-react';
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from '../../components/ui';
import { must, rpc, supabase } from '../../lib/supabase';
import type { EventRow } from '../../lib/types';
import type { TabProps } from './EventLayout';

interface PhotoRow {
  id: string;
  kind: 'official' | 'alternate' | 'video' | 'evidence';
  status: 'ready' | 'released' | 'withdrawn';
  is_primary: boolean;
  title: string | null;
  thumb_path: string;
  display_path: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  sha256: string | null;
  created_at: string;
}

/** Resizes an image to fit `max` px on the long side and encodes as JPEG. */
async function derivative(bitmap: ImageBitmap, max: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function PhotosTab({ event, canEdit }: TabProps) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<PhotoRow['kind']>('official');
  const [title, setTitle] = useState('');
  const [camera, setCamera] = useState('');
  const [step, setStep] = useState<string | null>(null);

  const photos = useQuery({
    queryKey: ['photos', event.id],
    queryFn: async () => {
      const rows = must(await supabase.from('event_photos').select('*').eq('event_id', event.id).order('created_at', { ascending: false })) as PhotoRow[];
      const urls = await Promise.all(rows.map((r) => supabase.storage.from('event-photos').createSignedUrl(r.thumb_path, 3600)));
      return rows.map((r, i) => ({ ...r, thumbUrl: urls[i]?.data?.signedUrl ?? null }));
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file');
      const photoId = crypto.randomUUID();
      const base = `${event.id}/${photoId}`;
      setStep('Decoding image…');
      const bmp = await createImageBitmap(file);
      setStep('Generating derivatives (display 2560 px, share 1600 px, thumb 480 px)…');
      const [display, share, thumb] = await Promise.all([derivative(bmp, 2560, 0.9), derivative(bmp, 1600, 0.86), derivative(bmp, 480, 0.8)]);
      setStep('Hashing master (SHA-256, for evidence)…');
      const sha = await sha256Hex(file);
      const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
      const files: [string, Blob, string][] = [
        [`${base}/master.${ext}`, file, file.type || 'image/jpeg'],
        [`${base}/display.jpg`, display, 'image/jpeg'],
        [`${base}/share.jpg`, share, 'image/jpeg'],
        [`${base}/thumb.jpg`, thumb, 'image/jpeg'],
      ];
      for (const [i, [path, blob, type]] of files.entries()) {
        setStep(`Uploading ${i + 1}/4…`);
        const { error } = await supabase.storage.from('event-photos').upload(path, blob, { contentType: type, upsert: true, cacheControl: '31536000' });
        if (error) throw new Error(`Upload failed (${path.split('/').pop()}): ${error.message}. Retry: uploads are resumable per file.`);
      }
      setStep('Registering…');
      await rpc('photo_register', {
        p_event_id: event.id,
        p_photo_id: photoId,
        p_kind: kind,
        p_title: title || null,
        p_master_path: files[0]![0],
        p_display_path: files[1]![0],
        p_share_path: files[2]![0],
        p_thumb_path: files[3]![0],
        p_width: bmp.width,
        p_height: bmp.height,
        p_bytes: file.size,
        p_sha256: sha,
        p_captured_at: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        p_camera: camera || null,
      });
    },
    onSuccess: () => {
      setFile(null);
      setStep(null);
      void qc.invalidateQueries({ queryKey: ['photos', event.id] });
    },
    onError: () => setStep(null),
  });

  const primary = useMutation({
    mutationFn: (id: string) => rpc('photo_set_primary', { p_photo_id: id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['photos', event.id] }),
  });
  const release = useMutation({
    mutationFn: async () => {
      let e: EventRow = event;
      const path: EventRow['state'][] = e.state === 'LIVE' ? ['PHOTO_CAPTURED', 'PHOTO_RELEASED'] : e.state === 'PHOTO_CAPTURED' || e.state === 'PHOTO_PROCESSING' ? ['PHOTO_RELEASED'] : [];
      for (const to of path) e = await rpc<EventRow>('transition_event', { p_event_id: event.id, p_to: to, p_reason: 'photo release' });
      return e;
    },
    onSuccess: (e) => qc.setQueryData(['event', event.id], e),
  });

  const hasPrimary = (photos.data ?? []).some((p) => p.is_primary);
  const canRelease = hasPrimary && ['LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING'].includes(event.state);

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      {canEdit && (
        <Card title="Upload">
          <div className="space-y-3">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line p-6 text-sm text-muted hover:border-pixel">
              <ImageUp size={22} />
              {file ? `${file.name} · ${(file.size / 1e6).toFixed(1)} MB` : 'Official aerial photograph (JPEG / PNG / WebP)'}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <Field label="Type">
              <Select value={kind} onChange={(e) => setKind(e.target.value as PhotoRow['kind'])}>
                <option value="official">Official photo</option>
                <option value="alternate">Alternate angle</option>
                <option value="evidence">Evidence (record submission)</option>
              </Select>
            </Field>
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Camera / drone"><Input value={camera} onChange={(e) => setCamera(e.target.value)} placeholder="DJI Mavic 3 Pro, 120 m" /></Field>
            <Button variant="primary" className="w-full" busy={upload.isPending} disabled={!file} onClick={() => upload.mutate()}>Upload</Button>
            {step && <p className="text-xs text-muted">{step}</p>}
            {upload.error && <Alert tone="bad">{(upload.error as Error).message}</Alert>}
          </div>
        </Card>
      )}
      <div className="space-y-4">
        {canEdit && (
          <Card title="Release to participants">
            <p className="mb-3 text-sm text-muted">Releasing sends "Now you can see what you created" to every eligible participant. Only the display, share and thumbnail versions are ever readable by participants; the master stays private.</p>
            <Button variant="primary" disabled={!canRelease} busy={release.isPending} onClick={() => release.mutate()}>Release the photo</Button>
            {event.state === 'PHOTO_RELEASED' && <span className="ml-3 text-sm text-ok">Released.</span>}
            {!hasPrimary && <p className="mt-2 text-xs text-muted">Upload an official photo and mark it primary first.</p>}
            {release.error && <div className="mt-3"><Alert tone="bad">{(release.error as Error).message}</Alert></div>}
          </Card>
        )}
        {(photos.data ?? []).length === 0 ? (
          <Empty icon={<ImageUp size={24} />} title="No photos yet">After the formation, upload the aerial photograph here.</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {photos.data!.map((p) => (
              <div key={p.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
                {p.thumbUrl && <img src={p.thumbUrl} alt={p.title ?? 'Event photo'} className="aspect-video w-full object-cover" />}
                <div className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={p.status === 'released' ? 'ok' : 'neutral'}>{p.status}</Badge>
                    <Badge>{p.kind}</Badge>
                    {p.is_primary && <Badge tone="pixel">primary</Badge>}
                  </div>
                  <p className="text-sm">{p.title ?? 'Untitled'} · {p.width}×{p.height}</p>
                  <p className="truncate font-mono text-[10px] text-muted">sha256 {p.sha256}</p>
                  {canEdit && !p.is_primary && p.kind === 'official' && (
                    <Button size="sm" icon={<Star size={14} />} busy={primary.isPending} onClick={() => primary.mutate(p.id)}>Make primary</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
