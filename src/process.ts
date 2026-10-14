import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface BackoffPolicy {
  /** First wait after a crash. */
  initialMs: number;
  /** The wait doubles after each crash in a row, up to this. */
  maxMs: number;
  /** A process that stayed up this long counts as healthy again: the next crash starts from `initialMs`. */
  stableMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1000, maxMs: 60_000, stableMs: 30_000 };

export type ProcessState = 'running' | 'backoff' | 'stopped';

export interface ManagedOptions {
  id: string;
  port: number;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  policy: BackoffPolicy;
  /** One line of the process's output, or of the supervisor's own commentary (stream 'supervisor'). */
  onLine: (id: string, stream: 'out' | 'err' | 'supervisor', line: string) => void;
  /** State changed: a spawn, an exit, a stop. */
  onChange: () => void;
}

/** One core process that is restarted when it dies, until stop() is called. Independent of every other one. */
export class ManagedProcess {
  readonly id: string;
  readonly port: number;
  private readonly opts: ManagedOptions;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private nextDelay: number;
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();
  restarts = 0;
  /** When the current state began, as an ISO date. */
  since = new Date().toISOString();
  state: ProcessState = 'backoff';

  constructor(opts: ManagedOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.port = opts.port;
    this.nextDelay = opts.policy.initialMs;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    this.launch();
  }

  private say(line: string): void {
    this.opts.onLine(this.id, 'supervisor', line);
  }

  private setState(state: ProcessState): void {
    this.state = state;
    this.since = new Date().toISOString();
    this.opts.onChange();
  }

  private launch(): void {
    this.timer = null;
    const child = spawn(this.opts.command, this.opts.args, { env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = Date.now();
    let done!: () => void;
    this.exited = new Promise((resolve) => (done = resolve));
    createInterface({ input: child.stdout }).on('line', (l) => this.opts.onLine(this.id, 'out', l));
    createInterface({ input: child.stderr }).on('line', (l) => this.opts.onLine(this.id, 'err', l));

    // 'error' (the binary is missing) can arrive without 'exit'; finish once either way.
    let finished = false;
    const finish = (how: string) => {
      if (finished) return;
      finished = true;
      this.child = null;
      done();
      this.onExit(how);
    };
    child.on('error', (e) => finish(`could not start: ${e.message}`));
    child.on('exit', (code, signal) => finish(signal ? `killed by ${signal}` : `exited with code ${code}`));
    this.say(`started, pid ${child.pid}, port ${this.port}`);
    this.setState('running');
  }

  private onExit(how: string): void {
    if (this.stopping) {
      this.say(`stopped (${how})`);
      this.setState('stopped');
      return;
    }
    // Staying up long enough clears the penalty of earlier crashes.
    if (Date.now() - this.startedAt >= this.opts.policy.stableMs) this.nextDelay = this.opts.policy.initialMs;
    const delay = this.nextDelay;
    this.nextDelay = Math.min(this.nextDelay * 2, this.opts.policy.maxMs);
    this.say(`${how}, restarting in ${delay} ms`);
    this.setState('backoff');
    this.timer = setTimeout(() => {
      this.restarts++;
      this.launch();
    }, delay);
  }

  /** SIGTERM now, SIGKILL after `deadlineMs`; resolves once the process is gone. It is not restarted. */
  async stop(deadlineMs: number): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) {
      if (this.state !== 'stopped') this.setState('stopped');
      return;
    }
    child.kill('SIGTERM');
    const killer = setTimeout(() => {
      this.say(`still running after ${deadlineMs} ms, sending SIGKILL`);
      child.kill('SIGKILL');
    }, deadlineMs);
    await this.exited;
    clearTimeout(killer);
  }
}
