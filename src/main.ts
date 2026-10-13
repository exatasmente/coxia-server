import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, LOOPBACK, loadConfig, loadStatusConfig } from './config.ts';
import { AdminError, adminCall, adminSocketPath, fetchHealth, readWorkspaceIds } from './core.ts';
import { loadPorts } from './ports.ts';
import { PORTS_FILE, STATE_FILE, Supervisor, type SupervisorState } from './supervisor.ts';

const USAGE = `usage: coxia-server <command>

  run      supervise one Coxia core per workspace (what the systemd unit runs)
  status   print the workspaces, their ports, pids and /healthz; exit 1 when something is down
  pair [workspace]
           ask a workspace's core for a pairing code, to pair a phone or a browser through the SSH tunnel
  call <workspace> <channel> [json-args]
           call one channel of a workspace's core as its admin and print the answer as JSON

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
  return bad ? 1 : 0;
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

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'run';
  if (command === 'run') {
    run();
    return -1; // stays alive until a signal
  }
  if (command === 'status') return status();
  if (command === 'pair') return pair(process.argv[3]);
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
    else console.error(e instanceof ConfigError ? `coxia-server: ${e.message}` : e);
    process.exit(1);
  },
);
