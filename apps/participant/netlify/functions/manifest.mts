/**
 * CDN-cached public event manifest. 50,000 phones polling every minute become ~1 origin request
 * per 10 s: Netlify's durable cache absorbs the crowd, the database never sees it.
 */
import type { Context } from '@netlify/functions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async (req: Request, _ctx: Context): Promise<Response> => {
  const eventId = new URL(req.url).searchParams.get('event') ?? '';
  if (!UUID.test(eventId)) return json({ error: 'invalid event id' }, 400, 'public, max-age=3600');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return json({ error: 'not configured' }, 500, 'no-store');

  const res = await fetch(`${url}/rest/v1/rpc/get_event_manifest`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_event_id: eventId }),
  });
  if (!res.ok) {
    console.error(JSON.stringify({ level: 'error', msg: 'manifest upstream error', status: res.status, eventId }));
    // Phones keep their cached manifest; a short cache lets the edge recover quickly.
    return json({ error: 'upstream' }, 502, 'public, max-age=5');
  }
  const body = await res.json();
  if (!body) return json({ error: 'not found' }, 404, 'public, max-age=30');
  return json(body, 200, 'public, max-age=10', 'public, durable, s-maxage=10, stale-while-revalidate=60');
};

function json(body: unknown, status: number, browserCache: string, cdnCache?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': browserCache,
    'access-control-allow-origin': '*',
  };
  if (cdnCache) headers['netlify-cdn-cache-control'] = cdnCache;
  return new Response(JSON.stringify(body), { status, headers });
}
