// agent-mail CLI: decrypts and encrypts on your machine, talks to your instance's /mcp.
// `agent-mail mcp` runs the same thing as a local MCP server with plaintext tools.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Agent, loadConfig } from './agent';
import { serveStdio } from './local-mcp';
import { decryptAttachment } from '../../src/shared/client';
import { unb64 } from '../../src/shared/enc';

const usage = `agent-mail <command>

Read
  whoami                           your address, this agent's scopes and what it must ask the owner first
  pull [--since N] [--limit N]     pull and decrypt this agent's unacked items (JSON)
  ack <upTo>                       acknowledge every item <= upTo (this agent's queue only)
  threads                          threads with the latest message, decrypted
  thread <threadId> [--limit N]    the newest messages of a thread, decrypted
  requests                         message requests from people the owner has not approved (decrypted)
  save <noteId> <index> <outfile>  download and decrypt one attachment of a message
  read <noteId>...                 mark read (sends receipts only if the owner turned them on)

Write
  send --to a@b[,c@d] [--subject S] [--attach FILE]... [--sensitive] TEXT
  reply <noteId> [--attach FILE]... [--sensitive] TEXT
      Answers {"status":"sent"} or, when the owner must approve it first, {"status":"pending_approval"}.
      --sensitive asks the owner to look at this message before it goes out.
  approve <actor> | block <actor>  let a sender in, or drop them (may wait for the owner)
  members <threadId> [--add a@b]... [--remove a@b]...
  approvals [--pending]            what this agent asked the owner to approve, and how each ended

Wait
  watch [--exec CMD] [--once] [--interval SECONDS]
      Prints a JSON line (or runs CMD) when there is new mail, a new request or a decided approval.
      Uses the live stream, and checks every --interval seconds (default 60) in case a notice is missed.

Serve
  mcp                              a local MCP server (stdio) with plaintext tools: read_inbox, reply, send, ...
                                   Files it attaches or saves stay inside AGENT_MAIL_FILES (default ./agent-mail-files).

Env: AGENT_MAIL_CONFIG (the agent file from Settings: a path, or the JSON itself)
  or AGENT_MAIL_URL, AGENT_MAIL_TOKEN, AGENT_MAIL_KEY (key file path(s), comma-separated, or the JSON itself)`;

function arg(args: string[], name: string, multi = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) { out.push(args[i + 1]); args.splice(i, 2); i--; if (!multi) break; }
  return out;
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, log = (s: string) => console.log(s)): Promise<any> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { log(usage); return; }
  const agent = new Agent(loadConfig(env));
  if (cmd === 'mcp') return serveStdio(agent, env.AGENT_MAIL_FILES || 'agent-mail-files');
  await agent.connect();
  const mcp = agent.mcp;
  const print = <T>(r: T, pretty = false): T => { log(JSON.stringify(r, null, pretty ? 2 : undefined)); return r; };
  switch (cmd) {
    case 'whoami': return print(await agent.whoami(), true);
    case 'pull': {
      const r = await mcp.tool('pull', { since: Number(arg(args, '--since')[0] ?? 0), limit: Number(arg(args, '--limit')[0] ?? 50) });
      for (const it of r.items) if (it.kind === 'message') it.decrypted = await agent.decrypt(it.activity);
      return print(r, true);
    }
    case 'ack': return print(await agent.ack({ upTo: Number(args[0]) }));
    case 'threads': return print(await agent.threads(), true);
    case 'thread': {
      const limit = Number(arg(args, '--limit')[0] ?? 50);
      return print(await agent.thread(args[0], limit), true);
    }
    case 'send': {
      const to = arg(args, '--to')[0]?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
      const subject = arg(args, '--subject')[0] ?? null;
      const attach = arg(args, '--attach', true), sensitive = flag(args, '--sensitive');
      return print(await agent.send({ to }, { subject, text: args.join(' '), attach, sensitive }));
    }
    case 'reply': {
      const noteId = args.shift()!;
      const attach = arg(args, '--attach', true), sensitive = flag(args, '--sensitive');
      return print(await agent.send({ replyTo: noteId }, { text: args.join(' '), attach, sensitive }));
    }
    case 'requests': {
      const r = await mcp.tool('list_requests');
      for (const it of r.items) if (it.activity.type === 'Create') it.decrypted = await agent.decrypt(it.activity);
      return print(r, true);
    }
    case 'approve': case 'block': return print(await mcp.tool(cmd, { actor: args[0] }));
    case 'members': {
      const add = arg(args, '--add', true), remove = arg(args, '--remove', true);
      return print(await mcp.tool('change_members', { threadId: args[0], add, remove }));
    }
    case 'approvals': return print(await agent.approvals(flag(args, '--pending')), true);
    case 'read': return print(await mcp.tool('mark_read', { noteIds: args }));
    case 'save': return print(await agent.saveAttachment(args[0], Number(args[1] ?? 0), args[2]));
    case 'attachment': { // by hand: url, size and digest from the message, key and iv from its decrypted text
      const [u, size, digest, key, iv, out] = args;
      const r = await mcp.tool('fetch_attachment', { url: u, size: Number(size), digest });
      const plain = await decryptAttachment(unb64(r.base64), { key, iv });
      writeFileSync(out, plain); log(`wrote ${plain.length} bytes to ${out}`); return;
    }
    case 'watch': {
      const exec = arg(args, '--exec')[0], once = flag(args, '--once');
      const intervalMs = Math.max(5, Number(arg(args, '--interval')[0] ?? 60)) * 1000;
      return agent.watch({ once, intervalMs, onMail: async c => {
        const line = { ...c, at: new Date().toISOString() };
        if (!exec) { print(line); return; }
        // The command gets the counts in its environment; mail text never passes through here.
        await new Promise<void>(res => spawn(exec, { shell: true, stdio: 'inherit', env: { ...process.env, ...env, AGENT_MAIL_UNREAD: String(c.unread), AGENT_MAIL_REQUESTS: String(c.requests) } }).on('exit', () => res()).on('error', e => { console.error(`watch: ${e.message}`); res(); }));
      } });
    }
  }
  throw new Error(`unknown command ${cmd}\n${usage}`);
}
