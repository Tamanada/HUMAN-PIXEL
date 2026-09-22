const env = import.meta.env;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name}. Copy apps/participant/.env.example to .env.local.`);
  return value;
}

export const config = {
  supabaseUrl: required('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY),
  manifestUrl: (env.VITE_MANIFEST_URL as string | undefined) || null,
  timeUrl: (env.VITE_TIME_URL as string | undefined) || null,
  sentryDsn: (env.VITE_SENTRY_DSN as string | undefined) || null,
  appVersion: (env.VITE_APP_VERSION as string | undefined) || '1.0.0',
  consentVersion: '2026-09-v1',
} as const;
