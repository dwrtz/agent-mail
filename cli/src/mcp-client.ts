// A minimal MCP Streamable HTTP client for agent-mail's /mcp (used by the CLI and the e2e test).
export class McpClient {
  sessionId: string | null = null;
  private n = 0;
  constructor(public url: string, private token: string) {}
  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...extra };
  }
  async rpc(method: string, params?: unknown): Promise<any> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const data: any = await res.json().catch(() => null);
    if (!res.ok || data?.error) throw new Error(`MCP ${method}: ${res.status} ${JSON.stringify(data?.error ?? data)}`);
    return data.result;
  }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-mail-cli', version: '0.1.0' } });
    await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    return r;
  }
  async tool(name: string, args: unknown = {}): Promise<any> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  }
  /** Opens the server stream and calls onEvent for each JSON-RPC message. Returns a function that closes it. */
  async listen(onEvent: (msg: any) => void): Promise<() => void> {
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
    })();
    return () => ac.abort();
  }
}
