// Live test plan against two deployed instances. Env: AM_A (main origin), AM_B (test origin with TEST_ROUTES=1),
// AM_PROBE (path to the probe key JSON whose public key is the test instance's TEST_PROBE_KEY), AM_SHOTS (screenshot dir).
import { readFileSync, writeFileSync } from 'node:fs';
import { Account, Probe, waitFor } from './lib';
import { runSuite } from './suite';
import { runUi } from './ui';
import { b64url, randomBytes, unb64url } from '../src/shared/enc';

const A_URL = process.env.AM_A!, B_URL = process.env.AM_B!;
const probe = JSON.parse(readFileSync(process.env.AM_PROBE!, 'utf8'));
const pw = () => b64url(randomBytes(18)); // per-run test passwords, kept in memory only

async function main() {
  for (const u of [A_URL, B_URL]) await waitFor(`${u} up`, async () => (await fetch(`${u}/api/config`)).ok, 120000);
  const A = new Account(A_URL), B = new Account(B_URL), C = new Account(B_URL);
  await A.signup('tester@example.com', pw(), 'tester', 'Tester');
  await B.signup('bob@example.com', pw(), 'bob', 'Bob');
  await C.signup('carol@example.com', pw(), 'carol', 'Carol');
  for (const x of [A, B, C]) await x.setupKey();
  const results: any[] = await runSuite({ A, B, C, probe: new Probe(B_URL, unb64url(probe.privateKey)), sinkBase: B_URL, log: s => console.log(s) });
  try {
    const dPw = pw();
    const D = new Account(B_URL); await D.signup('dave@example.com', dPw, 'dave', 'Dave'); await D.setupKey();
    const E = new Account(B_URL); await E.signup('erin@example.com', pw(), 'erin', 'Erin'); await E.setupKey();
    const ui = await runUi({ A: { base: A_URL, email: 'ann@example.com', password: pw(), handle: 'ann', name: 'Ann', signup: true }, B: D, bEmail: 'dave@example.com', bPassword: dPw, C: E, shots: process.env.AM_SHOTS ?? 'shots' });
    for (const s of ui) results.push({ id: 'UI', name: s.name, pass: s.pass, detail: s.detail });
  } catch (e) { results.push({ id: 'UI', name: 'browser pass', pass: false, detail: String(e).slice(0, 300) }); }
  writeFileSync(process.env.AM_RESULTS ?? 'live-results.json', JSON.stringify({ at: new Date().toISOString(), A: A_URL, B: B_URL, results }, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
