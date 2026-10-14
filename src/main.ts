import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, LOOPBACK, loadConfig, loadImportConfig, loadServiceUserConfig, loadStatusConfig, loadUpdateConfig } from './config.ts';
import { AdminError, adminCall, adminSocketPath, fetchHealth, readWorkspaceIds } from './core.ts';
import { readUpdates } from './audit.ts';
import { ensureDeployKey } from './deploykey.ts';
import { ImportError, runImport } from './importer.ts';
import { runAsService } from './service-user.ts';
import { loadPorts } from './ports.ts';
import { activeVersion } from './releases.ts';
import { listFailedData, listSnapshots } from './snapshots.ts';
import { importDeps, systemDeps } from './system.ts';
import { runRollback, runUpdate, UpdateError, type UpdateResult } from './updater.ts';
import { PORTS_FILE, STATE_FILE, Supervisor, type SupervisorState } from './supervisor.ts';

const USAGE = `usage: coxia-server <command>

  run      supervise one Coxia core per workspace (what the systemd unit runs)
  status   print the workspaces, their ports, pids and /healthz; exit 1 when something is down
  pair [workspace]
           ask a workspace's core for a pairing code, to pair a phone or a browser through the SSH tunnel
  call <workspace> <channel> [json-args]
           call one channel of a workspace's core as its admin and print the answer as JSON

  update [--check|--now]
           (root) follow the update channel: build the newest version, snapshot the data, switch, watch it, roll back if it fails.
           --check only says what is available and whether now is a safe point; --now updates even with the channel off
  rollback (root) go back to the previous version together with the snapshot taken before the update
  import <bundle.tar.gz|folder>
           (root) take in a workspace moved from another machine: clone its repositories, set the git identity, place the workspace, restart.
           Prints one JSON line on success; exit 1 and nothing registered when a clone fails
  deploy-key
           (root) create the service user's SSH key once, never replacing it, and print its public line for the code host

The workspace defaults to the only one, or must be named when there are several.

Configuration comes from the environment (see deploy/coxia.env.example).`;

