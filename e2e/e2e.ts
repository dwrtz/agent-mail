// npm run e2e: two local instances (wrangler dev on 8787 and 8788) and the full test plan between them.
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Account, Probe, waitFor } from './lib';
import { runSuite } from './suite';
import { runUi } from './ui';
import { multikeyEncode, randomBytes } from '../src/shared/enc';

const A_URL = 'http://localhost:8787', B_URL = 'http://localhost:8788';
const procs: ChildProcess[] = [];
function start(port: number, dir: string, vars: Record<string, string>) {
  execSync(`npx wrangler d1 migrations apply DB --local --persist-to ${dir}`, { stdio: 'ignore' });
  const args = ['wrangler', 'dev', '--port', String(port), '--persist-to', dir, '--inspector-port', String(port + 1000), '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const p = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let out = '';
  p.stdout!.on('data', d => { out += d; }); p.stderr!.on('data', d => { out += d; });
  procs.push(p);
  return () => out;
}
const stop = () => { for (const p of procs) { try { if (p.pid) process.kill(-p.pid, 'SIGTERM'); } catch {} } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(1); });

async function main() {
  rmSync('.e2e/a', { recursive: true, force: true }); rmSync('.e2e/b', { recursive: true, force: true }); mkdirSync('.e2e', { recursive: true });
  execSync('node scripts/build-ui.mjs', { stdio: 'inherit' });
  const probeKey = randomBytes(32);
  const logA = start(8787, '.e2e/a', { SITE_URL: A_URL, ALLOW_HTTP_LOCALHOST: '1' });
  const logB = start(8788, '.e2e/b', { SITE_URL: B_URL, ALLOW_HTTP_LOCALHOST: '1', TEST_ROUTES: '1', TEST_PROBE_KEY: multikeyEncode('ed25519', ed25519.getPublicKey(probeKey)) });
  for (const u of [A_URL, B_URL]) await waitFor(`${u} up`, async () => (await fetch(`${u}/api/config`)).ok, 90000);
  const A = new Account(A_URL), B = new Account(B_URL), C = new Account(B_URL);
  await A.signup('alice@example.com', 'correct horse battery', 'alice', 'Alice');
  await B.signup('bob@example.com', 'correct horse battery', 'bob', 'Bob');
  await C.signup('carol@example.com', 'correct horse battery', 'carol', 'Carol');
  for (const x of [A, B, C]) await x.setupKey();
  const results = await runSuite({ A, B, C, probe: new Probe(B_URL, probeKey), sinkBase: B_URL, log: s => console.log(s) });
  try {
    const D = new Account(B_URL); await D.signup('dave@example.com', 'correct horse battery', 'dave', 'Dave'); await D.setupKey();
    const E = new Account(B_URL); await E.signup('erin@example.com', 'correct horse battery', 'erin', 'Erin'); await E.setupKey();
    const ui = await runUi({ A: { base: A_URL, email: 'ann@example.com', password: 'correct horse battery', handle: 'ann', name: 'Ann', signup: true }, B: D, bEmail: 'dave@example.com', bPassword: 'correct horse battery', C: E, shots: '.e2e/shots' });
    for (const s of ui) results.push({ id: 'UI', name: s.name, pass: s.pass, detail: s.detail });
  } catch (e) { results.push({ id: 'UI', name: 'browser pass', pass: false, detail: String(e).slice(0, 300) }); }
  writeFileSync('.e2e/results.json', JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('--- instance A log tail ---\n' + logA().slice(-3000)); console.log('--- instance B log tail ---\n' + logB().slice(-3000)); }
  stop();
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); stop(); process.exit(1); });
