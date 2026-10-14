import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readUpdates } from '../src/audit.ts';
import { activeVersion, compareSemver, newestAfter, parseSemver, tagsOf } from '../src/releases.ts';
import { listFailedData, listSnapshots } from '../src/snapshots.ts';
import { runRollback, runUpdate, safePoint } from '../src/updater.ts';
import { until } from './helpers.ts';
import { harness, readTree, type Harness } from './update-helpers.ts';

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.shutdown()));
});

async function running(current = '1.0.0-beta.1'): Promise<Harness> {
  const h = await harness(current);
  open.push(h);
  await h.boot();
  await until('the first core is up', async () => h.supervisor()?.snapshot().workspaces[0]?.pid);
  await until('its socket exists', () => existsSync(join(h.cfg.dataDir, 'workspaces', 'alpha', 'admin.sock')));
  return h;
}

const notices = (h: Harness): string[] =>
  existsSync(h.noticesFile)
    ? readFileSync(h.noticesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { args: [string, string] }).args[1])
    : [];

test('versions: semver order, channels, tags from ls-remote', () => {
  assert.ok(compareSemver(parseSemver('1.0.0-beta.2')!, parseSemver('1.0.0-beta.10')!) < 0);
  assert.ok(compareSemver(parseSemver('1.0.0-beta.10')!, parseSemver('1.0.0')!) < 0);
  assert.ok(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.1-beta.1')!) < 0);
  assert.equal(parseSemver('latest'), null);
  const tags = ['v1.0.0-beta.1', 'v1.0.0-beta.2', 'v1.0.0-beta.10', 'v0.9.0', 'nightly', 'v1.0.0'];
  assert.equal(newestAfter(tags, '1.0.0-beta.2', 'beta'), '1.0.0', 'beta follows releases too');
  assert.equal(newestAfter(tags.slice(0, 3), '1.0.0-beta.2', 'beta'), '1.0.0-beta.10');
  assert.equal(newestAfter(tags.slice(0, 3), '1.0.0-beta.2', 'stable'), null, 'stable skips prereleases');
  assert.equal(newestAfter(tags, '0.9.0', 'stable'), '1.0.0');
  assert.equal(newestAfter(tags, '1.0.0', 'beta'), null);
  assert.equal(newestAfter(tags, '0.1.0', 'off'), null);
  assert.deepEqual(tagsOf('abc123\trefs/tags/v1.0.0-beta.1\ndef456\trefs/tags/v1.0.0\n'), ['v1.0.0-beta.1', 'v1.0.0']);
});

test('update: snapshot taken, link swapped, new version healthy, audited, the person told', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  const before = readTree(h.cfg.dataDir);

  const result = await runUpdate(h.cfg, h.deps, { trigger: 'timer' });
  assert.equal(result.status, 'updated', JSON.stringify(result));
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.2');
  assert.deepEqual(h.built, ['1.0.0-beta.2']);

  const [snap] = listSnapshots(h.cfg.snapshotsDir);
  assert.ok(snap);
  assert.equal(snap.meta.from, '1.0.0-beta.1');
  assert.equal(snap.meta.to, '1.0.0-beta.2');
  assert.match(snap.name, /^\d{8}T\d{6}Z-1\.0\.0-beta\.1$/);
  // the data as it was before, secrets.json still 0600
  const copied = readTree(join(snap.dir, 'data'));
  for (const [file, text] of Object.entries(before)) assert.equal(copied[file], text, file);
  assert.equal(lstatSync(join(snap.dir, 'data', 'secrets.json')).mode & 0o777, 0o600);

  const health = await fetch(`http://127.0.0.1:${h.cfg.dataDir && h.supervisor()!.snapshot().workspaces[0]!.port}/healthz`).then((r) => r.json());
  assert.equal((health as { version: string }).version, '1.0.0-beta.2');
  assert.ok(existsSync(join(h.cfg.releasesDir, '1.0.0-beta.1')), 'the previous release is kept for a rollback');

  const [record] = readUpdates(h.cfg.stateDir);
  assert.equal(record?.event, 'update');
  assert.equal(record?.from, '1.0.0-beta.1');
  assert.equal(record?.to, '1.0.0-beta.2');
  assert.equal(record?.snapshot, snap.name);
  assert.equal(notices(h).length, 1);
  assert.match(notices(h)[0]!, /Updated from 1\.0\.0-beta\.1 to 1\.0\.0-beta\.2/);
});

