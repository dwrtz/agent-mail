// The owner web app (R14). No framework: small DOM helpers and history routing.
import settings from '../../spekkr.inputs.json';
import { KeyFile, AgentFile, newKeyFile, checkKeyFile, encryptAndSend, decryptActivity, decryptAttachment, Transport } from '../shared/client';

const APP = settings.app_name;
type Me = { handle: string; name: string; email: string; actor: string; address: string; readReceipts: boolean; encKeys: { n: number; keyId: string; publicKey: string }[]; clientKeys: { n: number; keyId: string; label: string | null; tokenId: number | null }[]; doorbell: { url: string; header: string; valueSet: boolean; extra: string[] }; unread: number; unreadMessages: number; requests: number; approvals: number };
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
    too_many_keys: detail || 'Remove an agent key first.', already_decided: 'That was already decided.',
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
      h('div', { class: 'side-links' },
        item('/', 'Inbox', me!.unreadMessages), item('/requests', 'Requests', me!.requests), item('/approvals', 'Approvals', me!.approvals), item('/compose', 'Compose'), item('/contacts', 'Contacts'), item('/settings', 'Settings'),
        h('button', { class: 'link', onclick: async () => { await api('/api/auth/logout', { body: {} }); me = null; nav('/login'); } }, 'Sign out'))),
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
/** Where to go after signing in: only a path on this site. */
function nextPath(): string {
  const n = new URLSearchParams(location.search).get('next') ?? '';
  return /^\/(?![/\\])/.test(n) && !n.includes('\\') ? n : '/'; // a path here: never //host or /\\host
}
const withNext = (to: string) => location.search.includes('next=') ? `${to}?next=${encodeURIComponent(nextPath())}` : to;

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
    mode === 'login' ? h('p', {}, 'New here? ', link(withNext('/signup'), 'Create an account')) : h('p', {}, 'Have an account? ', link(withNext('/login'), 'Sign in')));
  form.addEventListener('submit', busy(btn, async () => {
    await api(`/api/auth/${mode}`, { body: mode === 'login' ? { email: email.value, password: pw.value } : { email: email.value, password: pw.value, handle: handle.value, name: name.value } });
    await loadMe(); nav(nextPath());
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
      h('span', { class: 'who' }, h('span', { class: 'who-names' }, others || short(me!.actor)), t.members.length > 2 ? h('span', { class: 'tag' }, `${t.members.length} people`) : null),
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
    let agentName = '';
    try {
      const p = await decryptActivity(keys, m.activity);
      agentName = p.agent?.name ?? '';
      const refs = m.activity.object.attachment ?? [];
      const atts = await Promise.all(p.attachments.map(a => renderAttachment(a, refs.find((r: any) => r.url === a.url) ?? {})));
      body = [p.summary ? h('div', { class: 'subject' }, p.summary) : null, h('div', { class: 'text' }, p.content), atts.length ? h('div', { class: 'atts' }, atts) : null];
    } catch { body = [h('div', { class: 'muted' }, '(cannot decrypt with the keys in this browser)')]; }
    if (m.direction === 'in' && !m.readAt) unreadNotes.push(m.activity.object.id);
    const readers = Object.keys(m.readBy ?? {});
    const failed = (m.deliveries ?? []).filter((d: any) => d.status === 'failed');
    const queued = (m.deliveries ?? []).filter((d: any) => d.status === 'queued');
    items.append(h('article', { class: m.direction === 'out' ? 'msg out' : 'msg' },
      h('header', {}, h('span', {}, h('strong', {}, m.direction === 'out' ? 'You' : short(m.actor)), m.activity.object['am:agent'] === true ? h('span', { class: 'tag agent', title: 'Written by an agent' }, agentName ? `agent · ${agentName}` : 'agent') : null), h('span', { class: 'time' }, when(m.published))),
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

// ---------- agents: what a token may do, and what it must ask first ----------
const SCOPES: [string, string][] = [['read', 'Read mail'], ['send', 'Send and reply'], ['manage', 'Approve or block senders, change group members']];
const ASKS: [string, string][] = [['first_contact', 'Messaging someone new'], ['policy', 'Approving or blocking a sender'], ['members', 'Changing group members'], ['all_sends', 'Every message']];
const DEFAULT_ASK = ['first_contact', 'policy', 'members'];
function checks(legend: string, items: [string, string][], on: string[]) {
  const boxes = items.map(([value, label]) => ({ value, label, el: h('input', { type: 'checkbox', checked: on.includes(value) }) as HTMLInputElement }));
  const el = h('fieldset', { class: 'checks' }, h('legend', {}, legend), boxes.map(b => h('label', { class: 'switch' }, b.el, ' ', b.label)));
  return { el, values: () => boxes.filter(b => b.el.checked).map(b => b.value) };
}
const askWords = (ask: string[]) => ask.length ? `asks before: ${ASKS.filter(([v]) => ask.includes(v)).map(([, l]) => l.toLowerCase()).join(', ')}` : 'never asks';

async function settingsScreen() {
  const { tokens } = await api('/api/tokens');
  const err = errBox();
  const name = h('input', { value: me!.name, 'aria-label': 'Display name' }) as HTMLInputElement;
  const rr = h('input', { type: 'checkbox', role: 'switch', checked: me!.readReceipts }) as HTMLInputElement;
  const durl = h('input', { value: me!.doorbell.url, placeholder: 'https://…', 'aria-label': 'Doorbell URL' }) as HTMLInputElement;
  const dh = h('input', { value: me!.doorbell.header, 'aria-label': 'Header name' }) as HTMLInputElement;
  const dv = h('input', { type: 'password', placeholder: me!.doorbell.valueSet ? '(set - leave blank to keep)' : '(not set)', 'aria-label': 'Header value' }) as HTMLInputElement;
  const extraSet = me!.doorbell.extra;
  const dx = h('textarea', { rows: 2, placeholder: extraSet.length ? `(set: ${extraSet.join(', ')} - leave blank to keep)` : 'anthropic-version: 2023-06-01', 'aria-label': 'Extra headers' }) as HTMLTextAreaElement;
  const save = h('button', { class: 'primary', type: 'submit' }, 'Save') as HTMLButtonElement;
  const form = h('form', { class: 'card' }, h('h2', {}, 'Profile'), h('p', {}, 'Your address: ', h('strong', {}, me!.address)), h('label', {}, 'Display name', name),
    h('label', { class: 'switch' }, rr, ' Send read receipts'), h('p', { class: 'muted small' }, 'When on, people you message can see when you have read it. Off by default.'),
    h('h2', {}, 'Doorbell'), h('p', { class: 'muted small' }, 'Optional. A content-free POST to wake an agent when something arrives (for example a routine\'s webhook).'),
    h('label', {}, 'Doorbell URL', durl), h('label', {}, 'Header name', dh), h('label', {}, 'Header value', dv),
    h('p', { class: 'muted small' }, 'The value field takes only the value, for example "Bearer …". A full header line is also accepted.'),
    h('label', {}, 'Extra headers', dx),
    h('p', { class: 'muted small' }, 'For webhooks that need more than one header. One per line, as Name: value.',
      extraSet.length ? [' ', h('button', { type: 'button', class: 'link', onclick: async () => { await api('/api/settings', { method: 'PUT', body: { doorbellExtra: '' } }); await loadMe(); render(); } }, 'Remove extra headers')] : null),
    err, h('div', { class: 'row' }, save,
      me!.doorbell.url ? h('button', { type: 'button', onclick: async (e: Event) => { const b = e.target as HTMLElement; try { const r = await api('/api/doorbell/test', { body: {} }); b.textContent = `Test ring: HTTP ${r.status}`; } catch (x) { b.textContent = (x as Error).message; } } }, 'Send test ring') : null));
  form.addEventListener('submit', busy(save, async () => {
    const b: any = { name: name.value, readReceipts: rr.checked, doorbellUrl: durl.value, doorbellHeader: dh.value };
    if (dv.value) b.doorbellValue = dv.value;
    if (dx.value.trim()) b.doorbellExtra = dx.value;
    await api('/api/settings', { method: 'PUT', body: b }); await loadMe(); render();
  }, err));

  // Add an agent: a token, what it may do, what it asks first, and (by default) a key of its own.
  const aerr = errBox();
  const agentOut = h('div');
  const label = h('input', { placeholder: 'Name, for example Claude Code', 'aria-label': 'Agent name', required: true }) as HTMLInputElement;
  const scopes = checks('It may', SCOPES, ['read', 'send']);
  const asks = checks('It asks you first before', ASKS, DEFAULT_ASK);
  const ownKey = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const myKey = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const mk = h('button', { type: 'submit', class: 'primary' }, 'Add agent') as HTMLButtonElement;
  const keys = loadKeys();
  const aform = h('form', { class: 'agent-form' }, h('label', {}, 'Agent name', label), scopes.el, asks.el,
    h('fieldset', { class: 'checks' }, h('legend', {}, 'Encryption'),
      h('label', { class: 'switch' }, ownKey, ' Give it its own key (it reads mail sent from now on; revoking the agent removes the key)'),
      h('label', { class: 'switch' }, myKey, ' Also give it my key (it can read older mail too; taking that back means making yourself a new key)')),
    aerr, mk);
  aform.addEventListener('submit', busy(mk, async () => {
    if (!ownKey.checked && !myKey.checked) throw new Error('Without a key the agent cannot read or write anything. Tick at least one.');
    const t = await api('/api/tokens', { body: { label: label.value, scopes: scopes.values(), ask: asks.values() } });
    const file: AgentFile = { type: 'agent-mail-agent', v: 1, url: cfg.origin, token: t.token, name: label.value.trim(), keys: [] };
    try {
      if (ownKey.checked) {
        const k = newKeyFile(me!.address, me!.actor, '');
        k.keyId = (await api('/api/keys/client', { method: 'PUT', body: { publicKey: k.publicKey, label: label.value, tokenId: t.id } })).keyId;
        file.keys.push(k);
      }
      if (myKey.checked) {
        const k = keys.find(x => x.keyId === me!.encKeys.at(-1)?.keyId);
        if (!k) throw new Error('Your own key is not in this browser.');
        file.keys.push(k);
      }
    } catch (x) { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }).catch(() => {}); throw x; }
    const fileName = `${(label.value.trim() || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.agent-mail-agent.json`;
    await loadMe();
    agentOut.replaceChildren(h('div', { class: 'card ok' },
      h('p', {}, 'Download the agent file now and give it to the agent. It holds the token and the key, and is not shown again.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => download(fileName, JSON.stringify(file, null, 2), 'application/json') }, 'Download agent file')),
      h('p', { class: 'muted small' }, 'Point the agent at it with AGENT_MAIL_CONFIG (the path, or the JSON itself), then run "agent-mail mcp" as a local MCP server, or use the agent-mail commands. Token, if you need it on its own:'),
      h('code', { class: 'token' }, t.token)));
    label.value = '';
  }, aerr));
  const agentLine = (t: any) => h('li', { class: 'agent' },
    h('div', {}, h('strong', {}, t.label), t.kind === 'oauth' ? h('span', { class: 'tag' }, 'connected app') : null, t.keyId ? h('span', { class: 'tag' }, `key ${t.keyId.split('#')[1]}`) : null,
      h('button', { class: 'link', onclick: async () => { if (confirm(`Revoke ${t.label}? It stops working at once.`)) { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); await loadMe(); render(); } } }, 'Revoke')),
    h('div', { class: 'muted small' }, `${SCOPES.filter(([v]) => t.scopes.includes(v)).map(([, l]) => l.toLowerCase()).join('; ') || 'nothing'} · ${askWords(t.ask)} · created ${when(t.created_at)}${t.last_used_at ? ', last used ' + when(t.last_used_at) : ''}`));
  shell('Settings', form,
    h('div', { class: 'card' }, h('h2', {}, 'Encryption keys'),
      h('ul', {}, me!.encKeys.map(k => h('li', {}, k.keyId.split('#')[1], keys.some(x => x.keyId === k.keyId) ? ' · in this browser' : ' · not in this browser', k === me!.encKeys.at(-1) ? h('span', { class: 'tag' }, 'current') : null))),
      h('div', { class: 'row' }, h('button', { onclick: () => { const k = keys.find(x => x.keyId === me!.encKeys.at(-1)?.keyId); if (k) download(keyFileName(), JSON.stringify(k, null, 2), 'application/json'); } }, 'Download key file'))),
    h('div', { class: 'card' }, h('h2', {}, 'Agents'),
      h('p', { class: 'muted small' }, `Agents work on their own and ask you only about what you tick below; what they ask shows up under Approvals. Apps that support it can also connect by signing in at ${cfg.origin}/mcp.`),
      tokens.length ? h('ul', { class: 'agents' }, tokens.map(agentLine)) : h('p', { class: 'muted' }, 'No agents yet.'),
      h('h2', {}, 'Add an agent'), aform, agentOut));
}

// ---------- approvals: what agents asked before doing ----------
const REASONS: Record<string, string> = {
  first_contact: 'This would be the first message to someone you have not written to before.',
  agent_flagged: 'The agent marked this message as sensitive.',
  all_sends: 'This agent asks before every message.',
  policy: 'Letting people in, or shutting them out, is yours to decide.',
  members: 'This agent asks before changing who is in a thread.',
};
async function approvalsScreen() {
  const { items }: { items: any[] } = await api('/api/approvals');
  const keys = loadKeys();
  const pending = h('div');
  const decide = (id: number, what: 'approve' | 'deny', btn: HTMLButtonElement, err: HTMLElement) => busy(btn, async () => {
    const r = await api(`/api/approvals/${id}/${what}`, { body: {} });
    if (r.status === 'failed') throw new Error(`Could not carry it out: ${r.result?.detail ?? r.result?.error ?? 'unknown error'}`);
    await loadMe(); render();
  }, err);
  for (const a of items.filter(x => x.status === 'pending')) {
    const s = a.subject ?? {};
    let what: Child[] = [];
    if (a.kind === 'send') {
      let preview: Child[] = [h('p', { class: 'muted' }, '(cannot decrypt with the keys in this browser)')];
      try {
        const p = await decryptActivity(keys, a.activity);
        preview = [p.summary ? h('div', { class: 'subject' }, p.summary) : null, h('div', { class: 'text' }, p.content),
          p.attachments.length ? h('p', { class: 'muted small' }, `Attachments: ${p.attachments.map(x => x.name).join(', ')}`) : null];
      } catch { /* keep the note */ }
      what = [h('p', {}, `${s.newThread ? 'New message' : 'Reply'} to `, h('strong', {}, (s.to ?? []).map(short).join(', '))), h('div', { class: 'msg preview' }, ...preview)];
    } else if (a.kind === 'approve' || a.kind === 'block') {
      what = [h('p', {}, a.kind === 'approve' ? 'Approve ' : 'Block ', h('strong', {}, short(s.actor ?? '')), s.pendingRequests ? ` (${s.pendingRequests} request${s.pendingRequests === 1 ? '' : 's'} waiting)` : '')];
    } else {
      const leaving = (s.remove ?? []).includes(me!.actor);
      what = [h('p', {}, leaving ? 'Leave a thread' : 'Change the members of a thread', (s.add ?? []).length ? `: add ${s.add.map(short).join(', ')}` : '', (s.remove ?? []).filter((x: string) => x !== me!.actor).length ? `: remove ${s.remove.filter((x: string) => x !== me!.actor).map(short).join(', ')}` : '')];
    }
    const err = errBox();
    const yes = h('button', { class: 'primary' }, 'Approve') as HTMLButtonElement, no = h('button', {}, 'Deny') as HTMLButtonElement;
    yes.addEventListener('click', decide(a.id, 'approve', yes, err));
    no.addEventListener('click', decide(a.id, 'deny', no, err));
    pending.append(h('div', { class: 'card approval' }, h('header', {}, h('strong', {}, a.agent), h('span', { class: 'time' }, when(a.createdAt))), ...what,
      h('p', { class: 'muted small' }, REASONS[a.reason] ?? ''), err, h('div', { class: 'row' }, yes, no)));
  }
  const done = items.filter(x => x.status !== 'pending');
  const kindWord: Record<string, string> = { send: 'message', approve: 'approve a sender', block: 'block a sender', members: 'change members' };
  shell('Approvals', h('p', { class: 'muted' }, 'Your agents work on their own. What they were told to ask about first waits here until you decide.'),
    pending.childElementCount ? pending : h('p', { class: 'muted empty' }, 'Nothing is waiting for you.'),
    done.length ? h('h2', {}, 'Recently decided') : null,
    done.length ? h('table', {}, h('tbody', {}, done.map(a => h('tr', {}, h('td', {}, a.agent), h('td', {}, kindWord[a.kind] ?? a.kind), h('td', {}, a.status), h('td', {}, when(a.decidedAt ?? a.createdAt)))))) : null);
}

// ---------- OAuth consent: an app asks to connect ----------
async function consentScreen() {
  const params = Object.fromEntries(new URLSearchParams(location.search));
  let info: { name: string; redirectHost: string; scopes: string[]; defaultAsk: string[] };
  try { info = await api(`/api/oauth/client?${new URLSearchParams(params)}`); }
  catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') throw e;
    root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card auth' }, h('h1', {}, APP), h('p', { class: 'error' }, 'This sign-in request cannot be used.'), h('p', { class: 'muted' }, (e as Error).message))));
    return;
  }
  const err = errBox();
  const scopes = checks('Let it', SCOPES.filter(([v]) => info.scopes.includes(v)), info.scopes.filter(s => s !== 'manage'));
  const asks = checks('It asks you first before', ASKS, info.defaultAsk);
  const allow = h('button', { class: 'primary' }, 'Allow') as HTMLButtonElement, deny = h('button', {}, 'Deny') as HTMLButtonElement;
  const go = (yes: boolean, btn: HTMLButtonElement) => busy(btn, async () => {
    const r = await api('/api/oauth/approve', { body: { allow: yes, params, scopes: scopes.values(), ask: asks.values() } });
    location.assign(r.redirect);
  }, err);
  allow.addEventListener('click', go(true, allow));
  deny.addEventListener('click', go(false, deny));
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card auth consent' },
    h('h1', {}, APP), h('p', {}, h('strong', {}, info.name), ' wants to connect to the inbox of ', h('strong', {}, me!.address), '.'),
    h('p', { class: 'muted small' }, `You will be sent back to ${info.redirectHost}. Messages stay encrypted: this app receives ciphertext unless it also holds one of your keys.`),
    scopes.el, asks.el, err, h('div', { class: 'row' }, allow, deny),
    h('p', { class: 'muted small' }, 'You can revoke it at any time under Settings, Agents.'))));
}

