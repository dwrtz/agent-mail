// The owner web app (R14). No framework: small DOM helpers and history routing.
import settings from '../../spekkr.inputs.json';
import { KeyFile, newKeyFile, checkKeyFile, encryptAndSend, decryptActivity, decryptAttachment, Transport } from '../shared/client';
import { unb64url } from '../shared/enc';

const APP = settings.app_name;
type Me = { handle: string; name: string; email: string; actor: string; address: string; readReceipts: boolean; encKeys: { n: number; keyId: string; publicKey: string }[]; doorbell: { url: string; header: string; valueSet: boolean }; unread: number; unreadMessages: number; requests: number };
let me: Me | null = null;
let cfg: { host: string; origin: string } = { host: location.host, origin: location.origin };

// ---------- helpers ----------
type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
class ApiError extends Error { constructor(public code: string, msg: string) { super(msg); } }
async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined || opts.raw ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opts.raw ? { 'content-type': 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (res.headers.get('content-type')?.includes('application/octet-stream')) return new Uint8Array(await res.arrayBuffer()) as any;
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'error', friendly(data.error, data.detail));
  return data;
}
function friendly(code: string, detail: string) {
  const m: Record<string, string> = {
    email_not_allowed: 'This instance is private.', signup_closed: 'Sign-up is closed on this instance.', bad_credentials: 'Wrong email or password.',
    taken: 'That handle or email is already used.', no_encryption_key: detail || 'A recipient has not set up encryption yet.', unknown_recipient: detail || 'Could not find that address.',
    group_too_large: 'A thread can have at most 50 members.', not_member: 'You are not a member of this thread.',
  };
  return m[code] ?? detail ?? code;
}
const short = (actor: string) => { try { const u = new URL(actor); return `${u.pathname.split('/').pop()}@${u.host}`; } catch { return actor; } };
const when = (iso: string) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
function nav(to: string) { history.pushState({}, '', to); render(); }
const link = (to: string, label: Child | Child[], cls = '') => h('a', { href: to, class: cls, onclick: (e: Event) => { e.preventDefault(); nav(to); } }, label);
function download(name: string, data: BlobPart, type = 'application/octet-stream') {
  const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name }) as HTMLAnchorElement;
  document.body.append(a); a.click(); a.remove();
}

// ---------- keys (kept in this browser only) ----------
const keyStore = () => `am.keys:${me!.actor}`;
const loadKeys = (): KeyFile[] => { try { return JSON.parse(localStorage.getItem(keyStore()) ?? '[]'); } catch { return []; } };
const saveKey = (k: KeyFile) => { const ks = loadKeys().filter(x => x.keyId !== k.keyId); ks.push(k); localStorage.setItem(keyStore(), JSON.stringify(ks)); };
const hasCurrentKey = () => { const cur = me!.encKeys.at(-1); return !!cur && loadKeys().some(k => k.keyId === cur.keyId && k.publicKey === cur.publicKey); };
const keyFileName = () => `${me!.address}.agent-mail-key.json`;

const transport: Transport = {
  prepare: a => api('/api/outbox/prepare', { body: a }),
  upload: bytes => api('/api/attachments', { raw: bytes as BufferSource }),
  send: body => api(`/users/${me!.handle}/outbox`, { body }),
};

// ---------- layout ----------
const root = document.getElementById('app')!;
function shell(title: string, ...content: Child[]) {
  const item = (to: string, label: string, count?: number) => link(to, [label, count ? h('span', { class: 'count' }, String(count)) : null], location.pathname === to ? 'active' : '');
  root.replaceChildren(h('div', { class: 'layout' },
    h('nav', { class: 'side' },
      h('div', { class: 'brand' }, APP),
      h('div', { class: 'addr', title: 'Your address' }, me!.address),
      item('/', 'Inbox', me!.unreadMessages), item('/requests', 'Requests', me!.requests), item('/compose', 'Compose'), item('/contacts', 'Contacts'), item('/settings', 'Settings'),
      h('button', { class: 'link', onclick: async () => { await api('/api/auth/logout', { body: {} }); me = null; nav('/login'); } }, 'Sign out')),
    h('main', {}, h('h1', {}, title), ...content)));
}
const errBox = () => h('p', { class: 'error', role: 'alert' });
function busy(btn: HTMLButtonElement, fn: () => Promise<void>, err: HTMLElement) {
  return async (e: Event) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try { await fn(); } catch (x) { err.textContent = (x as Error).message; } finally { btn.disabled = false; }
  };
}

