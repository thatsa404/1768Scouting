// FRC Nexus Webhook Relay — Cloudflare Worker
//
// This worker sits between FRC Nexus and the static scouting app.
// Nexus POSTs match status here; the app polls GET / to read the latest payload.
//
// ── Deploy steps ──────────────────────────────────────────────────────────────
//  1. npm install -g wrangler
//  2. wrangler login
//  3. wrangler kv namespace create RELAY_KV
//     → Copy the printed "id" value into wrangler.toml (REPLACE_WITH_KV_ID)
//  4. wrangler secret put NEXUS_TOKEN
//     → Paste the token shown in frc.nexus/en/api after registering the webhook
//  5. wrangler deploy          (from inside the nexus-relay/ directory)
//  6. Copy the deployed worker URL (e.g. https://nexus-relay.yourname.workers.dev)
//     → Paste it into frc.nexus/en/api as the webhook URL
//     → Paste it into the scouting app's Nexus Relay URL field
// ──────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Nexus-Token',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST / — Nexus sends match status updates here
    if (request.method === 'POST') {
      const token = request.headers.get('Nexus-Token') ?? '';
      if (env.NEXUS_TOKEN && token !== env.NEXUS_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      // Store with 2-hour TTL (covers a full event day)
      await env.RELAY_KV.put('latest', JSON.stringify(payload), { expirationTtl: 7200 });
      return new Response('OK', { status: 200, headers: cors });
    }

    // GET / — scouting app polls here for the latest Nexus payload
    if (request.method === 'GET') {
      const data = await env.RELAY_KV.get('latest');
      if (!data) {
        // No update received yet
        return new Response(null, { status: 204, headers: cors });
      }
      return new Response(data, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};
