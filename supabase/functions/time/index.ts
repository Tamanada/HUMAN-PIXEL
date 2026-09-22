// Authoritative server time for participant clock sync (fallback when the edge `/api/time`
// endpoint is not deployed). Stateless, no database access, never cached.
Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  return new Response(JSON.stringify({ now: Date.now() }), {
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });
});

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, OPTIONS',
};
