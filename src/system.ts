// The real side of UpdaterDeps: systemd, the build script and git. Tests inject fakes instead of this.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImportConfig, UpdateConfig } from './config.ts';
import { LOOPBACK } from './config.ts';
import { fetchHealth } from './core.ts';
import { loadPorts } from './ports.ts';
import { PORTS_FILE } from './supervisor.ts';
import type { ImportDeps } from './importer.ts';
import { runAsService } from './service-user.ts';
import { tagsOf } from './releases.ts';
import type { UpdaterDeps } from './updater.ts';

const run = promisify(execFile);

export function systemDeps(cfg: UpdateConfig): UpdaterDeps {
  return {
    // `systemctl stop` returns when the unit is down, which is after the supervisor stopped every core (TimeoutStopSec in the unit).
    stop: async () => void (await run('systemctl', ['stop', cfg.service])),
    start: async () => void (await run('systemctl', ['start', cfg.service])),
    build: async (version) => {
      // The script builds as the service user and ends with <releases>/<version>; its output goes to the journal through ours.
      const { stdout, stderr } = await run(cfg.buildScript, [`v${version}`, cfg.releasesDir], { env: { ...process.env, COXIA_REPO_URL: cfg.repoUrl }, maxBuffer: 64 * 1024 * 1024 });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    },
    listTags: async () => tagsOf((await run('git', ['ls-remote', '--tags', '--refs', cfg.repoUrl], { timeout: 60_000 })).stdout),
    log: (line) => console.log(`[update] ${line}`),
  };
}

/** How long a restarted service gets to bring the imported workspace up. */
const HEALTH_WAIT_MS = 120_000;

export function importDeps(cfg: ImportConfig): ImportDeps {
  return {
    asService: runAsService(cfg),
    own: async (path) => void (await run('chown', ['-R', `${cfg.user}:${cfg.user}`, path])),
    restart: async () => void (await run('systemctl', ['restart', cfg.service])),
    // The supervisor assigns the port after it has read the registry, so the port appears a moment after the restart.
    healthy: async (workspace) => {
      const deadline = Date.now() + HEALTH_WAIT_MS;
      for (;;) {
        const port = loadPorts(join(cfg.stateDir, PORTS_FILE))[workspace];
        if (port !== undefined && (await fetchHealth(LOOPBACK, port, 2000))) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    log: (line) => console.error(`[import] ${line}`),
  };
}
