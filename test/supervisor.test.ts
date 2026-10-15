import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { loadPorts } from '../src/ports.ts';
import { PORTS_FILE, STATE_FILE, Supervisor } from '../src/supervisor.ts';
import { alive, freePort, healthy, sandbox, starts, until } from './helpers.ts';

const running: Supervisor[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
});

function launch(s: ReturnType<typeof sandbox>, extra = {}): Supervisor {
  const sup = new Supervisor(s.options(extra));
  running.push(sup);
  sup.start();
  return sup;
}

const pidOf = (sup: Supervisor, id: string) => sup.snapshot().workspaces.find((w) => w.id === id)?.pid ?? null;
const portOf = (sup: Supervisor, id: string) => sup.snapshot().workspaces.find((w) => w.id === id)!.port;

test('one core per workspace, with the flags of the contract, on distinct loopback ports', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  const sup = launch(s);
  const [a, b] = [portOf(sup, 'alpha'), portOf(sup, 'beta')];
  assert.notEqual(a, b);
  const ha = await until('alpha healthy', () => healthy(a));
  const hb = await until('beta healthy', () => healthy(b));
  assert.equal(ha.workspace, 'alpha');
  assert.equal(hb.workspace, 'beta');

  const got = starts(s.logFile);
  assert.equal(got.length, 2);
  const alpha = got.find((g) => g.flags.workspace === 'alpha')!.flags;
  assert.equal(alpha['data-dir'], s.dataDir);
  assert.equal(alpha['master-key-file'], s.config.masterKeyFile);
  assert.equal(alpha.host, '127.0.0.1');
  assert.equal(alpha.port, String(a));
  assert.ok(s.lines.some((l) => l.startsWith('[alpha] ready')), 'child output is forwarded with the workspace prefix');
});

test('a workspace with its own public address gets --public-url; one without gets no flag', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  const sup = launch(s, { publicUrls: { alpha: 'https://a.example.com/cerimonias/' } });
  await until('alpha healthy', () => healthy(portOf(sup, 'alpha')));
  await until('beta healthy', () => healthy(portOf(sup, 'beta')));
  const got = starts(s.logFile);
  assert.equal(got.find((g) => g.flags.workspace === 'alpha')!.flags['public-url'], 'https://a.example.com/cerimonias/');
  assert.equal('public-url' in got.find((g) => g.flags.workspace === 'beta')!.flags, false);
});

test('ports are stable when the supervisor restarts, and written to the state folder', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  const first = launch(s);
  const before = { alpha: portOf(first, 'alpha'), beta: portOf(first, 'beta') };
  await until('both up', async () => (await healthy(before.alpha)) && (await healthy(before.beta)));
  await first.stop();
  assert.deepEqual(loadPorts(join(s.stateDir, PORTS_FILE)), before);

  // a workspace added in between must not shift the others
  s.setWorkspaces(['gamma', 'beta', 'alpha']);
  const second = launch(s);
  assert.equal(portOf(second, 'alpha'), before.alpha);
  assert.equal(portOf(second, 'beta'), before.beta);
  assert.ok(![before.alpha, before.beta].includes(portOf(second, 'gamma')));
});

test('a crashed core is restarted alone, with the same port', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta']);
  const sup = launch(s);
  const [pa, pb] = [portOf(sup, 'alpha'), portOf(sup, 'beta')];
  await until('both up', async () => (await healthy(pa)) && (await healthy(pb)));
  const oldAlpha = pidOf(sup, 'alpha')!;
  const betaPid = pidOf(sup, 'beta');

  process.kill(oldAlpha, 'SIGKILL');
  await until('alpha back', async () => {
    const pid = pidOf(sup, 'alpha');
    return pid !== null && pid !== oldAlpha && (await healthy(pa));
  });
  assert.equal(pidOf(sup, 'beta'), betaPid, 'the other core was not touched');
  assert.equal(sup.snapshot().workspaces.find((w) => w.id === 'alpha')!.restarts, 1);
  assert.equal(sup.snapshot().workspaces.find((w) => w.id === 'beta')!.restarts, 0);
  assert.equal(starts(s.logFile).filter((g) => g.flags.workspace === 'beta').length, 1);
});

