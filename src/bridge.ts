// `coxia-server bridge <workspace>`: the admin socket of a workspace on this stdin/stdout, so a desktop can reach it with
// `ssh admin@host coxia-server bridge <workspace>`. Bytes only: no parsing, and nothing but the socket's bytes on stdout (it is the protocol).
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { ConfigError } from './config.ts';
import { WORKSPACE_ID, adminSocketPath, readWorkspaceIds } from './core.ts';

export function bridge(dataDir: string, workspace: string | undefined): Promise<number> {
  if (!workspace || !WORKSPACE_ID.test(workspace)) throw new ConfigError('usage: coxia-server bridge <workspace>');
  const ids = readWorkspaceIds(dataDir);
  if (ids !== null && !ids.includes(workspace)) throw new ConfigError(`no workspace "${workspace}" (there are: ${ids.join(', ') || 'none'})`);
  const path = adminSocketPath(dataDir, workspace);
  if (!existsSync(path)) throw new ConfigError(`no admin socket for "${workspace}" (is its core running?)`);
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let connected = false;
    sock.once('error', (e: NodeJS.ErrnoException) => {
      if (!connected) reject(new ConfigError(`cannot reach the admin socket of "${workspace}": ${e.code ?? e.message}`));
      else reject(new ConfigError(`admin socket of "${workspace}": ${e.code ?? e.message}`));
    });
    sock.once('connect', () => {
      connected = true;
      sock.pipe(process.stdout, { end: false });
      // stdin ending half-closes; the core ends its side, which resolves below.
      process.stdin.pipe(sock);
      sock.once('close', () => resolve(0));
    });
  });
}
