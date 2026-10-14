import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ImportConfig } from '../src/config.ts';
import { ImportError, parseManifest, remoteAllowed, runImport, type ImportDeps } from '../src/importer.ts';
import { FAKE_CORE } from './helpers.ts';
import { directRunner, git, gitRead, makeBundle, tempRoot } from './import-helpers.ts';

const MAIN = join(import.meta.dirname, '../src/main.ts');

interface Env {
  cfg: ImportConfig;
  deps: ImportDeps;
  root: string;
  importLog: string;
  calls: string[];
  imports: () => string[][];
}

function environment(extraEnv: Record<string, string> = {}): Env {
  const root = tempRoot();
  const importLog = join(root, 'core-import.jsonl');
  const cfg: ImportConfig = {
    user: 'coxia',
    home: join(root, 'home'),
    dataDir: join(root, 'data'),
    stateDir: join(root, 'state'),
    masterKeyFile: join(root, 'master.key'),
    entry: FAKE_CORE,
    reposDir: join(root, 'repos'),
    tmpDir: join(root, 'import-tmp'),
    service: 'coxia.service',
    allowLocalRemotes: true,
  };
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.home, { recursive: true });
  const calls: string[] = [];
  const deps: ImportDeps = {
    asService: (command, args, env = {}) => directRunner(command, args, { FAKE_CORE_IMPORT_LOG: importLog, ...extraEnv, ...env }),
    own: async () => {},
    stop: async () => void calls.push('stop'),
    restart: async () => void calls.push('restart'),
    healthy: async (id) => (calls.push(`healthy:${id}`), true),
    log: () => {},
  };
  const imports = () => (existsSync(importLog) ? readFileSync(importLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []);
  return { cfg, deps, root, importLog, calls, imports };
}

test('an imported folder bundle: clone, run branch, identity, the core called with the right arguments, the JSON result', async () => {
  const fx = makeBundle();
  const e = environment();
  const result = await runImport(e.cfg, e.deps, fx.bundle);
  const clone = join(e.cfg.reposDir, 'principal', 'app');
  assert.deepEqual(result, { imported: 'principal', repos: [{ id: 'app', path: clone }], health: 'ok' });
  assert.equal(readFileSync(join(clone, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(gitRead(clone, 'config', 'user.name'), 'Example Person');
  assert.equal(gitRead(clone, 'config', 'user.email'), 'person@example.com');
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(clone, 'show', 'cycle/123-some-title:work.txt'), 'work in progress');
  const [args, ...more] = e.imports();
  assert.equal(more.length, 0);
  assert.equal(args![0], '--import');
  assert.match(args![1]!, /import-[^/]+\/bundle$/);
  assert.deepEqual(args!.slice(2), ['--data-dir', e.cfg.dataDir, '--master-key-file', e.cfg.masterKeyFile, '--repos-root', join(e.cfg.reposDir, 'principal')]);
  assert.deepEqual(e.calls, ['stop', 'restart', 'healthy:principal']);
  assert.match(readFileSync(join(e.cfg.dataDir, 'workspaces.json'), 'utf8'), /"principal"/);
  assert.deepEqual(readdirSync(e.cfg.tmpDir), [], 'the temp folder is removed');
});

test('a tar.gz bundle imports the same way', async () => {
  const fx = makeBundle();
  const tarball = join(fx.root, 'bundle.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', fx.bundle, '.']);
  const e = environment();
  const result = await runImport(e.cfg, e.deps, tarball);
  assert.equal(result.imported, 'principal');
  assert.equal(git(join(e.cfg.reposDir, 'principal', 'app'), 'show', 'cycle/123-some-title:work.txt'), 'work in progress');
  assert.equal(e.imports().length, 1);
});

test('a failed clone: ImportError naming the repository, the core never called, nothing restarted', async () => {
  const fx = makeBundle({ remoteUrl: '/nonexistent/remote.git' });
  const e = environment();
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), (err: Error) => err instanceof ImportError && /cannot clone repository "app"/.test(err.message));
  assert.deepEqual(e.imports(), []);
  assert.deepEqual(e.calls, []);
  assert.equal(existsSync(join(e.cfg.dataDir, 'workspaces.json')), false);
  assert.deepEqual(readdirSync(e.cfg.tmpDir), []);
});

test('a repository without a remote is refused before anything is registered', async () => {
  const fx = makeBundle({ remoteUrl: null });
  const e = environment();
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /repository "app" has no remote URL/);
  assert.deepEqual(e.imports(), []);
});

