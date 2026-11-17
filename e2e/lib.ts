// Test harness helpers: accounts over the owner API, MCP, and raw signed requests from the test probe actor.
import { ed25519 } from '@noble/curves/ed25519.js';
import { McpClient } from '../cli/src/mcp-client';
import { KeyFile, newKeyFile, Transport } from '../src/shared/client';
import { contentDigest } from '../src/shared/digest';
import { signRequest } from '../src/shared/httpsig';
import { te } from '../src/shared/enc';

export class Account {
  cookie = '';
  me: any;
  keys: KeyFile[] = [];
  token = '';
  mcp!: McpClient;
  constructor(public base: string) {}
  get actor() { return this.me.actor as string; }
  get address() { return this.me.address as string; }
  async api(path: string, o: { method?: string; body?: unknown; raw?: Uint8Array; expect?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { origin: this.base };
    if (this.cookie) headers.cookie = this.cookie;
    if (o.raw) headers['content-type'] = 'application/octet-stream';
    else if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method: o.method ?? (o.body !== undefined || o.raw ? 'POST' : 'GET'), headers, body: o.raw ? (o.raw as BodyInit) : o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('octet-stream') ? new Uint8Array(await res.arrayBuffer()) : await res.json().catch(() => null);
    if (o.expect !== undefined ? res.status !== o.expect : !res.ok) throw new Error(`${o.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  async signup(email: string, password: string, handle: string, name: string) {
    await this.api('/api/auth/signup', { body: { email, password, handle, name } });
    this.me = (await this.api('/api/me')).user;
  }
  async login(email: string, password: string) {
    await this.api('/api/auth/login', { body: { email, password } });
    this.me = (await this.api('/api/me')).user;
  }
  async setupKey() {
    const n = (this.me.encKeys.at(-1)?.n ?? 0) + 1;
    const k = newKeyFile(this.address, this.actor, `${this.actor}#enc-${n}`);
    const r = await this.api('/api/keys/encryption', { method: 'PUT', body: { publicKey: k.publicKey } });
    k.keyId = r.keyId; this.keys.push(k);
    this.me = (await this.api('/api/me')).user;
    return k;
  }
  async connect() {
    this.token = (await this.api('/api/tokens', { body: { label: 'e2e' } })).token;
    this.mcp = new McpClient(`${this.base}/mcp`, this.token);
    await this.mcp.init();
  }
  apiTransport(): Transport {
    return { prepare: a => this.api('/api/outbox/prepare', { body: a }), upload: b => this.api('/api/attachments', { raw: b }), send: b => this.api(`/users/${this.me.handle}/outbox`, { body: b }) };
  }
  mcpTransport(): Transport {
    return { prepare: a => this.mcp.tool('prepare_message', a), upload: b => this.api('/api/attachments', { raw: b }), send: b => this.mcp.tool('send_message', b) };
  }
}

/** The test probe: a remote actor at <testBase>/__test/probe whose private key the harness holds. */
export class Probe {
  constructor(public testBase: string, public privateKey: Uint8Array) {}
  get actor() { return `${this.testBase}/__test/probe`; }
  get keyId() { return `${this.actor}#sig-1`; }
  static publicMultikeyFor(priv: Uint8Array) { return ed25519.getPublicKey(priv); }
  /** Builds a signed inbox POST. Options let a test break exactly one thing. */
  async request(inbox: string, activity: any, o: { key?: Uint8Array; keyId?: string; created?: number; nonce?: string; contentType?: string; digestBody?: string; bodyOverride?: string; omitSignature?: boolean } = {}) {
    const body = o.bodyOverride ?? JSON.stringify(activity);
    const headers: Record<string, string> = { 'content-type': o.contentType ?? 'application/activity+json', 'content-digest': await contentDigest(te.encode(o.digestBody ?? body)) };
    const s = signRequest({ method: 'POST', url: inbox, headers }, { keyId: o.keyId ?? this.keyId, privateKey: o.key ?? this.privateKey, created: o.created, nonce: o.nonce });
    if (!o.omitSignature) { headers['signature-input'] = s['signature-input']; headers.signature = s.signature; }
    return { url: inbox, init: { method: 'POST', headers, body } as RequestInit };
  }
}

export async function send(r: { url: string; init: RequestInit }) {
  const res = await fetch(r.url, r.init);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 700));
  }
}