for (const [name, behaviour] of [
  ['reports the wrong version', { FAKE_CORE_VERSION: '9.9.9' }],
  ['crashes soon after it starts', { FAKE_CORE_CRASH_AFTER_MS: '300' }],
  ['does not serve the web client', { FAKE_CORE_NO_WEB: '1' }],
] as const) {
  test(`a version that ${name} is rolled back with its snapshot, and the instance keeps working`, async () => {
    const h = await running();
    h.tags.push('v1.0.0-beta.2');
    // A newer schema: the new core rewrites the data at its first start.
    h.behaviours['1.0.0-beta.2'] = { FAKE_CORE_MARKER: 'schema-v23.marker', ...behaviour };
    const before = readTree(h.cfg.dataDir);

    const result = await runUpdate(h.cfg, h.deps, { trigger: 'timer' });
    assert.equal(result.status, 'rolled-back', JSON.stringify(result));

    assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
    assert.deepEqual(readTree(h.cfg.dataDir), before, 'the data is as it was before the update');
    assert.equal(existsSync(join(h.cfg.dataDir, 'schema-v23.marker')), false);
    assert.equal(lstatSync(join(h.cfg.dataDir, 'secrets.json')).mode & 0o777, 0o600);

    // the failed version's data was set aside, not deleted
    const [kept] = listFailedData(h.cfg.snapshotsDir);
    assert.match(kept ?? '', /-failed-1\.0\.0-beta\.2$/);
    assert.ok(existsSync(join(h.cfg.snapshotsDir, kept!, 'data', 'schema-v23.marker')));

    // and the old version is up again
    const port = h.supervisor()!.snapshot().workspaces[0]!.port;
    const health = (await until('the old core answers', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
      return r?.ok ? ((await r.json()) as { version: string }) : null;
    })) as { version: string };
    assert.equal(health.version, '1.0.0-beta.1');

    const events = readUpdates(h.cfg.stateDir).map((r) => r.event);
    assert.deepEqual(events, ['rollback']);
    assert.equal(readUpdates(h.cfg.stateDir)[0]?.trigger, 'health-check');
    assert.match(notices(h)[0] ?? '', /rolled back to 1\.0\.0-beta\.1/);

    // the timer (and --check, which says what the timer would do) does not offer the same version again; a person asking with --now gets it tried
    assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'timer' })).status, 'up-to-date');
    assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'manual', check: true })).status, 'up-to-date');
    assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'manual', force: true })).status, 'rolled-back');
    assert.deepEqual(readTree(h.cfg.dataDir), before);
  });
}

test('only the newest two snapshots and the active and previous releases stay', async () => {
  const h = await running();
  for (const v of ['1.0.0-beta.2', '1.0.0-beta.3', '1.0.0-beta.4']) {
    h.tags.push(`v${v}`);
    assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'timer' })).status, 'updated');
  }
  const snaps = listSnapshots(h.cfg.snapshotsDir);
  assert.deepEqual(snaps.map((s) => s.meta.from), ['1.0.0-beta.3', '1.0.0-beta.2']);
  assert.deepEqual(readdirSync(h.cfg.releasesDir).sort(), ['1.0.0-beta.3', '1.0.0-beta.4']);
});

test('an update waits while an action executes or a run has an agent working, and goes on when only parked runs are left', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');

  writeFileSync(h.stateFile, JSON.stringify({ actions: [{ id: 'a-1', kind: 'run-push', state: 'running' }], runs: [] }));
  assert.match((await safePoint(h.cfg)).join(), /alpha: action a-1 \(run-push\) is executing/);
  const first = await runUpdate(h.cfg, h.deps, { trigger: 'timer' });
  assert.equal(first.status, 'postponed');
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
  assert.equal(listSnapshots(h.cfg.snapshotsDir).length, 0, 'nothing was snapshotted');
  assert.ok(h.supervisor()?.snapshot().workspaces[0]?.pid, 'the instance was never stopped');
  assert.equal(readUpdates(h.cfg.stateDir)[0]?.event, 'update-postponed');

  writeFileSync(h.stateFile, JSON.stringify({ actions: [{ id: 'a-1', state: 'done' }], runs: [{ id: 'r-1', status: 'working', stage: 'dev' }] }));
  assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'timer' })).status, 'postponed');
  assert.deepEqual(h.built, ['1.0.0-beta.2'], 'the build is made once and kept for the next try');

  writeFileSync(h.stateFile, JSON.stringify({ actions: [{ id: 'a-1', state: 'done' }], runs: [{ id: 'r-1', status: 'gate', stage: 'plan' }, { id: 'r-2', status: 'failed', stage: 'dev' }] }));
  assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'timer' })).status, 'updated');
});

