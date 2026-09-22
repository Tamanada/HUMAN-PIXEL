// Account deletion (GDPR "right to erasure").
// 1. With the caller's own JWT: prepare_account_deletion() releases upcoming pixels and anonymises
//    past participation (evidence counts stay valid, nothing links back to the person).
// 2. With the service role: delete the auth user (email, sessions).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function log(level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, fn: 'account-delete', msg, ...extra, at: new Date().toISOString() }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);

  const asUser = createClient(url, anon, { global: { headers: { authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await asUser.auth.getUser();
  if (userError || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  const { data: summary, error: prepError } = await asUser.rpc('prepare_account_deletion');
  if (prepError) {
    log('error', 'prepare failed', { code: prepError.message.split(':')[0] });
    const status = prepError.message.startsWith('TRANSFER_OWNERSHIP_FIRST') ? 409 : 500;
    return json({ error: prepError.message.startsWith('TRANSFER_OWNERSHIP_FIRST') ? 'Transfer ownership of your organization before deleting your account.' : 'Deletion failed' }, status);
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { error: delError } = await admin.auth.admin.deleteUser(userId);
  if (delError) {
    log('error', 'auth delete failed', { message: delError.message });
    return json({ error: 'Deletion failed' }, 500);
  }
  log('info', 'account deleted', { summary });
  return json({ deleted: true, summary });
});