test('a second run is idempotent: the clone is kept, the core is asked again and answers alreadyImported', async () => {
  const fx = makeBundle();
  const e = environment();
  await runImport(e.cfg, e.deps, fx.bundle);
  const clone = join(e.cfg.reposDir, 'principal', 'app');
  const head = git(clone, 'rev-parse', 'HEAD');
  const again = await runImport(e.cfg, e.deps, fx.bundle);
  assert.equal(again.imported, 'principal');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(clone, 'show', 'cycle/123-some-title:work.txt'), 'work in progress');
  assert.equal(e.imports().length, 2);
  assert.equal(JSON.parse(readFileSync(join(e.cfg.dataDir, 'workspaces.json'), 'utf8')).list.length, 1);
});

test('an existing folder that is a clone of another remote is not touched', async () => {
  const fx = makeBundle();
  const e = environment();
  const clone = join(e.cfg.reposDir, 'principal', 'app');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'remote', 'add', 'origin', 'https://example.com/other/project.git');
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /clone of another remote/);
  assert.deepEqual(e.imports(), []);
});

test('the core refusing the import is an error, the clones this run made are removed and the service is started again', async () => {
  const fx = makeBundle();
  const e = environment({ FAKE_CORE_IMPORT_FAIL: '1' });
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /the core refused the import: conflict:/);
  assert.deepEqual(e.calls, ['stop', 'restart']);
  assert.equal(existsSync(join(e.cfg.reposDir, 'principal')), false, 'no clone left behind');
  assert.deepEqual(readdirSync(e.cfg.tmpDir), []);
});

test('a core that does not come up healthy after the restart is an error', async () => {
  const fx = makeBundle();
  const e = environment();
  e.deps.healthy = async () => false;
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /imported but its core is not healthy/);
});

test('a tar with a ".." entry or an absolute path is refused before anything is extracted', async () => {
  for (const [name, why] of [['../escape.txt', /"\.\." segment/], ['/abs/escape.txt', /absolute path/]] as const) {
    const fx = makeBundle();
    const e = environment();
    const tarball = join(fx.root, 'bad.tar.gz');
    execFileSync('tar', ['czf', tarball, '-C', fx.bundle, '--transform', `s,^\\./manifest.json$,${name},`, '--absolute-names', '.']);
    await assert.rejects(runImport(e.cfg, e.deps, tarball), (err: Error) => err instanceof ImportError && why.test(err.message), name);
    assert.deepEqual(e.imports(), []);
    assert.equal(existsSync(join(fx.root, 'escape.txt')), false);
  }
});

test('a tar with a symlink and a folder with a symlink are refused', async () => {
  const fx = makeBundle();
  symlinkSync('/etc/passwd', join(fx.bundle, 'workspace', 'link'));
  const e = environment();
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /not a plain file or folder/);
  const tarball = join(fx.root, 'link.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', fx.bundle, '.']);
  await assert.rejects(runImport(e.cfg, e.deps, tarball), /not a plain file or folder/);
  assert.deepEqual(e.imports(), []);
});

test('the manifest: format 1 only, safe ids, safe branch names', () => {
  const ok = { format: 1, workspace: { id: 'principal' }, repos: [{ id: 'app', remoteUrl: 'git@example.com:group/project.git', gitName: null, gitEmail: null, runBranches: ['cycle/1-x'] }] };
  assert.equal(parseManifest(JSON.stringify(ok)).repos[0]!.id, 'app');
  const bad = (m: unknown, re: RegExp) => assert.throws(() => parseManifest(JSON.stringify(m)), re);
  bad({ ...ok, format: 2 }, /format/);
  bad({ ...ok, workspace: { id: '../x' } }, /workspace id/);
  bad({ ...ok, workspace: { id: 'Up' } }, /workspace id/);
  bad({ ...ok, repos: [{ ...ok.repos[0], id: '../app' }] }, /repository id/);
  bad({ ...ok, repos: [{ ...ok.repos[0], id: 'a/b' }] }, /repository id/);
  bad({ ...ok, repos: [ok.repos[0], ok.repos[0]] }, /twice/);
  bad({ ...ok, repos: [{ ...ok.repos[0], runBranches: ['a/../b'] }] }, /run branch/);
  bad({ ...ok, repos: [{ ...ok.repos[0], runBranches: ['--upload-pack=x'] }] }, /run branch/);
  bad({ ...ok, repos: [{ ...ok.repos[0], gitName: 'a\nb' }] }, /identity/);
  assert.throws(() => parseManifest('nope'), /not JSON/);
});

