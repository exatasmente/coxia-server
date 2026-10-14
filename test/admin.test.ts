import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { AdminError, CONTRACT_VERSION, adminCall, adminSocketPath } from '../src/core.ts';
import { freePort, sandbox } from './helpers.ts';

const MAIN = join(import.meta.dirname, '../src/main.ts');

// A stand-in for a core's admin socket (protocol v1): the hello, then one answer per request, with an event pushed in between.
function fakeAdmin(path: string, opts: { version?: number } = {}): Promise<{ server: Server; seen: unknown[] }> {
  const seen: unknown[] = [];
  const server = createServer((sock: Socket) => {
    let buffer = '';
    let greeted = false;
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl)) as { hello?: number; id?: number; channel?: string; args?: unknown[] };
        buffer = buffer.slice(nl + 1);
        seen.push(msg);
        if (!greeted) {
          greeted = true;
          const version = opts.version ?? CONTRACT_VERSION;
          if (msg.hello !== version) {
            sock.end(`${JSON.stringify({ error: { code: 'contract-mismatch', message: `client ${msg.hello}, core ${version}` } })}\n`);
            return;
          }
          sock.write(`${JSON.stringify({ hello: { version, workspace: 'alpha' } })}\n`);
          continue;
        }
        sock.write(`${JSON.stringify({ event: { type: 'module', name: 'noise', payload: null } })}\n`);
        if (msg.channel === 'web:pair') sock.write(`${JSON.stringify({ id: msg.id, ok: true, value: { code: 'ABCD-EFGH-JKLM', expiresAt: 1_900_000_000_000 } })}\n`);
        else if (msg.channel === 'web:view') sock.write(`${JSON.stringify({ id: msg.id, ok: true, value: { settings: { basePath: '/cerimonias/' } } })}\n`);
        else if (msg.channel === 'echo') sock.write(`${JSON.stringify({ id: msg.id, ok: true, value: msg.args })}\n`);
        else sock.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'unknown-channel', message: `no channel ${msg.channel}` } })}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, seen })));
}

function withSocket(s: ReturnType<typeof sandbox>, workspace: string): string {
  const path = adminSocketPath(s.dataDir, workspace);
  mkdirSync(join(s.dataDir, 'workspaces', workspace), { recursive: true });
  return path;
}

test('adminCall says hello with the contract version and returns the value, past events', async () => {
  const s = sandbox(await freePort());
  const path = withSocket(s, 'alpha');
  const { server, seen } = await fakeAdmin(path);
  try {
    assert.deepEqual(await adminCall(path, 'echo', [1, 'two']), [1, 'two']);
    assert.deepEqual(seen[0], { hello: CONTRACT_VERSION });
    assert.deepEqual(seen[1], { id: 1, channel: 'echo', args: [1, 'two'] });
  } finally {
    server.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('adminCall surfaces the core code: an unknown channel, a contract mismatch, no core listening', async () => {
  const s = sandbox(await freePort());
  const path = withSocket(s, 'alpha');
  const { server } = await fakeAdmin(path);
  try {
    await assert.rejects(adminCall(path, 'nope'), (e: unknown) => e instanceof AdminError && e.code === 'unknown-channel');
  } finally {
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(adminCall(path, 'web:pair'), (e: unknown) => e instanceof AdminError && e.code === 'unreachable');
  const other = await fakeAdmin(path, { version: CONTRACT_VERSION + 1 });
  try {
    await assert.rejects(adminCall(path, 'web:pair'), (e: unknown) => e instanceof AdminError && e.code === 'contract-mismatch' && /core 2/.test(e.message));
  } finally {
    other.server.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('pair prints the code and the tunnel for the only workspace; call prints JSON; errors are one line and exit 1', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const path = withSocket(s, 'alpha');
  const { server } = await fakeAdmin(path);
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: s.dataDir, COXIA_STATE_DIR: s.stateDir };
  const run = promisify(execFile);
  try {
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(join(s.stateDir, 'ports.json'), JSON.stringify({ ports: { alpha: 28123 } }));
    const paired = await run(process.execPath, [MAIN, 'pair'], { env });
    assert.match(paired.stdout, /pairing code for alpha: ABCD-EFGH-JKLM/);
    assert.match(paired.stdout, /ssh -N -L 28123:127\.0\.0\.1:28123 /);
    // The page is under the base path the core reports.
    assert.match(paired.stdout, /open http:\/\/localhost:28123\/cerimonias\/ and type the code/);
    const echoed = await run(process.execPath, [MAIN, 'call', 'alpha', 'echo', '[{"a":1}]'], { env });
    assert.deepEqual(JSON.parse(echoed.stdout), [{ a: 1 }]);
    await assert.rejects(run(process.execPath, [MAIN, 'call', 'alpha', 'nope'], { env }), (e: { code?: number; stderr?: string }) => e.code === 1 && /unknown-channel/.test(e.stderr ?? ''));
    await assert.rejects(run(process.execPath, [MAIN, 'pair', 'beta'], { env }), (e: { code?: number; stderr?: string }) => e.code === 1 && /no workspace "beta"/.test(e.stderr ?? ''));
  } finally {
    server.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});