test('a core that keeps crashing waits longer each time, up to the cap', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const sup = launch(s, { backoff: { initialMs: 40, maxMs: 160, stableMs: 60_000 } });
  const port = portOf(sup, 'alpha');
  for (let i = 0; i < 4; i++) {
    await until(`start ${i + 1}`, () => starts(s.logFile).length > i);
    await until('listening', () => healthy(port));
    const pid = pidOf(sup, 'alpha')!;
    // /crash makes the fake exit 1, as a core that cannot start would
    await new Promise<void>((resolve) => get({ host: '127.0.0.1', port, path: '/crash' }).on('error', () => resolve()).on('close', () => resolve()));
    await until('exit seen', () => !alive(pid));
  }
  const waits = s.lines.map((l) => /restarting in (\d+) ms/.exec(l)?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(waits.slice(0, 4), [40, 80, 160, 160]);
});

test('a workspace added to the registry starts, one removed stops, the rest stay up', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const sup = launch(s);
  const pa = portOf(sup, 'alpha');
  await until('alpha up', () => healthy(pa));
  const alphaPid = pidOf(sup, 'alpha');

  s.setWorkspaces(['alpha', 'beta']);
  const pb = await until('beta assigned', () => sup.snapshot().workspaces.find((w) => w.id === 'beta')?.port);
  await until('beta up', () => healthy(pb));
  assert.equal(pidOf(sup, 'alpha'), alphaPid);

  const betaPid = pidOf(sup, 'beta')!;
  s.setWorkspaces(['alpha']);
  await until('beta gone', async () => !alive(betaPid) && !(await healthy(pb)));
  await until('beta forgotten', () => !sup.snapshot().workspaces.some((w) => w.id === 'beta'));
  assert.equal(await healthy(pa) !== null, true);
  assert.deepEqual(Object.keys(loadPorts(join(s.stateDir, PORTS_FILE))), ['alpha']);
});

test('an unreadable registry keeps what runs', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const sup = launch(s);
  const pa = portOf(sup, 'alpha');
  await until('alpha up', () => healthy(pa));
  writeFileSync(join(s.dataDir, 'workspaces.json'), '{broken');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await healthy(pa));
  assert.equal(s.lines.filter((l) => l.includes('cannot read the workspace registry')).length, 1, 'warned once, not on every poll');
});

test('stop() ends every core within the deadline and removes the state file', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha', 'beta', 'gamma']);
  const sup = launch(s);
  const ports = sup.snapshot().workspaces.map((w) => w.port);
  await until('all up', async () => (await Promise.all(ports.map(healthy))).every(Boolean));
  const pids = sup.snapshot().workspaces.map((w) => w.pid!);
  assert.ok(readFileSync(join(s.stateDir, STATE_FILE), 'utf8').includes('alpha'));

  const t0 = Date.now();
  await sup.stop();
  assert.ok(Date.now() - t0 < 1500, 'clean stop is quick');
  assert.ok(pids.every((p) => !alive(p)));
  assert.throws(() => readFileSync(join(s.stateDir, STATE_FILE)));
  assert.ok(s.lines.some((l) => /\[alpha\] stopped \(exited with code 0\)/.test(l)), 'SIGTERM ended the core with exit 0');
});

test('a core that ignores SIGTERM is killed at the deadline', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  const sup = launch(s, { stopDeadlineMs: 300, env: { FAKE_CORE_LOG: s.logFile, FAKE_CORE_IGNORE_TERM: '1' } });
  const port = portOf(sup, 'alpha');
  await until('up', () => healthy(port));
  const pid = pidOf(sup, 'alpha')!;
  const t0 = Date.now();
  await sup.stop();
  assert.ok(Date.now() - t0 >= 300);
  assert.ok(!alive(pid));
  assert.ok(s.lines.some((l) => l.includes('sending SIGKILL')));
});

test('a fresh data folder gets its registry from the core, once, and its first workspace starts', async () => {
  const s = sandbox(await freePort());
  const sup = launch(s);
  const port = await until('principal assigned', () => sup.snapshot().workspaces.find((w) => w.id === 'principal')?.port ?? null);
  assert.equal((await until('principal healthy', () => healthy(port))).workspace, 'principal');
  assert.ok(s.lines.some((l) => l.includes('created the workspace registry, first workspace principal')));
  assert.equal(JSON.parse(readFileSync(join(s.dataDir, 'workspaces.json'), 'utf8')).current, 'principal');
});
