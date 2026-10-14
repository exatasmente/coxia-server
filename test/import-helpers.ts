import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AsService } from '../src/service-user.ts';

const exec = promisify(execFile);

/** Runs the command as the current user, with the extra environment: the unprivileged stand-in for `runuser -u coxia`. */
export const directRunner: AsService = async (command, args, env = {}) => {
  const { stdout, stderr } = await exec(command, args, { env: { ...process.env, ...env } });
  return { stdout, stderr };
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Reads from a repository without any identity override. */
export const gitRead = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'coxia-import-test-'));
}

export interface Fixture {
  root: string;
  /** The bundle folder, ready for `import`. */
  bundle: string;
  /** A local bare repository standing in for the code host. */
  remote: string;
}

/** A bundle folder shaped as the contract says, with one repository whose remote is a local bare repository and one run branch in a git bundle. */
export function makeBundle(opts: { remoteUrl?: string | null; workspace?: string; repoId?: string } = {}): Fixture {
  const root = tempRoot();
  const workspace = opts.workspace ?? 'principal';
  const repoId = opts.repoId ?? 'app';
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'first');
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  // The run branch exists only locally on the old machine: it travels in the git bundle.
  git(seed, 'checkout', '-q', '-b', 'cycle/123-some-title');
  writeFileSync(join(seed, 'work.txt'), 'work in progress\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'work');
  const bundle = join(root, 'bundle');
  mkdirSync(join(bundle, 'git'), { recursive: true });
  mkdirSync(join(bundle, 'workspace'));
  writeFileSync(join(bundle, 'workspace', 'workspace.json'), '{}');
  writeFileSync(join(bundle, 'registry.json'), JSON.stringify({ id: workspace, name: 'Principal', createdAt: '2026-01-01T00:00:00.000Z', test: false }));
  writeFileSync(join(bundle, 'secrets.json'), JSON.stringify({ version: 1, entries: {} }));
  git(seed, 'bundle', 'create', join(bundle, 'git', `${repoId}.bundle`), 'refs/heads/cycle/123-some-title');
  const manifest = {
    format: 1,
    coxiaVersion: '0.11.0',
    contractVersion: 0,
    exportedAt: '2026-10-14T12:00:00.000Z',
    workspace: { id: workspace, name: 'Principal' },
    repos: [{ id: repoId, remoteUrl: opts.remoteUrl === undefined ? remote : opts.remoteUrl, gitName: 'Example Person', gitEmail: 'person@example.com', runBranches: ['cycle/123-some-title'] }],
    secrets: { moved: [], notMoved: [] },
    files: 3,
    bytes: 10,
  };
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, bundle, remote };
}
