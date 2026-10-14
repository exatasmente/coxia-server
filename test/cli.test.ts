import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { FAKE_CORE, freePort, healthy, sandbox, until } from './helpers.ts';

const MAIN = join(import.meta.dirname, '../src/main.ts');

test('run supervises, status reports it, SIGTERM stops everything with exit 0', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  const env = {
    PATH: process.env.PATH,
    COXIA_DATA_DIR: s.dataDir,
    COXIA_STATE_DIR: s.stateDir,
    COXIA_MASTER_KEY_FILE: s.config.masterKeyFile,
    COXIA_ENTRY: FAKE_CORE,
    COXIA_BASE_PORT: String(s.config.basePort),
  };
  const sup = spawn(process.execPath, [MAIN, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  sup.stdout.on('data', (d: Buffer) => (out += d));
  const exit = new Promise<number | null>((resolve) => sup.on('exit', (code) => resolve(code)));
  try {
    await until('both cores up', async () => (await healthy(s.config.basePort)) && (await healthy(s.config.basePort + 1)));
    const { stdout } = await promisify(execFile)(process.execPath, [MAIN, 'status'], { env });
    assert.match(stdout, /supervisor: running/);
    assert.match(stdout, /alpha\s+\d+\s+\d+\s+running\s+0\s+ok/);
    assert.match(stdout, /beta\s+\d+\s+\d+\s+running\s+0\s+ok/);
  } finally {
    sup.kill('SIGTERM');
  }
  assert.equal(await exit, 0);
  assert.match(out, /\[alpha\] stopped \(exited with code 0\)/);
  assert.equal(await healthy(s.config.basePort), null);
});

test('status exits 1 when the supervisor is not running', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: s.dataDir, COXIA_STATE_DIR: s.stateDir };
  await assert.rejects(promisify(execFile)(process.execPath, [MAIN, 'status'], { env }), (e: { code?: number; stdout?: string }) => e.code === 1 && /not running/.test(e.stdout ?? ''));
});

test('run with a bad configuration exits 1 with one line, before starting anything', async () => {
  const s = sandbox(await freePort());
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: s.dataDir, COXIA_STATE_DIR: s.stateDir };
  await assert.rejects(promisify(execFile)(process.execPath, [MAIN, 'run'], { env }), (e: { code?: number; stderr?: string }) => e.code === 1 && /COXIA_MASTER_KEY_FILE is not set/.test(e.stderr ?? ''));
});
