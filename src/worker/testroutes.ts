// Test-only routes, mounted only when the var TEST_ROUTES is "1" (never on a real instance).
// /__test/probe: a stand-in remote actor whose Ed25519 public key is the var TEST_PROBE_KEY (Multikey),
//   so a test harness holding the private key can sign raw inbox requests (forgery, replay, R6 rows).
// /__test/sink: a doorbell target that records what it receives (header values only as SHA-256 hashes).
// /__test/oauth-client: an OAuth client id metadata document, to test clients identified by URL.
import { Env, json, origin } from './env';
import { b64, sha256 } from '../shared/enc';

export async function testRoutes(req: Request, env: Env & { TEST_PROBE_KEY?: string }, path: string): Promise<Response | null> {
  if (path === '/__test/probe' && req.method === 'GET') {
    const id = `${origin(env)}/__test/probe`;
    return new Response(JSON.stringify({ '@context': ['https://www.w3.org/ns/activitystreams'], id, type: 'Service', preferredUsername: 'probe', inbox: `${id}/inbox`,
      assertionMethod: env.TEST_PROBE_KEY ? [{ id: `${id}#sig-1`, type: 'Multikey', controller: id, publicKeyMultibase: env.TEST_PROBE_KEY }] : [], keyAgreement: [] }),
      { headers: { 'content-type': 'application/activity+json' } });
  }
  if (path === '/__test/oauth-client' && req.method === 'GET') {
    // An OAuth client id metadata document: its own URL is the client_id.
    const id = `${origin(env)}/__test/oauth-client`;
    return json({ client_id: id, client_name: 'Metadata Test Client', redirect_uris: ['http://localhost:9/callback'], token_endpoint_auth_method: 'none' });
  }
  if (path === '/__test/sink' && req.method === 'POST') {
    // ?header=a,b records the SHA-256 of each named header (never the values).
    const names = (new URL(req.url).searchParams.get('header') ?? 'authorization').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
    const headers: Record<string, string | null> = {};
    for (const n of names) { const v = req.headers.get(n); headers[n] = v ? b64(await sha256(v)) : null; }
    const rec = { at: new Date().toISOString(), headerSha256: headers[names[0]] ?? null, headers, contentType: req.headers.get('content-type'), body: await req.text() };
    await env.FILES.put(`sink/${Date.now()}-${crypto.randomUUID()}.json`, JSON.stringify(rec));
    return json({ ok: true });
  }
  if (path === '/__test/sink' && req.method === 'GET') {
    const l = await env.FILES.list({ prefix: 'sink/' });
    const out = [];
    for (const o of l.objects) { const g = await env.FILES.get(o.key); if (g) out.push(JSON.parse(await g.text())); }
    return json(out);
  }
  if (path === '/__test/sink' && req.method === 'DELETE') {
    const l = await env.FILES.list({ prefix: 'sink/' });
    for (const o of l.objects) await env.FILES.delete(o.key);
    return json({ deleted: l.objects.length });
  }
  return null;
}
