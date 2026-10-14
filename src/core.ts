// Everything the server knows about the Coxia core's headless entry lives here. The contract is the command line, the workspace registry
// file, GET /healthz and the local admin socket; when the core changes any of them, this is the only module to adjust.
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';

/** Where the headless bundle sits inside a Coxia checkout. */
export const ENTRY_RELATIVE = 'out/headless/coxia.mjs';
export const REGISTRY_FILE = 'workspaces.json';

// Same shape the core accepts for a workspace id; anything else in the registry is ignored rather than passed on as a flag or a log prefix.
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface CoreLaunch {
  dataDir: string;
  workspace: string;
  masterKeyFile: string;
  host: string;
  port: number;
  rendererDir?: string;
}

/** Only prepares a data folder (the registry and its first workspace) and exits: what runs before the first supervision of a fresh install. */
export const initArgs = (entry: string, dataDir: string): string[] => [entry, '--init', '--data-dir', dataDir];

export const hasRegistry = (dataDir: string): boolean => existsSync(join(dataDir, REGISTRY_FILE));

export function coreArgs(entry: string, launch: CoreLaunch): string[] {
  const args = [
    entry,
    '--data-dir', launch.dataDir,
    '--workspace', launch.workspace,
    '--master-key-file', launch.masterKeyFile,
    '--host', launch.host,
    '--port', String(launch.port),
  ];
  if (launch.rendererDir) args.push('--renderer-dir', launch.rendererDir);
  return args;
}

/**
 * The ids of the workspaces in the core's registry, in registry order. Read-only: the core owns this file.
 * Returns null when the file is missing or unreadable, so a bad moment never reads as "every workspace was removed".
 */
export function readWorkspaceIds(dataDir: string): string[] | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, REGISTRY_FILE), 'utf8'));
    const list = (raw as { list?: unknown } | null)?.list;
    if (!Array.isArray(list)) return null;
    const ids: string[] = [];
    for (const item of list) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && WORKSPACE_ID.test(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  } catch {
    return null;
  }
}

export interface Health {
  ok: boolean;
  version?: string;
  workspace?: string;
}

/** GET /healthz of a core; null when nothing answers in time or the answer is not the expected JSON. */
export function fetchHealth(host: string, port: number, timeoutMs = 2000): Promise<Health | null> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: '/healthz', method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Health;
          resolve(res.statusCode === 200 && body.ok === true ? body : null);
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** The version of the core's client contract this server speaks on the admin socket; a core with another one refuses the hello. */
export const CONTRACT_VERSION = 1;
const ADMIN_SOCKET_NAME = 'admin.sock';
const ADMIN_LINE_MAX = 8 * 1024 * 1024;

/** Where a core listens for admin clients: its workspace folder, mode 0600, so only the user the cores run as can call it. */
export const adminSocketPath = (dataDir: string, workspace: string): string => join(dataDir, 'workspaces', workspace, ADMIN_SOCKET_NAME);

export class AdminError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AdminError';
  }
}

/** One call through a core's admin socket: the hello with the contract version, the request, its one answer. The value, or an AdminError with the core's code. */
export function adminCall(socketPath: string, channel: string, args: unknown[] = [], timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buffer = '';
    let greeted = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new AdminError('timeout', `no answer from ${socketPath} within ${timeoutMs} ms`))), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify({ hello: CONTRACT_VERSION })}\n`));
    sock.on('error', (e: NodeJS.ErrnoException) =>
      done(() => reject(new AdminError('unreachable', e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no core listens on ${socketPath}` : e.message))),
    );
    sock.on('close', () => done(() => reject(new AdminError('connection-lost', `${socketPath} closed before answering`))));
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > ADMIN_LINE_MAX) return done(() => reject(new AdminError('protocol', 'answer line too long')));
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: { hello?: unknown; error?: { code?: string; message?: string }; id?: unknown; ok?: boolean; value?: unknown; event?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return done(() => reject(new AdminError('protocol', 'the core sent a line that is not JSON')));
        }
        if (!greeted) {
          if (msg.hello) {
            greeted = true;
            sock.write(`${JSON.stringify({ id: 1, channel, args })}\n`);
            continue;
          }
          const failure = msg.error ?? {};
          return done(() => reject(new AdminError(failure.code ?? 'protocol', failure.message ?? 'the core refused the hello')));
        }
        // Events arrive between answers; this one-shot call reads only its own answer.
        if (msg.id !== 1) continue;
        if (msg.ok) return done(() => resolve(msg.value));
        const failure = msg.error ?? {};
        return done(() => reject(new AdminError(failure.code ?? 'internal', failure.message ?? 'the call failed')));
      }
    });
  });
}