test('remotes: ssh, https, git and the scp form; never an option, ext:: or (outside tests) a local path', () => {
  for (const u of ['git@example.com:group/project.git', 'ssh://git@example.com/group/project.git', 'https://example.com/group/project.git', 'git://example.com/g/p.git']) assert.equal(remoteAllowed(u, false), true, u);
  for (const u of ['--upload-pack=touch /x', 'ext::sh -c id', '/srv/repo.git', 'file:///srv/repo.git', 'https://example.com/a b', '']) assert.equal(remoteAllowed(u, false), false, u);
  assert.equal(remoteAllowed('/srv/repo.git', true), true);
});

test('a missing deploy key is explained for an ssh remote', async () => {
  const fx = makeBundle({ remoteUrl: 'git@example.com:group/project.git' });
  const e = environment();
  await assert.rejects(runImport(e.cfg, e.deps, fx.bundle), /no deploy key yet; run "sudo coxia-server deploy-key"/);
  assert.deepEqual(e.imports(), []);
});

test('status lists the imported workspace from the registry the core wrote', async () => {
  const fx = makeBundle();
  const e = environment();
  await runImport(e.cfg, e.deps, fx.bundle);
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: e.cfg.dataDir, COXIA_STATE_DIR: e.cfg.stateDir };
  // Exit 1 is expected: no supervisor runs here. The row is what matters.
  const out = await promisify(execFile)(process.execPath, [MAIN, 'status'], { env }).catch((x: { stdout: string }) => x);
  assert.match(out.stdout, /^principal\s/m);
});

test('the import command: usage error without a bundle; refused without root', async () => {
  const env = { PATH: process.env.PATH, COXIA_DATA_DIR: '/nonexistent/data', COXIA_STATE_DIR: '/nonexistent/state' };
  const run = promisify(execFile);
  const usage = await run(process.execPath, [MAIN, 'import'], { env }).catch((x: { code: number; stderr: string }) => x);
  assert.equal((usage as { code: number }).code, 1);
  assert.match((usage as { stderr: string }).stderr, /usage: coxia-server import/);
  if (process.getuid?.() === 0) return;
  const refused = await run(process.execPath, [MAIN, 'import', '/x'], { env }).catch((x: { code: number; stderr: string }) => x);
  assert.match((refused as { stderr: string }).stderr, /import needs root/);
});

test('a refusal keeps a clone that was already there before the run', async () => {
  const fx = makeBundle();
  const first = environment();
  await runImport(first.cfg, first.deps, fx.bundle);
  const again = environment({ FAKE_CORE_IMPORT_FAIL: '1' });
  again.cfg.reposDir = first.cfg.reposDir;
  await assert.rejects(runImport(again.cfg, again.deps, fx.bundle), /the core refused/);
  assert.equal(existsSync(join(first.cfg.reposDir, 'principal', 'app', 'README.md')), true);
});

test('the service is stopped before the core places the workspace', async () => {
  const fx = makeBundle();
  const e = environment();
  const order: string[] = [];
  const asService = e.deps.asService;
  e.deps.asService = (command, args, env) => (args.includes('--import') && order.push('core-import'), asService(command, args, env));
  e.deps.stop = async () => void order.push('stop');
  e.deps.restart = async () => void order.push('restart');
  await runImport(e.cfg, e.deps, fx.bundle);
  assert.deepEqual(order, ['stop', 'core-import', 'restart']);
});

test('a tar.gz with one wrapper folder imports; manifest.json nowhere is a clear ImportError', async () => {
  const fx = makeBundle();
  const wrapped = join(fx.root, 'wrapped');
  mkdirSync(wrapped);
  execFileSync('cp', ['-r', fx.bundle, join(wrapped, 'bundle')]);
  const tarball = join(fx.root, 'wrapped.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', wrapped, 'bundle']);
  const e = environment();
  assert.equal((await runImport(e.cfg, e.deps, tarball)).imported, 'principal');

  const empty = join(fx.root, 'empty');
  mkdirSync(join(empty, 'a'), { recursive: true });
  mkdirSync(join(empty, 'b'));
  writeFileSync(join(empty, 'a', 'x.txt'), 'x');
  const bad = join(fx.root, 'bad.tar.gz');
  execFileSync('tar', ['czf', bad, '-C', empty, 'a', 'b']);
  const f = environment();
  await assert.rejects(runImport(f.cfg, f.deps, bad), (err: Error) => err instanceof ImportError && /no manifest\.json at its root.*tar -C <bundle> -czf bundle\.tar\.gz \./.test(err.message));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readdirSync(f.cfg.tmpDir), []);
});
