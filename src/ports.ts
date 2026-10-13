import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './files.ts';

export type PortMap = Record<string, number>;

const MAX_PORT = 65535;

/** The saved assignment; empty when the file is missing or damaged (the next run assigns again, in registry order). */
export function loadPorts(file: string): PortMap {
  try {
    const raw = (JSON.parse(readFileSync(file, 'utf8')) as { ports?: unknown }).ports;
    if (!raw || typeof raw !== 'object') return {};
    const out: PortMap = {};
    for (const [id, port] of Object.entries(raw)) {
      if (Number.isInteger(port) && (port as number) > 0 && (port as number) <= MAX_PORT) out[id] = port as number;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePorts(file: string, ports: PortMap): void {
  writeJsonAtomic(file, { ports });
}

/**
 * A workspace keeps its port for as long as it exists in the registry, across restarts of the supervisor, so a tunnel or a bookmark stays valid.
 * A new workspace gets the lowest free port from `base`; the port of a removed one is released. `reserved` holds ports still bound by a process
 * that is shutting down, so a new workspace never races it for the socket.
 */
export function assignPorts(saved: PortMap, ids: readonly string[], base: number, reserved: Iterable<number> = []): PortMap {
  const out: PortMap = {};
  const taken = new Set<number>(reserved);
  for (const id of ids) {
    const port = saved[id];
    if (port !== undefined && !taken.has(port)) {
      out[id] = port;
      taken.add(port);
    }
  }
  for (const id of ids) {
    if (out[id] !== undefined) continue;
    let port = base;
    while (taken.has(port)) port++;
    if (port > MAX_PORT) throw new Error(`no free port from ${base} for workspace ${id}`);
    out[id] = port;
    taken.add(port);
  }
  return out;
}
