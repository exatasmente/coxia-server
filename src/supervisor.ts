import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOOPBACK, type Config } from './config.ts';
import { spawnSync } from 'node:child_process';
import { coreArgs, hasRegistry, initArgs, readWorkspaceIds } from './core.ts';
import { writeJsonAtomic } from './files.ts';
import { assignPorts, loadPorts, savePorts, type PortMap } from './ports.ts';
import { DEFAULT_BACKOFF, ManagedProcess, type BackoffPolicy, type ProcessState } from './process.ts';

/** systemd's TimeoutStopSec must stay above this (deploy/coxia.service). */
export const STOP_DEADLINE_MS = 15_000;
export const POLL_MS = 5000;

export const PORTS_FILE = 'ports.json';
export const STATE_FILE = 'supervisor.json';

export interface SupervisorOptions extends Config {
  /** Runs the entry; the Node that runs the supervisor by default. */
  node?: string;
  /** Extra environment for the cores, over the supervisor's own. */
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  stopDeadlineMs?: number;
  backoff?: BackoffPolicy;
  /** The journal: one call per line, 'supervisor' for our own words. */
  log?: (stream: 'out' | 'err' | 'supervisor', line: string) => void;
}

export interface WorkspaceState {
  id: string;
  port: number;
  pid: number | null;
  state: ProcessState | 'stopping';
  restarts: number;
  since: string;
}

export interface SupervisorState {
  pid: number;
  startedAt: string;
  workspaces: WorkspaceState[];
}

const defaultLog: NonNullable<SupervisorOptions['log']> = (stream, line) => {
  (stream === 'err' ? process.stderr : process.stdout).write(`${line}\n`);
};

/** Keeps one core process per workspace of the registry: starts the new, stops the removed, restarts the crashed, one by one. */
export class Supervisor {
  private readonly o: Required<Pick<SupervisorOptions, 'pollMs' | 'stopDeadlineMs' | 'backoff' | 'node'>> & SupervisorOptions;
  private readonly active = new Map<string, ManagedProcess>();
  // Removed from the registry, still shutting down; their sockets stay reserved until they are gone.
  private readonly retiring = new Map<string, ManagedProcess>();
  private poll: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();
  private lastWarning = '';
  private closed = false;

  constructor(options: SupervisorOptions) {
    this.o = { pollMs: POLL_MS, stopDeadlineMs: STOP_DEADLINE_MS, backoff: DEFAULT_BACKOFF, node: process.execPath, ...options };
  }

  private say(line: string, stream: 'out' | 'err' | 'supervisor' = 'supervisor', id = 'supervisor'): void {
    // The prefix is how a line from the journal is told apart per workspace.
    (this.o.log ?? defaultLog)(stream, `[${id}] ${line}`);
  }

  start(): void {
    this.initialize();
    this.reconcile();
    this.poll = setInterval(() => this.reconcile(), this.o.pollMs);
  }

  // A fresh install has no registry yet, and only the core may write it: the entry makes it once, with its first workspace. A registry that
  // exists but is unreadable is left alone (reconcile warns), so a bad moment never resets the person's workspaces.
  private initialize(): void {
    if (hasRegistry(this.o.dataDir)) return;
    const run = spawnSync(this.o.node, initArgs(this.o.entry, this.o.dataDir), { env: { ...process.env, ...this.o.env }, encoding: 'utf8', timeout: 60_000 });
    // The core logs while it prepares the folder; the id of the first workspace is its last line.
    if (run.status === 0) this.say(`created the workspace registry, first workspace ${run.stdout.trim().split('\n').pop() ?? ''}`);
    else this.say(`could not create the workspace registry: ${(run.stderr || run.error?.message || `exit ${run.status}`).trim()}`, 'err');
  }

  /** Brings the running set in line with the registry. Cheap: one small file read per call. */
  reconcile(): void {
    if (this.closed) return;
    const ids = readWorkspaceIds(this.o.dataDir);
    if (ids === null) {
      this.warnOnce(`cannot read the workspace registry in ${this.o.dataDir}; keeping what runs`);
      return;
    }
    this.lastWarning = '';

    for (const [id, proc] of this.active) {
      if (ids.includes(id)) continue;
      this.active.delete(id);
      this.retiring.set(id, proc);
      this.say(`workspace ${id} left the registry, stopping`);
      void proc.stop(this.o.stopDeadlineMs).then(() => {
        this.retiring.delete(id);
        this.writeState();
      });
    }

    const missing = ids.filter((id) => !this.active.has(id) && !this.retiring.has(id));
    const portsFile = join(this.o.stateDir, PORTS_FILE);
    // What runs is the truth about its own port, even if the file was lost; only the retiring ones are held back from newcomers.
    const saved: PortMap = { ...loadPorts(portsFile), ...Object.fromEntries([...this.active].map(([id, p]) => [id, p.port])) };
    const ports = assignPorts(saved, ids.filter((id) => !this.retiring.has(id)), this.o.basePort, [...this.retiring.values()].map((p) => p.port));
    if (!samePorts(saved, ports)) savePorts(portsFile, ports);

    for (const id of missing) this.spawnWorkspace(id, ports[id] as number);
    this.writeState();
  }

  private warnOnce(message: string): void {
    if (message === this.lastWarning) return;
    this.lastWarning = message;
    this.say(message, 'err');
  }

  private spawnWorkspace(id: string, port: number): void {
    const args = coreArgs(this.o.entry, {
      dataDir: this.o.dataDir,
      workspace: id,
      masterKeyFile: this.o.masterKeyFile,
      host: LOOPBACK,
      port,
      rendererDir: this.o.rendererDir,
    });
    const proc = new ManagedProcess({
      id,
      port,
      command: this.o.node,
      args,
      env: { ...process.env, ...this.o.env },
      policy: this.o.backoff,
      onLine: (wid, stream, line) => this.say(line, stream, wid),
      onChange: () => this.writeState(),
    });
    this.active.set(id, proc);
    proc.start();
  }

  snapshot(): SupervisorState {
    const rows: WorkspaceState[] = [];
    for (const [map, retiring] of [[this.active, false], [this.retiring, true]] as const) {
      for (const p of map.values()) {
        rows.push({ id: p.id, port: p.port, pid: p.pid, state: retiring ? 'stopping' : p.state, restarts: p.restarts, since: p.since });
      }
    }
    return { pid: process.pid, startedAt: this.startedAt, workspaces: rows };
  }

  // The status command reads this file; a failure to write it never takes the service down.
  private writeState(): void {
    if (this.closed) return;
    try {
      writeJsonAtomic(join(this.o.stateDir, STATE_FILE), this.snapshot());
    } catch (e) {
      this.warnOnce(`cannot write the state file: ${(e as Error).message}`);
    }
  }

  /** SIGTERM to every core at once, SIGKILL for what is left after the deadline. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    this.say(`stopping ${this.active.size + this.retiring.size} process(es)`);
    const all = [...this.active.values(), ...this.retiring.values()];
    await Promise.all(all.map((p) => p.stop(this.o.stopDeadlineMs)));
    try {
      rmSync(join(this.o.stateDir, STATE_FILE), { force: true });
    } catch {
      // the next start overwrites it
    }
    this.say('stopped');
  }
}

function samePorts(a: PortMap, b: PortMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
