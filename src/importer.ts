// Importing a workspace moved from another machine: unpack the bundle, clone its repositories as the service user, bring the run branches over, set the
// git identity, let the core place the workspace, restart, wait for health. Everything that touches the machine comes in through ImportDeps, so the
// tests run the whole flow unprivileged against a local bare repository and a fake core.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ImportConfig } from './config.ts';
import { WORKSPACE_ID } from './core.ts';
import { deployKeyPath } from './deploykey.ts';
import { failureText, type AsService } from './service-user.ts';
import { acquireLock } from './updater.ts';

const exec = promisify(execFile);

export class ImportError extends Error {}

export interface ImportDeps {
  asService: AsService;
  /** Hands a folder (and what is in it) to the service user. */
  own: (path: string) => Promise<void>;
  /** Stops the service: a running core holds the workspace folder the import is about to replace. */
  stop: () => Promise<void>;
  /** Starts the service again (a restart when it is running). */
  restart: () => Promise<void>;
  /** Resolves true when the workspace's core answers /healthz again, false when it does not within the time given. */
  healthy: (workspace: string) => Promise<boolean>;
  log: (line: string) => void;
}

export interface RepoEntry {
  id: string;
  remoteUrl: string | null;
  gitName: string | null;
  gitEmail: string | null;
  runBranches: string[];
}

export interface Manifest {
  format: 1;
  workspace: { id: string; name?: string };
  repos: RepoEntry[];
}

export interface ImportResult {
  imported: string;
  repos: { id: string; path: string }[];
  health: 'ok';
}

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

// --- unpacking ---------------------------------------------------------------------------------------------------------------------

function unsafeEntry(name: string): string | null {
  if (name.startsWith('/')) return 'an absolute path';
  if (name.includes('\\')) return 'a backslash';
  if (name.split('/').includes('..')) return 'a ".." segment';
  return null;
}

