// Stands in for the Coxia headless entry: same flags, one ready line, GET /healthz, clean stop on SIGTERM.
// FAKE_CORE_LOG=<file>      appends one JSON line per start with the flags it got
// FAKE_CORE_IGNORE_TERM=1   ignores SIGTERM (to see the supervisor escalate to SIGKILL)
// GET /crash                exits 1
// FAKE_CORE_VERSION=<v>    the version /healthz reports (default 0.0.0-fake)
// FAKE_CORE_MARKER=<name>  writes that file into the data folder at start, as a newer schema's migration would
// FAKE_CORE_CRASH_AFTER_MS=<n>  exits 1 that long after it is ready
// FAKE_CORE_STATE=<file>   JSON {actions, runs} the admin socket answers actions:list / runs:list with, read on every call
// FAKE_CORE_NO_WEB=1       the web client path answers 404
// The admin socket (<data>/workspaces/<id>/admin.sock) speaks protocol v1 with web:view, actions:list, runs:list and forum:post.
// --init --data-dir <dir>   writes a registry with one workspace, prints its id, exits 0 (as the real entry does)
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createSocketServer } from 'node:net';
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

// --import <bundle> --data-dir <D> --master-key-file <K> --repos-root <R>: the one-shot import. Logs its arguments to FAKE_CORE_IMPORT_LOG, adds the
// bundle's registry entry to <D>/workspaces.json (FAKE_CORE_IMPORT_FAIL=1: exit 1 with `<code>: <message>` on stderr), prints the JSON line, never serves.
if (process.argv[2] === '--import') {
  const argv = process.argv.slice(2);
  const flag = (name) => argv[argv.indexOf(name) + 1];
  if (process.env.FAKE_CORE_IMPORT_LOG) appendFileSync(process.env.FAKE_CORE_IMPORT_LOG, `${JSON.stringify(argv)}\n`);
  if (process.env.FAKE_CORE_IMPORT_FAIL === '1') {
    console.error('conflict: the secret vcs.github exists with another cipher');
    process.exit(1);
  }
  const bundle = flag('--import');
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  const entry = JSON.parse(readFileSync(join(bundle, 'registry.json'), 'utf8'));
  const dataDir = flag('--data-dir');
  const file = join(dataDir, 'workspaces.json');
  let registry = { current: entry.id, list: [] };
  try {
    registry = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // a fresh data folder
  }
  const already = registry.list.some((w) => w.id === entry.id);
  if (!already) registry.list.push(entry);
  writeFileSync(file, JSON.stringify(registry));
  const root = flag('--repos-root');
  console.log(JSON.stringify({ imported: entry.id, ...(already ? { alreadyImported: true } : {}), repos: manifest.repos.map((r) => ({ id: r.id, path: join(root, r.id) })) }));
  process.exit(0);
}

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

if (process.env.FAKE_CORE_LOG) appendFileSync(process.env.FAKE_CORE_LOG, `${JSON.stringify({ pid: process.pid, flags })}\n`);

if (process.env.FAKE_CORE_MARKER) writeFileSync(join(flags['data-dir'], process.env.FAKE_CORE_MARKER), 'written by a newer version\n');

const BASE_PATH = '/cerimonias/';
const server = createServer((req, res) => {
  if (req.url === '/crash') process.exit(1);
  if (req.url === BASE_PATH && process.env.FAKE_CORE_NO_WEB !== '1') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    return;
  }
  if (req.url !== '/healthz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, version: process.env.FAKE_CORE_VERSION ?? '0.0.0-fake', workspace: flags.workspace }));
});

const adminDir = join(flags['data-dir'], 'workspaces', flags.workspace);
const adminPath = join(adminDir, 'admin.sock');
mkdirSync(adminDir, { recursive: true });
rmSync(adminPath, { force: true });
const adminState = () => {
  try {
    return JSON.parse(readFileSync(process.env.FAKE_CORE_STATE, 'utf8'));
  } catch {
    return { actions: [], runs: [] };
  }
};
let generalThread = false;
const admin = createSocketServer((sock) => {
  let buffer = '';
  let greeted = false;
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (!greeted) {
        greeted = true;
        sock.write(`${JSON.stringify({ hello: { version: 1, workspace: flags.workspace } })}\n`);
        continue;
      }
      let value;
      if (msg.channel === 'web:view') value = { settings: { basePath: BASE_PATH } };
      else if (msg.channel === 'actions:list') value = adminState().actions ?? [];
      else if (msg.channel === 'runs:list') value = adminState().runs ?? [];
      // As the real core: the general thread exists only once the forum has been listed.
      else if (msg.channel === 'forum:list') {
        generalThread = true;
        value = [];
      } else if (msg.channel === 'forum:post' && !generalThread) {
        sock.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'forum:unknown-thread', message: String(msg.args?.[0]) } })}\n`);
        continue;
      } else if (msg.channel === 'forum:post' && process.env.FAKE_CORE_NOTICES) {
        appendFileSync(process.env.FAKE_CORE_NOTICES, `${JSON.stringify({ workspace: flags.workspace, args: msg.args })}\n`);
        value = { seq: 1 };
      } else {
        sock.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'unknown-channel', message: msg.channel } })}\n`);
        continue;
      }
      sock.write(`${JSON.stringify({ id: msg.id, ok: true, value })}\n`);
    }
  });
});
admin.listen(adminPath);

process.on('SIGTERM', () => {
  if (process.env.FAKE_CORE_IGNORE_TERM === '1') return;
  admin.close();
  rmSync(adminPath, { force: true });
  server.close(() => process.exit(0));
  server.closeAllConnections();
});

server.on('error', (e) => {
  console.error(`cannot listen: ${e.message}`);
  process.exit(1);
});
server.listen(Number(flags.port), flags.host, () => {
  console.log(`ready workspace=${flags.workspace} port=${flags.port}`);
  if (process.env.FAKE_CORE_CRASH_AFTER_MS) setTimeout(() => process.exit(1), Number(process.env.FAKE_CORE_CRASH_AFTER_MS));
});
