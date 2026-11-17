// Test-only routes, mounted only when the var TEST_ROUTES is "1" (never on a real instance).
// /__test/probe: a stand-in remote actor whose Ed25519 public key is the var TEST_PROBE_KEY (Multikey),
//   so a test harness holding the private key can sign raw inbox requests (forgery, replay, R6 rows).
// /__test/sink: a doorbell target that records what it receives (header value only as a SHA-256 hash).
import { Env, json, origin } from './env';
import { b64, sha256 } from '../shared/enc';

export async function testRoutes(req: Request, env: Env & { TEST_PROBE_KEY?: string }, path: string): Promise<Response | null> {
  if (path === '/__test/probe' && req.method === 'GET') {
    const id = `${origin(env)}/__test/probe`;
    return new Response(JSON.stringify({ '@context': ['https://www.w3.org/ns/activitystreams'], id, type: 'Service', preferredUsername: 'probe', inbox: `${id}/inbox`,
      assertionMethod: env.TEST_PROBE_KEY ? [{ id: `${id}#sig-1`, type: 'Multikey', controller: id, publicKeyMultibase: env.TEST_PROBE_KEY }] : [], keyAgreement: [] }),
      { headers: { 'content-type': 'application/activity+json' } });
  }
  if (path === '/__test/sink' && req.method === 'POST') {
    const name = new URL(req.url).searchParams.get('header') ?? 'authorization';
    const v = req.headers.get(name);
    const rec = { at: new Date().toISOString(), headerSha256: v ? b64(await sha256(v)) : null, contentType: req.headers.get('content-type'), body: await req.text() };
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