/** Lists the archive first and refuses it whole when any entry could land outside the folder or is anything but a file or a folder. */
async function checkArchive(archive: string): Promise<void> {
  const names = (await exec('tar', ['--quoting-style=escape', '--absolute-names', '-tzf', archive], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
  const verbose = (await exec('tar', ['--quoting-style=escape', '--absolute-names', '-tvzf', archive], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
  if (names.length !== verbose.length) throw new ImportError('the archive listing is ambiguous; refusing it');
  for (const [i, name] of names.entries()) {
    const why = unsafeEntry(name);
    if (why) throw new ImportError(`the archive has an entry with ${why} (${name}); refusing it`);
    const type = verbose[i]![0];
    if (type !== '-' && type !== 'd') throw new ImportError(`the archive has an entry that is not a plain file or folder (${name}); refusing it`);
  }
}

function checkFolder(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const st = lstatSync(path);
    if (st.isDirectory()) checkFolder(path);
    else if (!st.isFile()) throw new ImportError(`the bundle folder has an entry that is not a plain file or folder (${path}); refusing it`);
  }
}

/** The bundle as a folder under `tmp`, owned by the service user. */
async function unpack(source: string, tmp: string, deps: ImportDeps): Promise<string> {
  const target = join(tmp, 'bundle');
  mkdirSync(target, { mode: 0o700 });
  if (lstatSync(source).isDirectory()) {
    checkFolder(source);
    cpSync(source, target, { recursive: true });
  } else {
    await checkArchive(source);
    // The listing check is the guard; these options are the second one (nothing owned by or permitted for whoever packed it, no overwriting links).
    await exec('tar', ['-xzf', source, '-C', target, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir']);
  }
  await deps.own(tmp);
  return archiveRoot(target, source);
}

/** A bundle packed from its parent folder has everything under one top-level folder; that one folder is accepted. Anything else without manifest.json at the root is explained. */
function archiveRoot(target: string, source: string): string {
  if (existsSync(join(target, 'manifest.json'))) return target;
  const top = readdirSync(target, { withFileTypes: true });
  if (top.length === 1 && top[0]!.isDirectory() && existsSync(join(target, top[0]!.name, 'manifest.json'))) return join(target, top[0]!.name);
  throw new ImportError(`${source} has no manifest.json at its root: pack the bundle from inside its folder (tar -C <bundle> -czf bundle.tar.gz .)`);
}

// --- the manifest ------------------------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableText = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= 200 && NO_CONTROL.test(v));

export function parseManifest(raw: string): Manifest {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new ImportError('manifest.json is not JSON');
  }
  if (!isObject(m)) throw new ImportError('manifest.json is not an object');
  if (m.format !== 1) throw new ImportError(`the bundle format is ${String(m.format)}; this server reads format 1`);
  const ws = m.workspace;
  if (!isObject(ws) || typeof ws.id !== 'string' || !WORKSPACE_ID.test(ws.id)) throw new ImportError('manifest.json: the workspace id is not valid');
  if (!Array.isArray(m.repos)) throw new ImportError('manifest.json: repos is not a list');
  const repos: RepoEntry[] = [];
  for (const r of m.repos) {
    if (!isObject(r) || typeof r.id !== 'string' || !REPO_ID.test(r.id)) throw new ImportError('manifest.json: a repository id is not valid');
    if (repos.some((x) => x.id === r.id)) throw new ImportError(`manifest.json: the repository id "${r.id}" appears twice`);
    const branches = r.runBranches ?? [];
    if (!Array.isArray(branches) || !branches.every((b) => typeof b === 'string' && BRANCH.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock'))) {
      throw new ImportError(`manifest.json: a run branch of "${r.id}" is not valid`);
    }
    const gitName = r.gitName ?? null;
    const gitEmail = r.gitEmail ?? null;
    if (!nullableText(gitName) || !nullableText(gitEmail)) throw new ImportError(`manifest.json: the git identity of "${r.id}" is not valid`);
    const remoteUrl = r.remoteUrl ?? null;
    if (remoteUrl !== null && typeof remoteUrl !== 'string') throw new ImportError(`manifest.json: the remote of "${r.id}" is not text`);
    repos.push({ id: r.id, remoteUrl, gitName, gitEmail, runBranches: branches as string[] });
  }
  return { format: 1, workspace: { id: ws.id }, repos };
}

/** ssh, https and git remotes, and the scp form; a local path or file:// only when the configuration allows it (tests). Never an option, never `ext::`. */
export function remoteAllowed(url: string, allowLocal: boolean): boolean {
  if (!NO_CONTROL.test(url) || /\s/.test(url) || url.startsWith('-') || url.length > 500) return false;
  if (/^(ssh|https|git):\/\/[^/@\s]*@?[^/\s]+\/\S+$/.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/.test(url)) return true;
  return allowLocal && (url.startsWith('/') || url.startsWith('file://'));
}

/** Credentials inside a URL never go into a message. */
const redact = (text: string): string => text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');

// --- the repositories --------------------------------------------------------------------------------------------------------------

// The service steps run under umask 027 so that an ambient umask 0000 cannot leave the repositories root or a clone writable by everyone.
const PRIVATE = ['-c', 'umask 027 && exec "$@"', 'sh'];
const privately = (deps: ImportDeps, env: Record<string, string> | undefined, command: string, args: string[]) => deps.asService('sh', [...PRIVATE, command, ...args], env);

const sameRemote = (a: string, b: string): boolean => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

async function ensureClone(cfg: ImportConfig, deps: ImportDeps, repo: RepoEntry, path: string, env: Record<string, string>): Promise<boolean> {
  const url = repo.remoteUrl;
  if (url === null) throw new ImportError(`repository "${repo.id}" has no remote URL, so it cannot be cloned`);
  if (!remoteAllowed(url, cfg.allowLocalRemotes)) throw new ImportError(`repository "${repo.id}": the remote is not one this server clones from (ssh, https or git)`);
  if (existsSync(path) && readdirSync(path).length > 0) {
    let current: string;
    try {
      current = (await deps.asService('git', ['-C', path, 'remote', 'get-url', 'origin'], env)).stdout;
    } catch {
      throw new ImportError(`repository "${repo.id}": ${path} exists and is not a clone`);
    }
    if (!sameRemote(current, url)) throw new ImportError(`repository "${repo.id}": ${path} is a clone of another remote (${redact(current.trim())}); not touching it`);
    deps.log(`${repo.id}: already cloned, kept`);
    return false;
  }
  if (/^[A-Za-z0-9._-]+@/.test(url) || url.startsWith('ssh://')) {
    if (!existsSync(deployKeyPath(cfg.home))) throw new ImportError(`repository "${repo.id}": there is no deploy key yet; run "sudo coxia-server deploy-key" and add its public line to the repository`);
  }
  deps.log(`${repo.id}: cloning`);
  try {
    await privately(deps, env, 'git', ['clone', '--quiet', '--', url, path]);
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw new ImportError(`cannot clone repository "${repo.id}" (${redact(url)}): ${redact(failureText(e))}`);
  }
  return true;
}

async function bringBranches(deps: ImportDeps, repo: RepoEntry, path: string, bundleDir: string, env: Record<string, string>): Promise<void> {
  if (repo.runBranches.length === 0) return;
  const file = join(bundleDir, 'git', `${repo.id}.bundle`);
  if (!existsSync(file)) throw new ImportError(`repository "${repo.id}": the manifest lists run branches but git/${repo.id}.bundle is missing`);
  // The checked-out branch is never a fetch target: git would refuse it, and moving it would change the working tree's base.
  const current = (await deps.asService('git', ['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], env).catch(() => ({ stdout: '' }))).stdout.trim();
  const wanted = repo.runBranches.filter((b) => b !== current);
  if (wanted.length === 0) return;
  try {
    await privately(deps, env, 'git', ['-C', path, 'fetch', '--quiet', file, ...wanted.map((b) => `refs/heads/${b}:refs/heads/${b}`)]);
  } catch (e) {
    throw new ImportError(`repository "${repo.id}": cannot bring the run branches over: ${redact(failureText(e))}`);
  }
}

// --- the flow ----------------------------------------------------------------------------------------------------------------------

export async function runImport(cfg: ImportConfig, deps: ImportDeps, source: string): Promise<ImportResult> {
  if (!existsSync(source)) throw new ImportError(`${source} does not exist`);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(cfg.stateDir);
  mkdirSync(cfg.tmpDir, { recursive: true, mode: 0o700 });
  // The folder must be the service user's to walk into; root unpacks into it and hands the result over.
  await deps.own(cfg.tmpDir);
  const tmp = mkdtempSync(join(cfg.tmpDir, 'import-'));
  try {
    const bundleDir = await unpack(source, tmp, deps);
    if (!existsSync(join(bundleDir, 'manifest.json'))) throw new ImportError(`${source} has no manifest.json at its root: the bundle folder is what is imported (the one move:export wrote)`);
    const manifest = parseManifest(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
    for (const part of ['workspace', 'registry.json', 'secrets.json']) {
      if (!existsSync(join(bundleDir, part))) throw new ImportError(`the bundle has no ${part}`);
    }
    const id = manifest.workspace.id;
    const reposRoot = join(cfg.reposDir, id);
    const rootExisted = existsSync(reposRoot);
    await privately(deps, undefined, 'mkdir', ['-p', reposRoot]);
    const created: string[] = [];
    const gitEnv: Record<string, string> = {
      GIT_SSH_COMMAND: `ssh -i ${deployKeyPath(cfg.home)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: cfg.allowLocalRemotes ? 'ssh:https:git:file' : 'ssh:https:git',
    };
    // Every clone before anything is registered: one that fails stops here and the core never hears of the workspace.
    // A refusal later on leaves no clone this run made behind.
    const cleanUp = (): void => {
      for (const path of created) rmSync(path, { recursive: true, force: true });
      if (!rootExisted && existsSync(reposRoot) && readdirSync(reposRoot).length === 0) rmSync(reposRoot, { recursive: true, force: true });
    };
    try {
      for (const repo of manifest.repos) {
        const path = join(reposRoot, repo.id);
        if (await ensureClone(cfg, deps, repo, path, gitEnv)) created.push(path);
        await bringBranches(deps, repo, path, bundleDir, gitEnv);
        if (repo.gitName !== null) await deps.asService('git', ['-C', path, 'config', 'user.name', repo.gitName], gitEnv);
        if (repo.gitEmail !== null) await deps.asService('git', ['-C', path, 'config', 'user.email', repo.gitEmail], gitEnv);
      }
    } catch (e) {
      cleanUp();
      throw e;
    }

    deps.log('placing the workspace');
    // The service is stopped while the core places the workspace: a running core holds the folder of the empty workspace a fresh install made.
    deps.log('stopping the service');
    await deps.stop();
    let answer: string;
    try {
      answer = (await deps.asService(process.execPath, [cfg.entry, '--import', bundleDir, '--data-dir', cfg.dataDir, '--master-key-file', cfg.masterKeyFile, '--repos-root', reposRoot])).stdout;
    } catch (e) {
      cleanUp();
      deps.log('the import was refused, starting the service again');
      await deps.restart().catch(() => {});
      throw new ImportError(`the core refused the import: ${redact(failureText(e))}`);
    }
    let repos = manifest.repos.map((r) => ({ id: r.id, path: join(reposRoot, r.id) }));
    try {
      const line = answer.trim().split('\n').filter(Boolean).at(-1) ?? '';
      const parsed = JSON.parse(line) as { imported?: unknown; repos?: unknown };
      if (parsed.imported !== id) throw new Error('wrong workspace');
      if (Array.isArray(parsed.repos)) repos = parsed.repos as typeof repos;
    } catch {
      await deps.restart().catch(() => {});
      throw new ImportError('the core did not answer the import with its JSON line');
    }

    deps.log('starting the service');
    await deps.restart();
    if (!(await deps.healthy(id))) throw new ImportError(`the workspace ${id} was imported but its core is not healthy after the restart (journalctl -u ${cfg.service.replace(/\.service$/, '')})`);
    return { imported: id, repos, health: 'ok' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    unlock();
  }
}