/** The thread every workspace has; a notice for the person goes there. */
const GENERAL_THREAD = 'general';

export interface WorkReport {
  /** Why the core is not at a safe point; empty when it is. */
  busy: string[];
}

/**
 * Whether a core is at a safe point to be stopped: no approved write is executing (`actions:list`, state `running`) and no run has an agent working a
 * step (`runs:list`, status `working`). The second is wider than "an external effect" on purpose: the runner's autonomous pushes, pull requests and
 * comments are audited but never listed as actions while they run, so the only visible sign of them is a working run. Everything else a run can be in
 * (gate, question, waiting, to-start, to-accept, failed) is parked in a file and resumes after a restart.
 */
export async function inspectWork(socketPath: string, timeoutMs = 10_000): Promise<WorkReport> {
  const actions = await adminCall(socketPath, 'actions:list', [], timeoutMs);
  const runs = await adminCall(socketPath, 'runs:list', [], timeoutMs);
  if (!Array.isArray(actions) || !Array.isArray(runs)) throw new AdminError('protocol', 'actions:list or runs:list did not answer with a list');
  const busy: string[] = [];
  for (const a of actions as { id?: unknown; kind?: unknown; state?: unknown }[]) {
    if (a?.state === 'running') busy.push(`action ${String(a.id)} (${String(a.kind)}) is executing`);
  }
  for (const r of runs as { id?: unknown; status?: unknown; stage?: unknown }[]) {
    if (r?.status === 'working') busy.push(`run ${String(r.id)} has an agent working step ${String(r.stage)}`);
  }
  return { busy };
}

/** Whether the runner's state can be read: the closest the contract lets the server get to "able to resume". */
export async function runnerAnswers(socketPath: string, timeoutMs = 5000): Promise<boolean> {
  try {
    return Array.isArray(await adminCall(socketPath, 'runs:list', [], timeoutMs));
  } catch {
    return false;
  }
}

/** The path the core serves its web client under (`web:view`), which a client may change. Throws when the core cannot say. */
export async function webBasePath(socketPath: string, timeoutMs = 5000): Promise<string> {
  const view = (await adminCall(socketPath, 'web:view', [], timeoutMs)) as { settings?: { basePath?: unknown } } | null;
  const base = view?.settings?.basePath;
  if (typeof base !== 'string' || !base.startsWith('/')) throw new AdminError('protocol', 'web:view gave no base path');
  return base;
}

/** GET <path> on a core; the status code, or null when nothing answers in time. */
export function fetchStatus(host: string, port: number, path: string, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? null));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Tells the person through the core: one line in the general thread, through the same admin call a client would make. It is posted as the admin
 * (the core has no channel for an app-authored notice), and it carries no `@`, so no agent is addressed. Never throws: a notice that could not be
 * posted must not undo an update.
 */
export async function postNotice(socketPath: string, text: string): Promise<boolean> {
  try {
    // The core makes its general thread the first time the forum is listed: on a fresh workspace it does not exist yet.
    await adminCall(socketPath, 'forum:list', [], 5000);
    await adminCall(socketPath, 'forum:post', [GENERAL_THREAD, text], 5000);
    return true;
  } catch {
    return false;
  }
}