function run(): void {
  const config = loadConfig(process.env);
  const supervisor = new Supervisor(config);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[supervisor] ${signal} received`);
    supervisor.stop().then(
      () => process.exit(0),
      (e) => {
        console.error(`[supervisor] ${(e as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log(`[supervisor] data ${config.dataDir}, state ${config.stateDir}, cores on ${LOOPBACK} from port ${config.basePort}`);
  supervisor.start();
}

function readState(stateDir: string): SupervisorState | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')) as SupervisorState;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but is another user's
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function status(): Promise<number> {
  const config = loadStatusConfig(process.env);
  const state = readState(config.stateDir);
  const up = state !== null && alive(state.pid);
  const ids = readWorkspaceIds(config.dataDir);
  const ports = loadPorts(join(config.stateDir, PORTS_FILE));
  console.log(up ? `supervisor: running, pid ${state.pid}, since ${state.startedAt}` : 'supervisor: not running');
  if (ids === null) {
    console.log(`registry: cannot read ${join(config.dataDir, 'workspaces.json')}`);
    return 1;
  }
  let bad = !up;
  const rows: string[][] = [['WORKSPACE', 'PORT', 'PID', 'STATE', 'RESTARTS', 'HEALTH']];
  for (const id of ids) {
    const port = ports[id];
    const row = state?.workspaces.find((w) => w.id === id);
    const health = port === undefined ? null : await fetchHealth(LOOPBACK, port);
    if (!health) bad = true;
    rows.push([
      id,
      String(port ?? '-'),
      String(up ? (row?.pid ?? '-') : '-'),
      up ? (row?.state ?? 'not started') : '-',
      String(row?.restarts ?? '-'),
      health ? `ok (v${health.version ?? '?'})` : 'down',
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
  printUpdates();
  return bad ? 1 : 0;
}

// The updates part of `status`: what version runs, what the updater last did, what it keeps. Skipped when the environment has no COXIA_DIR (a bare run).
function printUpdates(): void {
  let cfg;
  try {
    cfg = loadUpdateConfig(process.env);
  } catch {
    return;
  }
  const records = readUpdates(cfg.stateDir);
  const last = (...events: string[]) => [...records].reverse().find((r) => events.includes(r.event));
  console.log('');
  console.log(`version: ${activeVersion(cfg.appLink) ?? 'unknown (the app folder is not a link to a release)'}, update channel: ${cfg.channel}`);
  const update = last('update', 'update-failed', 'update-postponed');
  console.log(update ? `last update: ${update.event} ${update.from} -> ${update.to} at ${update.at}${update.reason ? ` (${update.reason})` : ''}` : 'last update: none');
  const rollback = last('rollback', 'rollback-failed');
  if (rollback) console.log(`LAST ROLLBACK: ${rollback.event} ${rollback.from} -> ${rollback.to} at ${rollback.at}${rollback.keptData ? `, data kept in ${rollback.keptData}` : ''}`);
  const snaps = listSnapshots(cfg.snapshotsDir);
  console.log(`snapshots: ${snaps.length ? snaps.map((x) => x.name).join(', ') : 'none'} in ${cfg.snapshotsDir}`);
  const failed = listFailedData(cfg.snapshotsDir);
  if (failed.length) console.log(`data set aside by rollbacks (yours to delete): ${failed.join(', ')}`);
}

const RESULT_TEXT = (r: UpdateResult): string => {
  switch (r.status) {
    case 'off':
      return 'updates are off (COXIA_UPDATE_CHANNEL=off); nothing to do';
    case 'up-to-date':
      return 'up to date';
    case 'available':
      return `${r.version} is available; ${r.busy.length ? `not a safe point now: ${r.busy.join('; ')}` : 'this is a safe point'}`;
    case 'postponed':
      return `update to ${r.version} postponed, not at a safe point: ${r.busy.join('; ')}`;
    case 'updated':
      return `updated ${r.from} -> ${r.to}, healthy; snapshot ${r.snapshot}`;
    case 'failed':
      return `update failed, nothing changed: ${r.reason}`;
    case 'rolled-back':
      return `ROLLED BACK ${r.from} -> ${r.to}: ${r.reason}; the data of ${r.from} is kept in ${r.keptData}`;
    case 'rollback-failed':
      return `ROLLBACK FAILED: ${r.reason}`;
  }
};

// 0 done or nothing to do (a postponement is normal), 1 the update could not be made, 3 it was made and rolled back, 2 the rollback itself failed: the unit shows failed.
const EXIT: Record<UpdateResult['status'], number> = { off: 0, 'up-to-date': 0, available: 0, postponed: 0, updated: 0, failed: 1, 'rolled-back': 3, 'rollback-failed': 2 };

async function updateCommand(flags: string[]): Promise<number> {
  const known = ['--check', '--now'];
  const bad = flags.find((f) => !known.includes(f));
  if (bad || (flags.includes('--check') && flags.includes('--now'))) throw new ConfigError('usage: coxia-server update [--check|--now]');
  if (process.getuid?.() !== 0 && !flags.includes('--check')) throw new ConfigError('update needs root (sudo coxia-server update)');
  const cfg = loadUpdateConfig(process.env);
  const result = await runUpdate(cfg, systemDeps(cfg), { trigger: flags.includes('--now') ? 'manual' : 'timer', check: flags.includes('--check'), force: flags.includes('--now') });
  console.log(RESULT_TEXT(result));
  return EXIT[result.status];
}

async function rollbackCommand(): Promise<number> {
  if (process.getuid?.() !== 0) throw new ConfigError('rollback needs root (sudo coxia-server rollback)');
  const cfg = loadUpdateConfig(process.env);
  const result = await runRollback(cfg, systemDeps(cfg));
  console.log(RESULT_TEXT(result));
  return EXIT[result.status];
}

function workspaceOf(dataDir: string, named: string | undefined): string {
  const ids = readWorkspaceIds(dataDir);
  if (ids === null) throw new ConfigError(`cannot read the workspace registry in ${dataDir}`);
  if (named) {
    if (!ids.includes(named)) throw new ConfigError(`no workspace "${named}" (there are: ${ids.join(', ') || 'none'})`);
    return named;
  }
  if (ids.length !== 1) throw new ConfigError(`name the workspace: ${ids.join(', ') || 'none'}`);
  return ids[0]!;
}

async function pair(named: string | undefined): Promise<number> {
  const config = loadStatusConfig(process.env);
  const workspace = workspaceOf(config.dataDir, named);
  const answer = (await adminCall(adminSocketPath(config.dataDir, workspace), 'web:pair')) as { code?: string; expiresAt?: number };
  const port = loadPorts(join(config.stateDir, PORTS_FILE))[workspace];
  // The page lives under the base path the core serves, which a client may change: ask the core, never assume it.
  const view = (await adminCall(adminSocketPath(config.dataDir, workspace), 'web:view').catch(() => null)) as { settings?: { basePath?: string } } | null;
  const basePath = view?.settings?.basePath ?? '/';
  console.log(`pairing code for ${workspace}: ${answer.code}`);
  if (answer.expiresAt) console.log(`valid until ${new Date(answer.expiresAt).toISOString()}, for one device`);
  if (port !== undefined) {
    console.log(`from your computer: ssh -N -L ${port}:${LOOPBACK}:${port} <user>@<server>`);
    console.log(`then open http://localhost:${port}${basePath} and type the code`);
  }
  return 0;
}

async function call(named: string | undefined, channel: string | undefined, rawArgs: string | undefined): Promise<number> {
  if (!named || !channel) throw new ConfigError('usage: coxia-server call <workspace> <channel> [json-args]');
  const config = loadStatusConfig(process.env);
  const workspace = workspaceOf(config.dataDir, named);
  let args: unknown[] = [];
  if (rawArgs !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      throw new ConfigError('the arguments must be JSON (an array, or one value)');
    }
    args = Array.isArray(parsed) ? parsed : [parsed];
  }
  const value = await adminCall(adminSocketPath(config.dataDir, workspace), channel, args);
  console.log(JSON.stringify(value ?? null, null, 2));
  return 0;
}

async function deployKeyCommand(): Promise<number> {
  if (process.getuid?.() !== 0) throw new ConfigError('deploy-key needs root (sudo coxia-server deploy-key)');
  const key = await ensureDeployKey(loadServiceUserConfig(process.env).home, runAsService(loadServiceUserConfig(process.env)));
  console.error(key.created ? `created ${key.path}; add this public key to the repositories the import will clone (read access is enough):` : `${key.path} already exists and was left as it is; its public key:`);
  console.log(key.publicLine);
  return 0;
}

async function importCommand(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith('-')) throw new ConfigError('usage: coxia-server import <bundle.tar.gz | bundle folder>');
  if (process.getuid?.() !== 0) throw new ConfigError('import needs root (sudo coxia-server import <bundle>)');
  const cfg = loadImportConfig(process.env);
  console.log(JSON.stringify(await runImport(cfg, importDeps(cfg), args[0]!)));
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'run';
  if (command === 'run') {
    run();
    return -1; // stays alive until a signal
  }
  if (command === 'status') return status();
  if (command === 'pair') return pair(process.argv[3]);
  if (command === 'update') return updateCommand(process.argv.slice(3));
  if (command === 'rollback') return rollbackCommand();
  if (command === 'import') return importCommand(process.argv.slice(3));
  if (command === 'deploy-key') return deployKeyCommand();
  if (command === 'call') return call(process.argv[3], process.argv[4], process.argv[5]);
  console.error(USAGE);
  return command === 'help' || command === '--help' ? 0 : 2;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    // A bad configuration is one line and exit 1, not a stack trace.
    if (e instanceof AdminError) console.error(`coxia-server: ${e.code}: ${e.message}`);
    else console.error(e instanceof ConfigError || e instanceof UpdateError || e instanceof ImportError ? `coxia-server: ${e.message}` : e);
    process.exit(1);
  },
);