test('--check says what is available and whether now is a safe point, and changes nothing', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  const result = await runUpdate(h.cfg, h.deps, { trigger: 'manual', check: true });
  assert.deepEqual(result, { status: 'available', version: '1.0.0-beta.2', busy: [] });
  assert.deepEqual(h.built, []);
  assert.equal(readUpdates(h.cfg.stateDir).length, 0);
});

test('the channel decides: off does nothing unless asked, stable skips betas', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  assert.equal((await runUpdate({ ...h.cfg, channel: 'off' }, h.deps, { trigger: 'timer' })).status, 'off');
  assert.equal((await runUpdate({ ...h.cfg, channel: 'stable' }, h.deps, { trigger: 'timer' })).status, 'up-to-date');
  assert.equal((await runUpdate({ ...h.cfg, channel: 'off' }, h.deps, { trigger: 'manual', force: true })).status, 'updated');
});

test('a build that fails changes nothing and the instance keeps running', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  h.behaviours['1.0.0-beta.2'] = 'build-fails';
  const result = await runUpdate(h.cfg, h.deps, { trigger: 'timer' });
  assert.equal(result.status, 'failed');
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
  assert.ok(h.supervisor()?.snapshot().workspaces[0]?.pid);
  assert.equal(listSnapshots(h.cfg.snapshotsDir).length, 0);
  assert.equal(readUpdates(h.cfg.stateDir)[0]?.event, 'update-failed');
});

test('a snapshot that cannot be made abandons the update and starts the old version again', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  // a file where the snapshots folder should be
  writeFileSync(h.cfg.snapshotsDir, 'in the way');
  const result = await runUpdate(h.cfg, h.deps, { trigger: 'timer' });
  assert.equal(result.status, 'failed');
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
  await until('the old core is back', () => h.supervisor()?.snapshot().workspaces[0]?.pid);
});

test('manual rollback: the previous release and the data from before the update; what was written since is set aside', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  const before = readTree(h.cfg.dataDir);
  assert.equal((await runUpdate(h.cfg, h.deps, { trigger: 'timer' })).status, 'updated');
  // work done on the new version
  writeFileSync(join(h.cfg.dataDir, 'workspaces', 'alpha', 'runs', 'r-2.json'), '{"status":"done"}\n');

  const result = await runRollback(h.cfg, h.deps);
  assert.equal(result.status, 'rolled-back', JSON.stringify(result));
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
  assert.deepEqual(readTree(h.cfg.dataDir), before);
  const [kept] = listFailedData(h.cfg.snapshotsDir);
  assert.ok(existsSync(join(h.cfg.snapshotsDir, kept!, 'data', 'workspaces', 'alpha', 'runs', 'r-2.json')));
  const last = readUpdates(h.cfg.stateDir).at(-1);
  assert.equal(last?.event, 'rollback');
  assert.equal(last?.trigger, 'manual');
  assert.match(notices(h).at(-1) ?? '', /Rolled back from 1\.0\.0-beta\.2 to 1\.0\.0-beta\.1/);
});

test('rollback with no snapshot for the running version says so and changes nothing', async () => {
  const h = await running();
  await assert.rejects(runRollback(h.cfg, h.deps), /no snapshot was taken/);
  assert.equal(activeVersion(h.cfg.appLink), '1.0.0-beta.1');
});

test('an app folder that is not a link to a release is refused with a pointer to the install script', async () => {
  const h = await running();
  h.tags.push('v1.0.0-beta.2');
  await assert.rejects(runUpdate({ ...h.cfg, appLink: h.cfg.releasesDir }, h.deps, { trigger: 'timer' }), /not a link to a release folder/);
});