// ---------- screens ----------
function authScreen(mode: 'login' | 'signup') {
  const err = errBox();
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' }) as HTMLInputElement;
  const pw = h('input', { type: 'password', name: 'password', required: true, minlength: mode === 'signup' ? 10 : undefined, autocomplete: mode === 'signup' ? 'new-password' : 'current-password' }) as HTMLInputElement;
  const handle = h('input', { name: 'handle', required: true, pattern: '[a-z0-9_]{1,32}', autocomplete: 'username' }) as HTMLInputElement;
  const name = h('input', { name: 'name', autocomplete: 'name' }) as HTMLInputElement;
  const btn = h('button', { type: 'submit', class: 'primary' }, mode === 'login' ? 'Sign in' : 'Create account') as HTMLButtonElement;
  const form = h('form', { class: 'card auth' },
    h('h1', {}, APP), h('p', { class: 'muted' }, mode === 'login' ? 'Sign in to your inbox.' : 'Create your address on this instance.'),
    h('label', {}, 'Email', email), h('label', {}, 'Password', pw),
    mode === 'signup' ? h('label', {}, 'Handle', h('div', { class: 'handle' }, handle, h('span', {}, `@${cfg.host}`))) : null,
    mode === 'signup' ? h('label', {}, 'Display name', name) : null,
    err, btn,
    mode === 'login' ? h('p', {}, 'New here? ', link('/signup', 'Create an account')) : h('p', {}, 'Have an account? ', link('/login', 'Sign in')));
  form.addEventListener('submit', busy(btn, async () => {
    await api(`/api/auth/${mode}`, { body: mode === 'login' ? { email: email.value, password: pw.value } : { email: email.value, password: pw.value, handle: handle.value, name: name.value } });
    await loadMe(); nav('/');
  }, err));
  root.replaceChildren(h('div', { class: 'center' }, form));
}

function setupKeyScreen() {
  const err = errBox();
  const createBtn = h('button', { class: 'primary' }, 'Create a new key') as HTMLButtonElement;
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Key file' }) as HTMLInputElement;
  const after = h('div');
  createBtn.addEventListener('click', busy(createBtn, async () => {
    const n = (me!.encKeys.at(-1)?.n ?? 0) + 1;
    const k = newKeyFile(me!.address, me!.actor, `${me!.actor}#enc-${n}`);
    const r = await api('/api/keys/encryption', { method: 'PUT', body: { publicKey: k.publicKey } });
    k.keyId = r.keyId; saveKey(k); await loadMe();
    after.replaceChildren(h('div', { class: 'card ok' }, h('p', {}, 'Your key is ready. Download the key file and keep it safe: it is the only way to read your messages on another device or from an agent.'),
      h('button', { class: 'primary', onclick: () => download(keyFileName(), JSON.stringify(k, null, 2), 'application/json') }, 'Download key file'), ' ',
      h('button', { onclick: () => nav('/') }, 'Go to inbox')));
  }, err));
  file.addEventListener('change', async () => {
    err.textContent = '';
    try {
      const k = checkKeyFile(JSON.parse(await file.files![0].text()));
      const listed = me!.encKeys.find(x => x.keyId === k.keyId && x.publicKey === k.publicKey);
      if (!listed) throw new Error('This key file is not one of your published keys.');
      saveKey(k); nav(location.pathname + location.search);
    } catch (x) { err.textContent = (x as Error).message; }
  });
  shell('Set up encryption',
    h('p', {}, 'Messages are end-to-end encrypted. Your private key stays in this browser and in the key file you download; the server never sees it.'),
    me!.encKeys.length === 0 ? h('div', { class: 'card' }, h('h2', {}, 'Create a new key'), createBtn) : h('div', { class: 'card' }, h('h2', {}, 'This browser has no copy of your key'), h('p', { class: 'muted' }, 'Import the key file you downloaded when you set up encryption. Creating a new key also works, but messages sent to your old key can then only be read with the old key file.'), createBtn),
    h('div', { class: 'card' }, h('h2', {}, 'Use an existing key file'), file), err, after);
}