// ---------- router ----------
async function loadMe() {
  try { me = (await api('/api/me')).user; } catch { me = null; }
}
const toLogin = () => {
  const here = location.pathname + location.search;
  history.replaceState({}, '', here === '/' || location.pathname === '/login' || location.pathname === '/signup' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
  return authScreen('login');
};
async function render() {
  const p = location.pathname;
  try {
    if (p === '/login' || p === '/signup') return authScreen(p === '/login' ? 'login' : 'signup');
    await loadMe(); // every navigation: the counts in the nav (inbox, requests, approvals) stay current
    if (!me) return toLogin();
    document.title = APP;
    if (p === '/oauth/authorize') return await consentScreen();
    if (!hasCurrentKey()) return setupKeyScreen();
    if (p === '/thread') return await threadScreen();
    if (p === '/compose') return composeScreen();
    if (p === '/requests') return await requestsScreen();
    if (p === '/approvals') return await approvalsScreen();
    if (p === '/contacts') return await contactsScreen();
    if (p === '/settings') return await settingsScreen();
    return await inboxScreen();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') { me = null; return toLogin(); }
    root.replaceChildren(h('p', { class: 'error' }, (e as Error).message));
  }
}
window.addEventListener('popstate', render);
api('/api/config').then(c => { cfg = c; }).catch(() => {}).finally(render);
