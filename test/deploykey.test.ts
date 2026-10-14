import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deployKeyPath, ensureDeployKey } from '../src/deploykey.ts';
import { directRunner, tempRoot } from './import-helpers.ts';

test('deploy-key creates an ed25519 key once, with strict modes, and returns the public line', async () => {
  const home = tempRoot();
  const key = await ensureDeployKey(home, directRunner);
  assert.equal(key.created, true);
  assert.match(key.publicLine, /^ssh-ed25519 \S+ coxia@/);
  assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
  assert.equal(statSync(deployKeyPath(home)).mode & 0o777, 0o600);
});

test('deploy-key never overwrites an existing key', async () => {
  const home = tempRoot();
  const first = await ensureDeployKey(home, directRunner);
  const privateBefore = readFileSync(deployKeyPath(home), 'utf8');
  const second = await ensureDeployKey(home, directRunner);
  assert.equal(second.created, false);
  assert.equal(second.publicLine, first.publicLine);
  assert.equal(readFileSync(deployKeyPath(home), 'utf8'), privateBefore);
});

test('deploy-key rebuilds a missing public file from the private key and leaves the private key alone', async () => {
  const home = tempRoot();
  const first = await ensureDeployKey(home, directRunner);
  const privateBefore = readFileSync(deployKeyPath(home), 'utf8');
  writeFileSync(`${deployKeyPath(home)}.pub`, '');
  const again = await ensureDeployKey(home, directRunner);
  assert.equal(again.created, false);
  assert.equal(again.publicLine.split(' ').slice(0, 2).join(' '), first.publicLine.split(' ').slice(0, 2).join(' '));
  assert.equal(readFileSync(deployKeyPath(home), 'utf8'), privateBefore);
});