async function inboxScreen() {
  const threads: any[] = await api('/api/threads');
  const keys = loadKeys();
  const list = h('ul', { class: 'threads' });
  for (const t of threads) {
    let subject = '';
    try { const p = await decryptActivity(keys, t.last.activity); subject = p.summary ? `${p.summary} - ${p.content}` : p.content; } catch { subject = '(cannot decrypt)'; }
    const others = t.members.filter((m: string) => m !== me!.actor).map(short).join(', ');
    list.append(h('li', {}, link(`/thread?uri=${encodeURIComponent(t.uri)}`, [
      h('span', { class: t.unread ? 'dot' : 'dot off', 'aria-label': t.unread ? 'unread' : '' }),
      h('span', { class: 'who' }, others || short(me!.actor), t.members.length > 2 ? h('span', { class: 'tag' }, `${t.members.length} people`) : null),
      h('span', { class: 'snippet' }, subject.slice(0, 140)), h('span', { class: 'time' }, t.last ? when(t.last.published) : '')])));
  }
  shell('Inbox', threads.length ? list : h('p', { class: 'muted empty' }, 'No messages yet.'));
}

async function renderAttachment(a: any, ref: any) {
  const btn = h('button', { class: 'att' }, `📎 ${a.name} (${Math.max(1, Math.round(a.size / 1024))} KB)`) as HTMLButtonElement;
  const err = h('span', { class: 'error' });
  btn.addEventListener('click', busy(btn, async () => {
    const stored: Uint8Array = await api('/api/attachments/fetch', { body: { url: ref.url, size: ref['am:size'], digest: ref['am:digest'] } });
    download(a.name, await decryptAttachment(stored, a) as BlobPart, a.mediaType);
  }, err));
  return h('span', {}, btn, err);
}

