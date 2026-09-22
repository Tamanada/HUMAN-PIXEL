/**
 * Device capabilities behind one interface: Capacitor plugins on iOS/Android, Web APIs in the
 * browser (the QR-code path needs no install at all).
 */
import { Capacitor } from '@capacitor/core';
import type { GpsFix } from '@human-pixel/core';

export const isNative = Capacitor.isNativePlatform();

export type GeoPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

export interface GeoWatch {
  stop(): void;
}

export async function geolocationPermission(): Promise<GeoPermission> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    try {
      const p = await Geolocation.checkPermissions();
      return p.location === 'granted' ? 'granted' : p.location === 'denied' ? 'denied' : 'prompt';
    } catch {
      return 'unavailable';
    }
  }
  if (!('geolocation' in navigator)) return 'unavailable';
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return (p?.state as GeoPermission) ?? 'prompt';
  } catch {
    return 'prompt';
  }
}

export async function requestGeolocation(): Promise<GeoPermission> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const p = await Geolocation.requestPermissions({ permissions: ['location'] });
    return p.location === 'granted' ? 'granted' : 'denied';
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? 'denied' : 'granted'),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });
}

/** High-accuracy position stream. Fixes stay on the device. */
export async function watchPosition(onFix: (f: GpsFix) => void, onError: (message: string) => void): Promise<GeoWatch> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const id = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }, (pos, err) => {
      if (err || !pos) return onError(err?.message ?? 'GPS unavailable');
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading ?? null,
        speed: pos.coords.speed ?? null,
        timestamp: Date.now(),
      });
    });
    return { stop: () => void Geolocation.clearWatch({ id }) };
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        // Device receive time: comparable with Date.now() for staleness checks.
        timestamp: Date.now(),
      }),
    (e) => onError(e.code === e.PERMISSION_DENIED ? 'Location permission denied' : e.message || 'GPS unavailable'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
  );
  return { stop: () => navigator.geolocation.clearWatch(id) };
}

// ---- Compass --------------------------------------------------------------------------------
type OrientationEventWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };

/** iOS needs an explicit permission from a user gesture. */
export async function requestCompass(): Promise<boolean> {
  const DOE = (globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (DOE?.requestPermission) {
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return 'ondeviceorientationabsolute' in window || 'ondeviceorientation' in window;
}

/** Heading in degrees clockwise from north, or null if the device has no usable compass. */
export function watchHeading(onHeading: (deg: number) => void): () => void {
  let lastAt = 0;
  const handler = (ev: Event) => {
    const e = ev as OrientationEventWithCompass;
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
    if (h == null) return;
    const now = performance.now();
    if (now - lastAt < 60) return; // ~16 Hz is plenty for an arrow
    lastAt = now;
    const screenAngle = (screen.orientation?.angle ?? 0) as number;
    onHeading((h + screenAngle + 360) % 360);
  };
  const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(evt, handler, true);
  return () => window.removeEventListener(evt, handler, true);
}

// ---- Haptics, wake lock, sharing ------------------------------------------------------------
export async function vibrate(pattern: number | number[]): Promise<void> {
  if (isNative) {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    const steps = Array.isArray(pattern) ? pattern : [pattern];
    for (let i = 0; i < steps.length; i += 2) {
      await Haptics.impact({ style: ImpactStyle.Heavy });
      if (steps[i + 1]) await new Promise((r) => setTimeout(r, steps[i + 1]));
    }
    return;
  }
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported (iOS Safari) */
  }
}

let wakeLock: WakeLockSentinel | null = null;
export async function keepAwake(on: boolean): Promise<void> {
  if (isNative) {
    const { KeepAwake } = await import('@capacitor-community/keep-awake');
    await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {});
    return;
  }
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* battery saver or unsupported */
  }
}

export async function shareImage(opts: { title: string; text: string; url?: string; blob: Blob; fileName: string }): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const base64 = await blobToBase64(opts.blob);
    const file = await Filesystem.writeFile({ path: opts.fileName, data: base64, directory: Directory.Cache });
    await Share.share({ title: opts.title, text: opts.text, url: file.uri, dialogTitle: opts.title });
    return 'shared';
  }
  const file = new File([opts.blob], opts.fileName, { type: opts.blob.type || 'image/jpeg' });
  const data: ShareData = { title: opts.title, text: opts.text, files: [file] };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  // Desktop fallback: download the image.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(opts.blob);
  a.download = opts.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return 'downloaded';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Opens turn-by-turn walking directions in the native maps app (long approaches). */
export function openExternalDirections(lat: number, lng: number): void {
  const ua = navigator.userAgent;
  const url = /iPhone|iPad|Macintosh/.test(ua)
    ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
  window.open(url, '_blank', 'noopener');
}

export function onAppResume(fn: () => void): () => void {
  const vis = () => document.visibilityState === 'visible' && fn();
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('online', fn);
  return () => {
    document.removeEventListener('visibilitychange', vis);
    window.removeEventListener('online', fn);
  };
}
