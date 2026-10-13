import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { fetchHealth } from '../src/core.ts';
import type { SupervisorOptions } from '../src/supervisor.ts';

export const FAKE_CORE = join(import.meta.dirname, 'fake-core.mjs');

export interface Sandbox {
  root: string;
  dataDir: string;
  stateDir: string;
  config: Config;
  logFile: string;
  lines: string[];
  options: (extra?: Partial<SupervisorOptions>) => SupervisorOptions;
  setWorkspaces: (ids: string[]) => void;
}

/** A throwaway data folder, state folder and master key, all under the OS temp folder. Nothing real is ever touched. */
export function sandbox(basePort: number): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'coxia-server-test-'));
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'state');
  mkdirSync(dataDir);
  const masterKeyFile = join(root, 'master.key');
  writeFileSync(masterKeyFile, 'not-a-real-key');
  const config: Config = { dataDir, stateDir, masterKeyFile, entry: FAKE_CORE, basePort };
  const lines: string[] = [];
  const logFile = join(root, 'starts.jsonl');
  return {
    root,
    dataDir,
    stateDir,
    config,
    logFile,
    lines,
    options: (extra = {}) => ({
      ...config,
      pollMs: 50,
      stopDeadlineMs: 1500,
      backoff: { initialMs: 50, maxMs: 400, stableMs: 10_000 },
      env: { FAKE_CORE_LOG: logFile },
      log: (_stream, line) => lines.push(line),
      ...extra,
    }),
    setWorkspaces: (ids) =>
      writeFileSync(
        join(dataDir, 'workspaces.json'),
        JSON.stringify({ current: ids[0] ?? '', list: ids.map((id) => ({ id, name: id, createdAt: '2026-01-01T00:00:00.000Z', test: false })) }),
      ),
  };
}

export function starts(file: string): { pid: number; flags: Record<string, string> }[] {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function until<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 8000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const healthy = (port: number) => fetchHealth('127.0.0.1', port, 500);

/** A port range start that is free right now, so two test files do not fight over sockets. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
