import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CONTRACT_VERSION, adminSocketPath } from '../src/core.ts';
import { freePort, sandbox } from './helpers.ts';

const MAIN = join(import.meta.dirname, '../src/main.ts');

// Echoes every line back wrapped, and says hello first; records whether the client half-closed.
function fakeSocket(path: string): Promise<{ close: () => void; halfClosed: Promise<void> }> {
  let mark!: () => void;
  const halfClosed = new Promise<void>((r) => (mark = r));
  const server = createServer((sock: Socket) => {
    sock.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { hello?: number; id?: number };
        sock.write(`${JSON.stringify(msg.hello !== undefined ? { hello: { version: CONTRACT_VERSION, workspace: 'alpha' } } : { id: msg.id, ok: true, value: 'pong' })}\n`);
      }
    });
    sock.on('end', () => {
      mark();
      sock.end();
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ close: () => server.close(), halfClosed })));
}

test('bridge copies bytes both ways and exits 0 when stdin ends', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  mkdirSync(join(s.dataDir, 'workspaces', 'alpha'), { recursive: true });
  const fake = await fakeSocket(adminSocketPath(s.dataDir, 'alpha'));
  try {
    const child = spawn(process.execPath, [MAIN, 'bridge', 'alpha'], { env: { PATH: process.env.PATH, COXIA_DATA_DIR: s.dataDir, COXIA_STATE_DIR: s.stateDir } });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    const until = async (re: RegExp) => {
      for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 30));
      assert.match(out, re);
    };
    child.stdin.write(`${JSON.stringify({ hello: CONTRACT_VERSION })}\n`);
    await until(/"hello":\{"version":\d+,"workspace":"alpha"\}\}\n/);
    child.stdin.write(`${JSON.stringify({ id: 1, channel: 'x', args: [] })}\n`);
    await until(/"id":1,"ok":true,"value":"pong"\}\n/);
    child.stdin.end();
    await fake.halfClosed;
    assert.equal(await exited, 0);
  } finally {
    fake.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('bridge: bad id, unknown workspace, no socket and a dead socket are one stderr line, exit 1, empty stdout', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  mkdirSync(join(s.dataDir, 'workspaces', 'alpha'), { recursive: true });
  mkdirSync(join(s.dataDir, 'workspaces', 'beta'), { recursive: true });
  // A socket file nobody listens on: bind, then leave the file behind.
  const dead = adminSocketPath(s.dataDir, 'beta');
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(dead, r));
  const handle = (tmp as unknown as { _handle: { close: () => void } })._handle;
  handle.close();
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: s.dataDir, COXIA_STATE_DIR: s.stateDir };
  const run = promisify(execFile);
  try {
    for (const args of [[], ['../etc'], ['Bad_ID'], ['gamma'], ['alpha'], ['beta']]) {
      await assert.rejects(run(process.execPath, [MAIN, 'bridge', ...args], { env }), (e: { code?: number; stdout?: string; stderr?: string }) => {
        assert.equal(e.code, 1, `exit for ${JSON.stringify(args)}`);
        assert.equal(e.stdout, '');
        assert.equal((e.stderr ?? '').trim().split('\n').length, 1, e.stderr);
        return true;
      });
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
