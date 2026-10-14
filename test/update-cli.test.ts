import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ConfigError, loadUpdateConfig } from '../src/config.ts';
import { freePort, sandbox } from './helpers.ts';

const MAIN = join(import.meta.dirname, '../src/main.ts');
const run = promisify(execFile);

test('the update configuration: defaults beside the app link, the channel and the watch time checked', () => {
  const base = { COXIA_DATA_DIR: '/srv/coxia/data', COXIA_STATE_DIR: '/srv/coxia/state', COXIA_DIR: '/opt/coxia/app' };
  const cfg = loadUpdateConfig(base);
  assert.equal(cfg.channel, 'beta');
  assert.equal(cfg.releasesDir, '/opt/coxia/releases');
  assert.equal(cfg.snapshotsDir, '/srv/coxia/snapshots');
  assert.equal(cfg.healthMinutes, 5);
  assert.equal(cfg.notify, true);
  assert.equal(loadUpdateConfig({ ...base, COXIA_UPDATE_CHANNEL: 'stable', COXIA_UPDATE_NOTICE: '0' }).notify, false);
  assert.throws(() => loadUpdateConfig({ ...base, COXIA_UPDATE_CHANNEL: 'nightly' }), ConfigError);
  assert.throws(() => loadUpdateConfig({ ...base, COXIA_UPDATE_HEALTH_MINUTES: '0' }), ConfigError);
  assert.throws(() => loadUpdateConfig({ ...base, COXIA_SNAPSHOTS_DIR: '/srv/coxia/data/snapshots' }), /outside the data folder/);
});

test('update --check lists the newest tag of a repository and says it changes nothing; status shows the version and the channel', async () => {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  // A local repository stands in for the public one: ls-remote needs no network for a path.
  const repo = join(s.root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  git('tag', 'v1.0.0-beta.1');
  git('tag', 'v1.0.0-beta.2');
  git('tag', 'not-a-version');

  const releases = join(s.root, 'releases');
  mkdirSync(join(releases, '1.0.0-beta.1'), { recursive: true });
  symlinkSync(join(releases, '1.0.0-beta.1'), join(s.root, 'app'));
  const env = {
    PATH: process.env.PATH,
    COXIA_DATA_DIR: s.dataDir,
    COXIA_STATE_DIR: s.stateDir,
    COXIA_DIR: join(s.root, 'app'),
    COXIA_REPO_URL: repo,
  };
  const check = await run(process.execPath, [MAIN, 'update', '--check'], { env });
  assert.match(check.stdout, /1\.0\.0-beta\.2 is available; this is a safe point/);

  const bad = await run(process.execPath, [MAIN, 'update', '--now', '--check'], { env }).catch((e: { stderr: string }) => e);
  assert.match((bad as { stderr: string }).stderr, /usage: coxia-server update/);

  mkdirSync(s.stateDir, { recursive: true });
  appendFileSync(join(s.stateDir, 'updates.jsonl'), `${JSON.stringify({ at: '2026-03-01T10:00:00.000Z', event: 'rollback', from: '1.0.0-beta.2', to: '1.0.0-beta.1', trigger: 'health-check', keptData: '/x/failed' })}\n`);
  const status = await run(process.execPath, [MAIN, 'status'], { env }).catch((e: { stdout: string }) => e);
  const out = (status as { stdout: string }).stdout;
  assert.match(out, /version: 1\.0\.0-beta\.1, update channel: beta/);
  assert.match(out, /last update: none/);
  assert.match(out, /LAST ROLLBACK: rollback 1\.0\.0-beta\.2 -> 1\.0\.0-beta\.1 at 2026-03-01T10:00:00\.000Z, data kept in \/x\/failed/);
});
