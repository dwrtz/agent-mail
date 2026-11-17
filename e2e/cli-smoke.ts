// npm run e2e:cli: one local instance, two users, the agent-mail CLI end to end (send with attachment, requests,
// approve, pull + decrypt, attachment download, reply, ack).
import { spawn, execSync, execFileSync, ChildProcess } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Account, waitFor } from './lib';

const URL_ = 'http://localhost:8796';
let proc: ChildProcess | undefined;
process.on('exit', () => { try { if (proc?.pid) process.kill(-proc.pid, 'SIGTERM'); } catch {} });
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`); }

async function main() {
  rmSync('.e2e/cli', { recursive: true, force: true }); mkdirSync('.e2e/cli', { recursive: true });
  execSync('node scripts/build-ui.mjs && npm run --silent build:cli', { stdio: 'ignore' });
  execSync('npx wrangler d1 migrations apply DB --local --persist-to .e2e/cli/db', { stdio: 'ignore' });
  proc = spawn('npx', ['wrangler', 'dev', '--port', '8796', '--persist-to', '.e2e/cli/db', '--inspector-port', '9796', '--show-interactive-dev-session=false', '--var', `SITE_URL:${URL_}`, '--var', 'ALLOW_HTTP_LOCALHOST:1'], { stdio: 'ignore', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  await waitFor('instance up', async () => (await fetch(`${URL_}/api/config`).catch(() => null))?.ok, 90000);
  const A = new Account(URL_), B = new Account(URL_);
  await A.signup('alice@example.com', 'correct horse battery', 'alice', 'Alice');
  await B.signup('bob@example.com', 'correct horse battery', 'bob', 'Bob');
  for (const x of [A, B]) { await x.setupKey(); await x.connect(); writeFileSync(`.e2e/cli/${x.me.handle}.json`, JSON.stringify(x.keys[0])); }
  const cli = (who: Account, ...args: string[]) => execFileSync('node', ['cli/agent-mail.mjs', ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_URL: URL_, AGENT_MAIL_TOKEN: who.token, AGENT_MAIL_KEY: `.e2e/cli/${who.me.handle}.json` } });
  writeFileSync('.e2e/cli/notes.txt', 'attachment body '.repeat(100));
  const sent = cli(A, 'send', '--to', B.address, '--subject', 'CLI hello', '--attach', '.e2e/cli/notes.txt', 'Hello from the CLI');
  check('send with attachment', /noteId/.test(sent), sent.trim().slice(0, 120));
  const reqs = await waitFor('request', async () => { const r = cli(B, 'requests'); return r.includes('Hello from the CLI') ? r : null; });
  check('requests shows the decrypted message', true);
  cli(B, 'approve', A.actor);
  const pulled = JSON.parse(cli(B, 'pull'));
  const item = (pulled.items ?? []).find((i: any) => JSON.stringify(i).includes('Hello from the CLI'));
  check('pull decrypts after approve', !!item, item ? 'found' : cli(B, 'pull').slice(0, 200));
  const da = item?.decrypted?.attachments?.[0];
  const refs: any[] = [].concat(item?.activity?.object?.attachment ?? []);
  const ref = da && refs.find(r => (r.url ?? r.href) === da.url);
  if (da && ref) {
    cli(B, 'attachment', da.url, String(ref['am:size']), String(ref['am:digest']), da.key, da.iv, '.e2e/cli/out.txt');
    check('attachment download + decrypt', readFileSync('.e2e/cli/out.txt', 'utf8') === readFileSync('.e2e/cli/notes.txt', 'utf8'));
  } else check('attachment download + decrypt', false, JSON.stringify({ da, refs }).slice(0, 400));
  const noteId = item?.activity?.object?.id ?? item?.note?.id ?? item?.noteId;
  cli(B, 'reply', String(noteId), 'Reply from the CLI');
  const got = await waitFor('reply', async () => { const r = JSON.parse(cli(A, 'pull')); return JSON.stringify(r).includes('Reply from the CLI') ? r : null; });
  check('reply arrives and decrypts', !!got);
  const ack = cli(A, 'ack', String(got.nextCursor));
  check('ack', /acked/.test(ack), ack.trim());
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