async function threadScreen() {
  const uri = new URLSearchParams(location.search).get('uri') ?? '';
  const [msgs, threads]: [any[], any[]] = await Promise.all([api(`/api/threads/messages?uri=${encodeURIComponent(uri)}`), api('/api/threads')]);
  const t = threads.find(x => x.uri === uri);
  const keys = loadKeys();
  const items = h('div', { class: 'messages' });
  const unreadNotes: string[] = [];
  for (const m of msgs) {
    if (m.gapBefore) items.append(h('p', { class: 'gap' }, `${m.gapBefore} earlier message(s) from ${short(m.actor)} missing`));
    if (m.type === 'Add' || m.type === 'Remove') {
      const a = m.activity;
      items.append(h('p', { class: 'event' }, a.object === a.actor ? `${short(a.actor)} left the thread` : `${short(a.actor)} ${a.type === 'Add' ? 'added' : 'removed'} ${short(a.object)}`, ' · ', when(m.published)));
      continue;
    }
    let body: Child[] = [];
    try {
      const p = await decryptActivity(keys, m.activity);
      const refs = m.activity.object.attachment ?? [];
      const atts = await Promise.all(p.attachments.map(a => renderAttachment(a, refs.find((r: any) => r.url === a.url) ?? {})));
      body = [p.summary ? h('div', { class: 'subject' }, p.summary) : null, h('div', { class: 'text' }, p.content), atts.length ? h('div', { class: 'atts' }, atts) : null];
    } catch { body = [h('div', { class: 'muted' }, '(cannot decrypt with the keys in this browser)')]; }
    if (m.direction === 'in' && !m.readAt) unreadNotes.push(m.activity.object.id);
    const readers = Object.keys(m.readBy ?? {});
    const failed = (m.deliveries ?? []).filter((d: any) => d.status === 'failed');
    const queued = (m.deliveries ?? []).filter((d: any) => d.status === 'queued');
    items.append(h('article', { class: m.direction === 'out' ? 'msg out' : 'msg' },
      h('header', {}, h('strong', {}, m.direction === 'out' ? 'You' : short(m.actor)), h('span', { class: 'time' }, when(m.published))),
      ...body,
      m.direction === 'out' ? h('footer', {},
        readers.length ? `Read by ${readers.map(short).join(', ')}` : failed.length ? h('span', { class: 'error' }, `Not delivered to ${failed.map((d: any) => short(d.target)).join(', ')}`) : queued.length ? 'Sending…' : 'Delivered') : null));
  }
  if (unreadNotes.length) api('/api/messages/read', { body: { noteIds: unreadNotes } }).then(loadMe).catch(() => {});
  const err = errBox();
  const text = h('textarea', { rows: 3, placeholder: 'Write a reply', 'aria-label': 'Reply' }) as HTMLTextAreaElement;
  const files = h('input', { type: 'file', multiple: true, 'aria-label': 'Attach files' }) as HTMLInputElement;
  const send = h('button', { class: 'primary', type: 'submit' }, 'Send reply') as HTMLButtonElement;
  const isMember = t?.members.includes(me!.actor);
  const form = h('form', { class: 'reply' }, text, h('div', { class: 'row' }, files, send), err);
  form.addEventListener('submit', busy(send, async () => {
    if (!text.value.trim()) throw new Error('Write something first.');
    await encryptAndSend(transport, { threadId: uri }, { text: text.value, files: await readFiles(files) });
    nav(location.pathname + location.search);
  }, err));
  const members = t ? h('aside', { class: 'card members' }, h('h2', {}, `Members (${t.members.length})`),
    h('ul', {}, t.members.map((mm: string) => h('li', {}, short(mm), mm === t.creator ? h('span', { class: 'tag' }, 'creator') : null,
      t.creator === me!.actor && mm !== me!.actor ? h('button', { class: 'link', onclick: async () => { await api('/api/threads/members', { body: { uri, remove: [mm] } }); nav(location.pathname + location.search); } }, 'Remove') : null))),
    t.creator === me!.actor ? addMemberForm(uri) : null,
    isMember ? h('button', { class: 'link', onclick: async () => { if (confirm('Leave this thread?')) { await api('/api/threads/members', { body: { uri, remove: [me!.actor] } }); nav('/'); } } }, 'Leave thread') : null) : null;
  shell(t ? t.members.filter((x: string) => x !== me!.actor).map(short).join(', ') : 'Thread', h('div', { class: 'thread' }, h('div', {}, items, isMember ? form : h('p', { class: 'muted' }, 'You are no longer a member of this thread.')), members));
}
function addMemberForm(uri: string) {
  const input = h('input', { placeholder: 'name@host', 'aria-label': 'Add member' }) as HTMLInputElement;
  const btn = h('button', { type: 'submit' }, 'Add') as HTMLButtonElement;
  const err = errBox();
  const f = h('form', { class: 'row' }, input, btn, err);
  f.addEventListener('submit', busy(btn, async () => { await api('/api/threads/members', { body: { uri, add: [input.value.trim()] } }); nav(location.pathname + location.search); }, err));
  return f;
}
async function readFiles(input: HTMLInputElement) {
  return Promise.all(Array.from(input.files ?? []).map(async f => ({ name: f.name, mediaType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

function composeScreen() {
  const err = errBox();
  const to = h('input', { name: 'to', placeholder: 'alice@example.com, bob@example.org', required: true }) as HTMLInputElement;
  const subject = h('input', { name: 'subject' }) as HTMLInputElement;
  const text = h('textarea', { name: 'message', rows: 8, required: true }) as HTMLTextAreaElement;
  const files = h('input', { type: 'file', multiple: true }) as HTMLInputElement;
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Send') as HTMLButtonElement;
  const form = h('form', { class: 'card compose' }, h('label', {}, 'To', to), h('label', {}, 'Subject', subject), h('label', {}, 'Message', text), h('label', {}, 'Attach files', files), err, btn,
    h('p', { class: 'muted small' }, 'Encrypted in this browser to each recipient\'s key before it leaves.'));
  form.addEventListener('submit', busy(btn, async () => {
    const r = await encryptAndSend(transport, { to: to.value.split(',').map(s => s.trim()).filter(Boolean) }, { subject: subject.value, text: text.value, files: await readFiles(files) });
    nav(`/thread?uri=${encodeURIComponent(r.threadId)}`);
  }, err));
  shell('Compose', form);
}

async function requestsScreen() {
  const { items } = await api('/api/requests');
  const keys = loadKeys();
  const list = h('div');
  for (const r of items) {
    let preview = '';
    if (r.activity.type === 'Create') { try { const p = await decryptActivity(keys, r.activity); preview = (p.summary ? p.summary + ' - ' : '') + p.content; } catch { preview = '(cannot decrypt)'; } }
    else preview = `${r.activity.type === 'Add' ? 'Added you to' : 'Changed'} a group thread`;
    list.append(h('div', { class: 'card request' }, h('header', {}, h('strong', {}, short(r.sender)), h('span', { class: 'time' }, when(r.receivedAt))), h('p', {}, preview.slice(0, 300)),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { await api('/api/requests/approve', { body: { actor: r.sender } }); await loadMe(); render(); } }, 'Approve'),
        h('button', { onclick: async () => { await api('/api/requests/block', { body: { actor: r.sender } }); await loadMe(); render(); } }, 'Block'))));
  }
  shell('Requests', h('p', { class: 'muted' }, 'Messages from people you have not approved yet. They cannot tell whether you have seen them.'), items.length ? list : h('p', { class: 'muted empty' }, 'No requests.'));
}

async function contactsScreen() {
  const rules: any[] = await api('/api/rules');
  const err = errBox();
  const subject = h('input', { placeholder: 'https://host/users/name or domain:host', 'aria-label': 'Actor or domain' }) as HTMLInputElement;
  const action = h('select', { 'aria-label': 'Action' }, h('option', { value: 'allow' }, 'Allow'), h('option', { value: 'block' }, 'Block')) as unknown as HTMLSelectElement;
  const btn = h('button', { type: 'submit' }, 'Add rule') as HTMLButtonElement;
  const form = h('form', { class: 'row' }, subject, action, btn);
  form.addEventListener('submit', busy(btn, async () => {
    let s = subject.value.trim();
    if (/^[^@\s/]+@[^@\s/]+$/.test(s)) s = (await api('/api/resolve', { body: { to: [s] } })).actors[0].actor;
    await api('/api/rules', { method: 'PUT', body: { subject: s, action: action.value } }); render();
  }, err));
  shell('Contacts', h('p', { class: 'muted' }, 'Allowed senders go straight to your inbox; unknown senders go to Requests; blocked senders are dropped.'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'Rule'), h('th', {}))),
      h('tbody', {}, rules.map(r => h('tr', {}, h('td', {}, r.subject.startsWith('domain:') ? r.subject : short(r.subject)), h('td', {}, r.action === 'allow' ? 'Allow' : 'Block'),
        h('td', {}, h('button', { class: 'link', onclick: async () => { await api(`/api/rules?subject=${encodeURIComponent(r.subject)}`, { method: 'DELETE' }); render(); } }, 'Remove')))))),
    h('h2', {}, 'Add a rule'), form, err);
}

