import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';
import { readWorkspaceIds } from '../src/core.ts';
import { FAKE_CORE, sandbox } from './helpers.ts';

const base = (s: ReturnType<typeof sandbox>): NodeJS.ProcessEnv => ({
  COXIA_DATA_DIR: s.dataDir,
  COXIA_STATE_DIR: s.stateDir,
  COXIA_MASTER_KEY_FILE: s.config.masterKeyFile,
  COXIA_ENTRY: FAKE_CORE,
});

test('a complete environment loads', () => {
  const s = sandbox(9000);
  const c = loadConfig({ ...base(s), COXIA_BASE_PORT: '9100' });
  assert.equal(c.basePort, 9100);
  assert.equal(c.entry, FAKE_CORE);
});

test('the master key file inside the data folder is refused', () => {
  const s = sandbox(9000);
  const inside = join(s.dataDir, 'master.key');
  writeFileSync(inside, 'x');
  assert.throws(() => loadConfig({ ...base(s), COXIA_MASTER_KEY_FILE: inside }), ConfigError);
});

test('a missing variable, key file or entry is one clear error', () => {
  const s = sandbox(9000);
  assert.throws(() => loadConfig({ ...base(s), COXIA_DATA_DIR: undefined }), /COXIA_DATA_DIR is not set/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_MASTER_KEY_FILE: join(s.root, 'nope') }), /does not exist/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_ENTRY: join(s.root, 'nope.mjs') }), /headless bundle/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_BASE_PORT: '80' }), /COXIA_BASE_PORT/);
});

test('COXIA_PUBLIC_URLS gives a workspace its own public address', () => {
  const s = sandbox(9000);
  assert.deepEqual(loadConfig(base(s)).publicUrls, {});
  const c = loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=https://a.example.com/cerimonias/, beta=https://b.example.com/cerimonias/' });
  assert.deepEqual(c.publicUrls, { alpha: 'https://a.example.com/cerimonias/', beta: 'https://b.example.com/cerimonias/' });
  assert.deepEqual(loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=http://localhost:9000/cerimonias/' }).publicUrls, { alpha: 'http://localhost:9000/cerimonias/' });
});

test('a COXIA_PUBLIC_URLS that cannot be right is one clear error', () => {
  const s = sandbox(9000);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'https://a.example.com/' }), /is not workspace=url/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'Alpha=https://a.example.com/' }), /is not workspace=url/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=nope' }), /not a URL/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=http://a.example.com/' }), /must be https/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=ftp://localhost/' }), /must be https/);
  assert.throws(() => loadConfig({ ...base(s), COXIA_PUBLIC_URLS: 'alpha=https://a.example.com/,alpha=https://b.example.com/' }), /appears twice/);
});

test('the registry is read for ids only; bad entries and a bad file never read as "all removed"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coxia-server-reg-'));
  assert.equal(readWorkspaceIds(dir), null);
  writeFileSync(join(dir, 'workspaces.json'), '{broken');
  assert.equal(readWorkspaceIds(dir), null);
  mkdirSync(join(dir, 'x'));
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ current: 'a', list: [{ id: 'a' }, { id: 'a' }, { id: '--evil' }, { id: 'Up' }, { id: 7 }, { id: 'b-2' }] }));
  assert.deepEqual(readWorkspaceIds(dir), ['a', 'b-2']);
});
