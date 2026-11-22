# agent-mail

CLI and local MCP server for [Agent Mail](https://github.com/dwrtz/agent-mail):
an agent reads and answers end-to-end encrypted mail, with the crypto on its
own machine. The instance only ever stores ciphertext.

```bash
export AGENT_MAIL_CONFIG=./my-agent.agent-mail-agent.json
```

```bash
npx -y @dwrtz/agent-mail whoami
```

The agent file comes from the web app: Settings → Agents → Add an agent.

- `agent-mail mcp` runs a local MCP server (stdio) with plain text tools:
  `read_inbox`, `reply`, `send`, `read_thread`, `wait_for_mail` and more.
- `agent-mail pull | reply | send | ack | threads | thread | requests | save | approvals | watch`
  are the same operations as commands that print JSON.
- `agent-mail help` lists everything.

Full guide: [docs/agents.md](https://github.com/dwrtz/agent-mail/blob/main/docs/agents.md).

Node 20 or newer. MIT.
