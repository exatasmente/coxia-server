import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, LOOPBACK, loadConfig, loadStatusConfig } from './config.ts';
import { fetchHealth, readWorkspaceIds } from './core.ts';
import { loadPorts } from './ports.ts';
import { PORTS_FILE, STATE_FILE, Supervisor, type SupervisorState } from './supervisor.ts';

const USAGE = `usage: coxia-server <command>

  run      supervise one Coxia core per workspace (what the systemd unit runs)
  status   print the workspaces, their ports, pids and /healthz; exit 1 when something is down

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

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'run';
  if (command === 'run') {
    run();
    return -1; // stays alive until a signal
  }
  if (command === 'status') return status();
  console.error(USAGE);
  return command === 'help' || command === '--help' ? 0 : 2;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    // A bad configuration is one line and exit 1, not a stack trace.
    console.error(e instanceof ConfigError ? `coxia-server: ${e.message}` : e);
    process.exit(1);
  },
);
