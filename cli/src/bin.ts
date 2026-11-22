// Entry point of the bundled CLI (cli/agent-mail.mjs).
import { main } from './cli';

main(process.argv.slice(2)).catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
