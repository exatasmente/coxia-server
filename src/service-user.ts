// Root steps that must act as the service user (clones, the deploy key, the core's one-shot import). Arguments are always a list, never a shell line;
// the tests inject a runner that runs the command as the current user instead.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServiceUserConfig } from './config.ts';

const exec = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type AsService = (command: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;

/** Runs through `runuser`, with `env` as the only addition to the environment (and HOME the service user's, which runuser does not set). */
export function runAsService(cfg: ServiceUserConfig): AsService {
  return async (command, args, env = {}) => {
    const pairs = Object.entries({ HOME: cfg.home, ...env }).map(([k, v]) => `${k}=${v}`);
    const { stdout, stderr } = await exec('runuser', ['-u', cfg.user, '--', 'env', ...pairs, command, ...args], { cwd: '/', maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  };
}

/** What a failed command said, shortened: the last stderr line is what a person needs. */
export function failureText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const lines = (err.stderr ?? '').trim().split('\n').filter(Boolean);
  return lines.at(-1) ?? err.message ?? String(e);
}
