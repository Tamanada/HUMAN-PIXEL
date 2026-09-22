import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;
function required(name: string, v: string | undefined): string {
  if (!v) throw new Error(`Missing ${name}. Copy apps/console/.env.example to .env.local.`);
  return v;
}

export const config = {
  supabaseUrl: required('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY),
  participantUrl: (env.VITE_PARTICIPANT_URL as string | undefined) ?? 'http://localhost:5173',
  mapStyleUrl: (env.VITE_MAP_STYLE_URL as string | undefined) || 'https://tiles.openfreemap.org/styles/liberty',
  satelliteTiles: (env.VITE_SATELLITE_TILES as string | undefined) || null,
  satelliteAttribution: (env.VITE_SATELLITE_ATTRIBUTION as string | undefined) || '',
  sentryDsn: (env.VITE_SENTRY_DSN as string | undefined) || null,
  appVersion: (env.VITE_APP_VERSION as string | undefined) || '1.0.0',
};

export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'hp-console:auth' },
  global: { headers: { 'x-client-info': `human-pixel-console/${config.appVersion}` } },
});

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Typed RPC call; database errors like `PRECONDITION_PERIMETER: …` become readable messages. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const code = error.message.match(/^([A-Z_]{4,})/)?.[1] ?? 'ERROR';
    const detail = error.message.includes(':') ? error.message.slice(error.message.indexOf(':') + 1).trim() : '';
    throw new RpcError(code, detail || humanize(code) || error.message);
  }
  return data as T;
}

function humanize(code: string): string {
  const map: Record<string, string> = {
    FORBIDDEN: 'You do not have permission to do this.',
    ILLEGAL_TRANSITION: 'This state change is not allowed.',
    FORMATION_FROZEN: 'The formation can no longer change at this stage of the event.',
    FORMATION_LOCKED: 'Constraint areas are frozen while a formation is locked. Generate and lock a new version to change them.',
    RATE_LIMITED: 'Too many requests. Wait a moment.',
  };
  return map[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new RpcError('ERROR', res.error.message);
  return res.data as T;
}
