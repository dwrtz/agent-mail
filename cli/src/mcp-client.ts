// A minimal MCP Streamable HTTP client for agent-mail's /mcp (used by the CLI and the e2e test).
export class McpClient {
  sessionId: string | null = null;
  private n = 0;
  constructor(public url: string, private token: string) {}
  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...extra };
  }
  async rpc(method: string, params?: unknown, retry = true): Promise<any> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const data: any = await res.json().catch(() => null);
    // The server forgets a session that sat idle for a day: start a new one and ask again.
    if (res.status === 404 && data?.error?.code === -32001 && retry && method !== 'initialize') { this.sessionId = null; await this.init(); return this.rpc(method, params, false); }
    if (!res.ok || data?.error) throw new Error(`MCP ${method}: ${res.status} ${JSON.stringify(data?.error ?? data)}`);
    return data.result;
  }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-mail-cli', version: '0.2.0' } });
    await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    return r;
  }
  async tool(name: string, args: unknown = {}): Promise<any> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  }
  async resource(uri: string): Promise<any> {
    return JSON.parse((await this.rpc('resources/read', { uri })).contents[0].text);
  }
  /** Opens the server stream and calls onEvent for each JSON-RPC message, onEnd when it closes. Returns a function that closes it. */
  async listen(onEvent: (msg: any) => void, onEnd: () => void = () => {}): Promise<() => void> {
    const ac = new AbortController();
    const res = await fetch(this.url, { method: 'GET', headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream', 'mcp-session-id': this.sessionId ?? '' }, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
    (async () => {
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
            if (data) { try { onEvent(JSON.parse(data)); } catch {} }
          }
        }
      } catch {}
      if (!ac.signal.aborted) onEnd();
    })();
    return () => ac.abort();
  }
}
