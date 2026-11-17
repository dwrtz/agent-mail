// agent-mail CLI: decrypts and encrypts on your machine, talks to your instance's /mcp.
// Env: AGENT_MAIL_URL (https://agent.example.com), AGENT_MAIL_TOKEN (connector token), AGENT_MAIL_KEY (key file path).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpClient } from './mcp-client';
import { checkKeyFile, encryptAndSend, decryptActivity, decryptAttachment, Transport, KeyFile } from '../../src/shared/client';
import { unb64 } from '../../src/shared/enc';

const usage = `agent-mail <command>
  pull [--since N] [--limit N]     pull and decrypt unacked items (JSON)
  ack <upTo>                       acknowledge delivery of every item <= upTo
  send --to a@b[,c@d] [--subject S] [--attach FILE]... TEXT
  reply <noteId> [--attach FILE]... TEXT
  requests                         list message requests (decrypted)
  approve <actor> | block <actor>
  read <noteId>...                 mark read (sends receipts only if you turned them on)
  attachment <url> <size> <digest> <key> <iv> <outfile>
Env: AGENT_MAIL_URL, AGENT_MAIL_TOKEN, AGENT_MAIL_KEY (path to your .agent-mail-key.json; may list several, comma-separated)`;

function arg(args: string[], name: string, multi = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) { out.push(args[i + 1]); args.splice(i, 2); i--; if (!multi) break; }
  return out;
}

export async function main(argv: string[], env = process.env, log = (s: string) => console.log(s)) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { log(usage); return; }
  const url = (env.AGENT_MAIL_URL ?? '').replace(/\/+$/, '');
  if (!url || !env.AGENT_MAIL_TOKEN) throw new Error('set AGENT_MAIL_URL and AGENT_MAIL_TOKEN');
  const keys: KeyFile[] = (env.AGENT_MAIL_KEY ?? '').split(',').filter(Boolean).map(p => checkKeyFile(JSON.parse(readFileSync(p.trim(), 'utf8'))));
  const mcp = new McpClient(`${url}/mcp`, env.AGENT_MAIL_TOKEN);
  await mcp.init();
  const decrypt = async (a: any) => { try { return await decryptActivity(keys, a); } catch (e) { return { error: (e as Error).message }; } };
  const transport: Transport = {
    prepare: a => mcp.tool('prepare_message', a),
    upload: async bytes => {
      const res = await fetch(`${url}/api/attachments`, { method: 'POST', headers: { authorization: `Bearer ${env.AGENT_MAIL_TOKEN}`, 'content-type': 'application/octet-stream' }, body: bytes as BodyInit });
      if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
      return res.json() as any;
    },
    send: b => mcp.tool('send_message', b),
  };
  const files = (paths: string[]) => paths.map(p => ({ name: basename(p), mediaType: 'application/octet-stream', bytes: new Uint8Array(readFileSync(p)) }));
  switch (cmd) {
    case 'pull': {
      const r = await mcp.tool('pull', { since: Number(arg(args, '--since')[0] ?? 0), limit: Number(arg(args, '--limit')[0] ?? 50) });
      for (const it of r.items) if (it.kind === 'message') it.decrypted = await decrypt(it.activity);
      log(JSON.stringify(r, null, 2)); return r;
    }
    case 'ack': { const r = await mcp.tool('ack', { upTo: Number(args[0]) }); log(JSON.stringify(r)); return r; }
    case 'send': {
      const to = arg(args, '--to')[0]?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
      const subject = arg(args, '--subject')[0] ?? null;
      const att = arg(args, '--attach', true);
      const r = await encryptAndSend(transport, { to }, { subject, text: args.join(' '), files: files(att) });
      log(JSON.stringify(r)); return r;
    }
    case 'reply': {
      const noteId = args.shift()!;
      const att = arg(args, '--attach', true);
      const r = await encryptAndSend(transport, { replyTo: noteId }, { text: args.join(' '), files: files(att) });
      log(JSON.stringify(r)); return r;
    }
    case 'requests': {
      const r = await mcp.tool('list_requests');
      for (const it of r.items) if (it.activity.type === 'Create') it.decrypted = await decrypt(it.activity);
      log(JSON.stringify(r, null, 2)); return r;
    }
    case 'approve': case 'block': { const r = await mcp.tool(cmd, { actor: args[0] }); log(JSON.stringify(r)); return r; }
    case 'read': { const r = await mcp.tool('mark_read', { noteIds: args }); log(JSON.stringify(r)); return r; }
    case 'attachment': {
      const [u, size, digest, key, iv, out] = args;
      const r = await mcp.tool('fetch_attachment', { url: u, size: Number(size), digest });
      const plain = await decryptAttachment(unb64(r.base64), { key, iv });
      writeFileSync(out, plain); log(`wrote ${plain.length} bytes to ${out}`); return;
    }
  }
  throw new Error(`unknown command ${cmd}\n${usage}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
