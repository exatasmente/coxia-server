// The service user's SSH key, for the clones `coxia-server import` makes: created once, never replaced, its public line printed for the host.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AsService } from './service-user.ts';

export const deployKeyPath = (home: string): string => join(home, '.ssh', 'id_ed25519');

export interface DeployKey {
  created: boolean;
  /** The public key line, ready for the host's deploy keys. */
  publicLine: string;
  path: string;
}

export async function ensureDeployKey(home: string, asService: AsService): Promise<DeployKey> {
  const path = deployKeyPath(home);
  if (existsSync(path)) {
    // A key that exists is left exactly as it is; only its public half may be rebuilt when that file went missing.
    if (!existsSync(`${path}.pub`) || readFileSync(`${path}.pub`, 'utf8').trim() === '') {
      const { stdout } = await asService('ssh-keygen', ['-y', '-f', path]);
      writeFileSync(`${path}.pub`, `${stdout.trim()}\n`, { mode: 0o644 });
    }
    return { created: false, publicLine: readFileSync(`${path}.pub`, 'utf8').trim(), path };
  }
  await asService('mkdir', ['-p', '-m', '0700', join(home, '.ssh')]);
  await asService('chmod', ['0700', join(home, '.ssh')]);
  await asService('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `coxia@${hostname()}`, '-f', path]);
  await asService('chmod', ['0600', path]);
  return { created: true, publicLine: readFileSync(`${path}.pub`, 'utf8').trim(), path };
}
