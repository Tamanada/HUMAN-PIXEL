/**
 * Authoritative time at the network edge: NTP-disciplined servers close to the phone give a low
 * round-trip and therefore a tight clock-sync bound. Never cached.
 */
export default (): Response =>
  new Response(JSON.stringify({ now: Date.now() }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store, max-age=0',
      'access-control-allow-origin': '*',
    },
  });

export const config = { path: '/api/time', cache: 'manual' };