async function settingsScreen() {
  const { tokens } = await api('/api/tokens');
  const err = errBox();
  const name = h('input', { value: me!.name, 'aria-label': 'Display name' }) as HTMLInputElement;
  const rr = h('input', { type: 'checkbox', role: 'switch', checked: me!.readReceipts }) as HTMLInputElement;
  const durl = h('input', { value: me!.doorbell.url, placeholder: 'https://…', 'aria-label': 'Doorbell URL' }) as HTMLInputElement;
  const dh = h('input', { value: me!.doorbell.header, 'aria-label': 'Header name' }) as HTMLInputElement;
  const dv = h('input', { type: 'password', placeholder: me!.doorbell.valueSet ? '(set - leave blank to keep)' : '(not set)', 'aria-label': 'Header value' }) as HTMLInputElement;
  const save = h('button', { class: 'primary', type: 'submit' }, 'Save') as HTMLButtonElement;
  const form = h('form', { class: 'card' }, h('h2', {}, 'Profile'), h('p', {}, 'Your address: ', h('strong', {}, me!.address)), h('label', {}, 'Display name', name),
    h('label', { class: 'switch' }, rr, ' Send read receipts'), h('p', { class: 'muted small' }, 'When on, people you message can see when you have read it. Off by default.'),
    h('h2', {}, 'Doorbell'), h('p', { class: 'muted small' }, 'Optional. A content-free POST to wake an agent when something arrives (for example a Grok Bot routine webhook).'),
    h('label', {}, 'Doorbell URL', durl), h('label', {}, 'Header name', dh), h('label', {}, 'Header value', dv),
    h('p', { class: 'muted small' }, 'The value field takes only the value, for example "Bearer …". A full header line is also accepted.'), err, h('div', { class: 'row' }, save,
      me!.doorbell.url ? h('button', { type: 'button', onclick: async (e: Event) => { const b = e.target as HTMLElement; try { const r = await api('/api/doorbell/test', { body: {} }); b.textContent = `Test ring: HTTP ${r.status}`; } catch (x) { b.textContent = (x as Error).message; } } }, 'Send test ring') : null));
  form.addEventListener('submit', busy(save, async () => {
    const b: any = { name: name.value, readReceipts: rr.checked, doorbellUrl: durl.value, doorbellHeader: dh.value };
    if (dv.value) b.doorbellValue = dv.value;
    await api('/api/settings', { method: 'PUT', body: b }); await loadMe(); render();
  }, err));
  const tokenOut = h('div');
  const label = h('input', { placeholder: 'Label, for example Grok Bot', 'aria-label': 'Token label' }) as HTMLInputElement;
  const mk = h('button', { type: 'submit' }, 'Create token') as HTMLButtonElement;
  const tform = h('form', { class: 'row' }, label, mk);
  tform.addEventListener('submit', busy(mk, async () => {
    const { token } = await api('/api/tokens', { body: { label: label.value } });
    tokenOut.replaceChildren(h('div', { class: 'card ok' }, h('p', {}, 'Copy this token now; it will not be shown again.'), h('code', { class: 'token' }, token)));
  }, err));
  const keys = loadKeys();
  shell('Settings', form,
    h('div', { class: 'card' }, h('h2', {}, 'Encryption keys'),
      h('ul', {}, me!.encKeys.map(k => h('li', {}, k.keyId.split('#')[1], keys.some(x => x.keyId === k.keyId) ? ' · in this browser' : ' · not in this browser', k === me!.encKeys.at(-1) ? h('span', { class: 'tag' }, 'current') : null))),
      h('div', { class: 'row' }, h('button', { onclick: () => { const k = keys.find(x => x.keyId === me!.encKeys.at(-1)?.keyId); if (k) download(keyFileName(), JSON.stringify(k, null, 2), 'application/json'); } }, 'Download key file'))),
    h('div', { class: 'card' }, h('h2', {}, 'Connector tokens'), h('p', { class: 'muted small' }, `For agents: add ${cfg.origin}/mcp as a custom MCP connector with the header Authorization: Bearer <token>.`),
      h('ul', {}, tokens.map((t: any) => h('li', {}, t.label, h('span', { class: 'muted small' }, ` · created ${when(t.created_at)}${t.last_used_at ? ', last used ' + when(t.last_used_at) : ''}`), ' ',
        h('button', { class: 'link', onclick: async () => { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); render(); } }, 'Revoke')))), tform, tokenOut));
}

// ---------- router ----------
async function loadMe() {
  try { me = (await api('/api/me')).user; } catch { me = null; }
}
async function render() {
  const p = location.pathname;
  try {
    if (p === '/login' || p === '/signup') return authScreen(p === '/login' ? 'login' : 'signup');
    if (!me) await loadMe();
    if (!me) { history.replaceState({}, '', '/login'); return authScreen('login'); }
    document.title = APP;
    if (!hasCurrentKey()) return setupKeyScreen();
    if (p === '/thread') return await threadScreen();
    if (p === '/compose') return composeScreen();
    if (p === '/requests') return await requestsScreen();
    if (p === '/contacts') return await contactsScreen();
    if (p === '/settings') return await settingsScreen();
    return await inboxScreen();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') { me = null; history.replaceState({}, '', '/login'); return authScreen('login'); }
    root.replaceChildren(h('p', { class: 'error' }, (e as Error).message));
  }
}
window.addEventListener('popstate', render);
api('/api/config').then(c => { cfg = c; }).catch(() => {}).finally(render);
void unb64url;
