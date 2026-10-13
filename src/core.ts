// Everything the server knows about the Coxia core's headless entry lives here. The contract is the command line, the workspace registry
// file and GET /healthz; when the core changes any of them, this is the only module to adjust.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

/** Where the headless bundle sits inside a Coxia checkout. */
export const ENTRY_RELATIVE = 'out/headless/coxia.mjs';
export const REGISTRY_FILE = 'workspaces.json';

// Same shape the core accepts for a workspace id; anything else in the registry is ignored rather than passed on as a flag or a log prefix.
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface CoreLaunch {
  dataDir: string;
  workspace: string;
  masterKeyFile: string;
  host: string;
  port: number;
  rendererDir?: string;
}

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
