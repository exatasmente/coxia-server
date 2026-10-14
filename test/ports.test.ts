import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assignPorts, loadPorts, savePorts } from '../src/ports.ts';

test('new workspaces take the lowest free ports from the base, in registry order', () => {
  assert.deepEqual(assignPorts({}, ['a', 'b', 'c'], 9000), { a: 9000, b: 9001, c: 9002 });
});

test('a workspace keeps its port when others come and go', () => {
  const saved = { a: 9000, b: 9001, c: 9002 };
  assert.deepEqual(assignPorts(saved, ['c', 'a'], 9000), { c: 9002, a: 9000 });
});

test('the port of a removed workspace is released; one that still exists is never reused', () => {
  const saved = { a: 9000, b: 9001 };
  assert.deepEqual(assignPorts(saved, ['a', 'n'], 9000), { a: 9000, n: 9001 });
  assert.deepEqual(assignPorts({ a: 9000, b: 9001 }, ['a', 'b', 'n'], 9000), { a: 9000, b: 9001, n: 9002 });
});

test('a reserved port (a process still shutting down) is skipped', () => {
  assert.deepEqual(assignPorts({}, ['n'], 9000, [9000, 9001]), { n: 9002 });
});

test('saved ports survive a round trip; a damaged file reads as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coxia-server-ports-'));
  const file = join(dir, 'ports.json');
  savePorts(file, { a: 9000 });
  assert.deepEqual(loadPorts(file), { a: 9000 });
  writeFileSync(file, '{not json');
  assert.deepEqual(loadPorts(file), {});
  assert.deepEqual(loadPorts(join(dir, 'missing.json')), {});
});
