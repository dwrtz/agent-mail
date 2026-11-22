// npm run e2e:cli: one local instance, two users, the agent-mail CLI end to end (send with attachment, requests,
// approve, pull + decrypt, attachment download, reply, ack).
import { spawn, execSync, execFileSync, ChildProcess } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
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
  for (const x of [A, B]) { await x.setupKey(); await x.connect({ label: 'Smoke' }); writeFileSync(`.e2e/cli/${x.me.handle}.json`, JSON.stringify(x.keys[0])); }
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

  // New commands
  const who = JSON.parse(cli(B, 'whoami'));
  check('whoami shows scopes and ask rules', who.address === B.address && who.scopes.includes('send') && Array.isArray(who.ask), JSON.stringify({ scopes: who.scopes, ask: who.ask }));
  const threads = JSON.parse(cli(B, 'threads')).threads;
  check('threads decrypts the latest message', threads[0]?.last?.text === 'Reply from the CLI' && threads[0].last.direction === 'out', JSON.stringify(threads[0]?.last ?? null).slice(0, 160));
  const hist = JSON.parse(cli(B, 'thread', threads[0].threadId)).messages;
  check('thread shows both sides in order', hist.length === 2 && hist[0].text === 'Hello from the CLI' && hist[0].attachments[0].name === 'notes.txt' && hist[1].direction === 'out', hist.map((m: any) => m.text).join(' | '));
  cli(B, 'save', String(noteId), '0', '.e2e/cli/saved.txt');
  check('save downloads and decrypts by note id', readFileSync('.e2e/cli/saved.txt', 'utf8') === readFileSync('.e2e/cli/notes.txt', 'utf8'));
  // The agent file in the environment, as JSON: nothing on disk.
  const agentFile = JSON.stringify({ type: 'agent-mail-agent', v: 1, url: URL_, token: B.token, name: 'Smoke', keys: B.keys });
  const viaFile = execFileSync('node', ['cli/agent-mail.mjs', 'whoami'], { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_URL: '', AGENT_MAIL_TOKEN: '', AGENT_MAIL_KEY: '', AGENT_MAIL_CONFIG: agentFile } });
  check('AGENT_MAIL_CONFIG as inline JSON', JSON.parse(viaFile).address === B.address);

  // watch --once: silent while nothing is waiting, returns when mail arrives
  cli(B, 'ack', String(item.cursor));
  const watch = spawn('node', ['cli/agent-mail.mjs', 'watch', '--once', '--interval', '5'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AGENT_MAIL_CONFIG: agentFile } });
  let watchOut = ''; watch.stdout!.on('data', d => { watchOut += d; });
  const exited = new Promise<number | null>(res => watch.on('exit', res));
  await new Promise(r => setTimeout(r, 2500));
  const quiet = watchOut;
  cli(A, 'send', '--to', B.address, '--subject', 'Wake up', 'Mail for the watcher');
  const code = await Promise.race([exited, new Promise<string>(r => setTimeout(() => r('timeout'), 30000))]);
  if (code === 'timeout') watch.kill();
  check('watch --once prints one line when mail arrives and exits', quiet === '' && code === 0 && JSON.parse(watchOut.trim()).unread >= 1, `exit ${code}: ${watchOut.trim()}`);

  // agent-mail mcp: a local MCP server over stdio with plaintext tools
  mkdirSync('.e2e/cli/files', { recursive: true });
  const srv = spawn('node', ['cli/agent-mail.mjs', 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, AGENT_MAIL_CONFIG: agentFile, AGENT_MAIL_FILES: '.e2e/cli/files' } });
  let buf = ''; const waiting = new Map<number, (m: any) => void>();
  srv.stdout!.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); waiting.get(m.id)?.(m); } } });
  let n = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((res, rej) => { const id = ++n; const t = setTimeout(() => rej(new Error(`${method}: no answer`)), 40000); waiting.set(id, m => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }); srv.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name: string, args: unknown = {}) => { const r = await rpc('tools/call', { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r.structuredContent; };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    srv.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const names: string[] = (await rpc('tools/list')).tools.map((x: any) => x.name);
    check('local MCP: initialize and tools', init.protocolVersion === '2025-06-18' && ['read_inbox', 'reply', 'send', 'read_thread', 'wait_for_mail'].every(x => names.includes(x)), names.join(','));
    const inbox = await tool('read_inbox');
    const msg = inbox.messages.find((m: any) => m.text === 'Mail for the watcher');
    check('local MCP: read_inbox returns plain text', !!msg && msg.subject === 'Wake up' && msg.from === A.address && msg.fromAgent === true && typeof msg.cursor === 'number', JSON.stringify(msg ?? inbox).slice(0, 200));
    const sent = await tool('reply', { noteId: msg.noteId, text: 'Answer from the local MCP server' });
    await tool('ack', { upTo: msg.cursor });
    const back = await waitFor('local MCP reply', async () => { const r = JSON.parse(cli(A, 'pull')); return r.items.find((i: any) => i.decrypted?.content === 'Answer from the local MCP server') ?? null; });
    check('local MCP: reply is encrypted, delivered and names the agent', sent.status === 'sent' && back.decrypted.agent?.name === 'Smoke' && (await tool('check_mail')).unread === 0, JSON.stringify(sent).slice(0, 120));
    const wait = tool('wait_for_mail', { timeoutSeconds: 30 });
    await new Promise(r => setTimeout(r, 1500));
    cli(A, 'reply', String(back.noteId), 'One more for wait_for_mail');
    const woke = await wait;
    check('local MCP: wait_for_mail returns when mail arrives', woke.unread >= 1 && !woke.timedOut, JSON.stringify(woke));
    const bad = await rpc('tools/call', { name: 'save_attachment', arguments: { noteId: 'https://nope.example/notes/x', path: 'x.bin' } });
    check('local MCP: a failing tool answers isError, not a crash', bad.isError === true && (await rpc('ping')) !== undefined, bad.content?.[0]?.text?.slice(0, 80));
    // Files: only inside the agent's folder, and never a key.
    const outside = await rpc('tools/call', { name: 'reply', arguments: { noteId: msg.noteId, text: 'x', attach: ['../bob.json'] } });
    const escape = await rpc('tools/call', { name: 'save_attachment', arguments: { noteId: msg.noteId, path: '/tmp/agent-mail-escape.txt' } });
    // Links in the folder are followed only if they stay inside it; one that points at nothing is refused too
    // (writing through it would create its target outside the folder).
    symlinkSync('../never-created.txt', '.e2e/cli/files/dangling.txt');
    symlinkSync('../bob.json', '.e2e/cli/files/to-key.json');
    symlinkSync('ok.txt', '.e2e/cli/files/inside-link.txt');
    const dangling = await rpc('tools/call', { name: 'save_attachment', arguments: { noteId: msg.noteId, path: 'dangling.txt' } });
    const linkOut = await rpc('tools/call', { name: 'reply', arguments: { noteId: msg.noteId, text: 'x', attach: ['to-key.json'] } });
    check('local MCP: symlinks cannot lead out of its folder', dangling.isError && /must be inside/.test(dangling.content[0].text) && !existsSync('.e2e/cli/never-created.txt') && linkOut.isError && /must be inside/.test(linkOut.content[0].text),
      [dangling, linkOut].map(x => x.content?.[0]?.text?.slice(0, 40)).join(' | '));
    writeFileSync('.e2e/cli/files/leak.json', agentFile);
    writeFileSync('.e2e/cli/files/ok.txt', 'a file the agent may send');
    const leak = await rpc('tools/call', { name: 'reply', arguments: { noteId: msg.noteId, text: 'x', attach: ['leak.json'] } });
    const fine = await tool('reply', { noteId: msg.noteId, text: 'With a file from my folder', attach: ['ok.txt', 'inside-link.txt'] });
    check('local MCP: files outside its folder and key files are refused', outside.isError && /must be inside/.test(outside.content[0].text) && escape.isError && /must be inside/.test(escape.content[0].text) && leak.isError && /not sent/.test(leak.content[0].text) && fine.status === 'sent',
      [outside, escape, leak].map(x => x.content?.[0]?.text?.slice(0, 50)).join(' | '));
  } catch (e) { check('local MCP', false, String(e)); }
  srv.stdin!.end();
  const srvExit = await Promise.race([new Promise<number | null>(res => srv.on('exit', res)), new Promise<string>(r => setTimeout(() => r('timeout'), 10000))]);
  if (srvExit === 'timeout') srv.kill();
  check('local MCP: exits when stdin closes', srvExit === 0, `exit ${srvExit}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
