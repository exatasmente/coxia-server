// Stands in for the Coxia headless entry: same flags, one ready line, GET /healthz, clean stop on SIGTERM.
// FAKE_CORE_LOG=<file>      appends one JSON line per start with the flags it got
// FAKE_CORE_IGNORE_TERM=1   ignores SIGTERM (to see the supervisor escalate to SIGKILL)
// GET /crash                exits 1
// --init --data-dir <dir>   writes a registry with one workspace, prints its id, exits 0 (as the real entry does)
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

if (process.argv[2] === '--init') {
  const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ current: 'principal', list: [{ id: 'principal', name: 'Principal', createdAt: '2026-01-01T00:00:00.000Z', test: false }] }));
  // Like the real entry, it logs before the id, which is the last line.
  console.log('[workspaces] registry created');
  console.log('principal');
  process.exit(0);
}

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

if (process.env.FAKE_CORE_LOG) appendFileSync(process.env.FAKE_CORE_LOG, `${JSON.stringify({ pid: process.pid, flags })}\n`);

const server = createServer((req, res) => {
  if (req.url === '/crash') process.exit(1);
  if (req.url !== '/healthz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, version: '0.0.0-fake', workspace: flags.workspace }));
});

process.on('SIGTERM', () => {
  if (process.env.FAKE_CORE_IGNORE_TERM === '1') return;
  server.close(() => process.exit(0));
  server.closeAllConnections();
});

server.on('error', (e) => {
  console.error(`cannot listen: ${e.message}`);
  process.exit(1);
});
server.listen(Number(flags.port), flags.host, () => console.log(`ready workspace=${flags.workspace} port=${flags.port}`));
