// The real side of UpdaterDeps: systemd, the build script and git. Tests inject fakes instead of this.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateConfig } from './config.ts';
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
