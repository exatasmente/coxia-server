import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { ENTRY_RELATIVE, WORKSPACE_ID } from './core.ts';

export const DEFAULT_BASE_PORT = 8800;
/** The core listens on this address only; admin clients reach it through an SSH tunnel. Not configurable on purpose. */
export const LOOPBACK = '127.0.0.1';

export interface Config {
  dataDir: string;
  stateDir: string;
  masterKeyFile: string;
  /** Path of the headless bundle. */
  entry: string;
  rendererDir?: string;
  basePort: number;
  /** The public address of a workspace, by id, when it is served at its own (`COXIA_PUBLIC_URLS`); one left out uses the address the cores keep. */
  publicUrls?: Record<string, string>;
}

export class ConfigError extends Error {}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is not set`);
  if (!isAbsolute(v)) throw new ConfigError(`${name} must be an absolute path`);
  return resolve(v);
}

function stateDirOf(env: NodeJS.ProcessEnv): string {
  // systemd's StateDirectory= can hand the folder over; a plain run names it.
  return resolve(env.COXIA_STATE_DIR?.trim() || need(env, 'STATE_DIRECTORY'));
}

function basePortOf(env: NodeJS.ProcessEnv): number {
  const raw = env.COXIA_BASE_PORT?.trim();
  if (!raw) return DEFAULT_BASE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65000) throw new ConfigError('COXIA_BASE_PORT must be an integer from 1024 to 65000');
  return n;
}

// `id=url` pairs separated by commas, so the env file keeps its one-word values. The core checks the address again with its own rules; this only
// refuses what can never be one (not a URL, not https, or http away from the loopback), before anything is spawned.
function publicUrlsOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.COXIA_PUBLIC_URLS?.trim();
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    const id = at > 0 ? pair.slice(0, at) : '';
    const url = at > 0 ? pair.slice(at + 1) : '';
    if (!WORKSPACE_ID.test(id)) throw new ConfigError(`COXIA_PUBLIC_URLS: "${pair}" is not workspace=url`);
    if (id in out) throw new ConfigError(`COXIA_PUBLIC_URLS: ${id} appears twice`);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ConfigError(`COXIA_PUBLIC_URLS: the address of ${id} is not a URL`);
    }
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new ConfigError(`COXIA_PUBLIC_URLS: the address of ${id} must be https`);
    out[id] = url;
  }
  return out;
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** What the status command needs: where the data and the supervisor's own state are. */
export function loadStatusConfig(env: NodeJS.ProcessEnv): Pick<Config, 'dataDir' | 'stateDir' | 'basePort'> {
  return { dataDir: need(env, 'COXIA_DATA_DIR'), stateDir: stateDirOf(env), basePort: basePortOf(env) };
}

/** What the supervisor needs, checked before it spawns anything: a misconfiguration is one clear exit, not a restart loop of children. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const base = loadStatusConfig(env);
  const masterKeyFile = need(env, 'COXIA_MASTER_KEY_FILE');
  const entry = env.COXIA_ENTRY?.trim() ? need(env, 'COXIA_ENTRY') : join(need(env, 'COXIA_DIR'), ENTRY_RELATIVE);
  const rendererDir = env.COXIA_RENDERER_DIR?.trim() ? need(env, 'COXIA_RENDERER_DIR') : undefined;

  if (!existsSync(base.dataDir) || !statSync(base.dataDir).isDirectory()) throw new ConfigError(`data folder ${base.dataDir} does not exist`);
  if (!existsSync(masterKeyFile) || !statSync(masterKeyFile).isFile()) throw new ConfigError(`master key file ${masterKeyFile} does not exist`);
  // A key stored next to the data it protects would travel with every backup of that data.
  if (inside(realpathSync(base.dataDir), realpathSync(masterKeyFile))) throw new ConfigError('the master key file must be outside the data folder');
  if (inside(realpathSync(base.dataDir), resolve(base.stateDir))) throw new ConfigError('the state folder must be outside the data folder');
  if (!existsSync(entry)) throw new ConfigError(`the core entry ${entry} does not exist (build the headless bundle first)`);
  if (rendererDir && !existsSync(rendererDir)) throw new ConfigError(`renderer folder ${rendererDir} does not exist`);
  return { ...base, masterKeyFile, entry, rendererDir, publicUrls: publicUrlsOf(env) };
}

export type Channel = 'beta' | 'stable' | 'off';

export const DEFAULT_REPO_URL = 'https://github.com/exatasmente/coxia.git';

export interface UpdateConfig {
  dataDir: string;
  stateDir: string;
  /** The symlink the supervisor reads the core through (`COXIA_DIR`); it points at one folder of `releasesDir`. */
  appLink: string;
  releasesDir: string;
  snapshotsDir: string;
  channel: Channel;
  repoUrl: string;
  /** How long a new version is watched after it starts. */
  healthMinutes: number;
  buildScript: string;
  service: string;
  /** Tell the person through the cores (a line in the general thread). */
  notify: boolean;
}

/** What `coxia-server update` and `rollback` need: where the releases and snapshots live, which versions to follow, how long to watch. */
export function loadUpdateConfig(env: NodeJS.ProcessEnv): UpdateConfig {
  const base = loadStatusConfig(env);
  const channel = (env.COXIA_UPDATE_CHANNEL?.trim() || 'beta') as Channel;
  if (!['beta', 'stable', 'off'].includes(channel)) throw new ConfigError('COXIA_UPDATE_CHANNEL must be beta, stable or off');
  const minutesRaw = env.COXIA_UPDATE_HEALTH_MINUTES?.trim();
  const healthMinutes = minutesRaw ? Number(minutesRaw) : 5;
  if (!Number.isFinite(healthMinutes) || healthMinutes <= 0 || healthMinutes > 120) throw new ConfigError('COXIA_UPDATE_HEALTH_MINUTES must be a number above 0, up to 120');
  const appLink = need(env, 'COXIA_DIR');
  const snapshotsDir = env.COXIA_SNAPSHOTS_DIR?.trim() ? need(env, 'COXIA_SNAPSHOTS_DIR') : join(dirname(base.dataDir), 'snapshots');
  if (inside(resolve(base.dataDir), snapshotsDir)) throw new ConfigError('the snapshots folder must be outside the data folder');
  return {
    dataDir: base.dataDir,
    stateDir: base.stateDir,
    appLink,
    releasesDir: env.COXIA_RELEASES_DIR?.trim() ? need(env, 'COXIA_RELEASES_DIR') : join(dirname(appLink), 'releases'),
    snapshotsDir,
    channel,
    repoUrl: env.COXIA_REPO_URL?.trim() || DEFAULT_REPO_URL,
    healthMinutes,
    buildScript: env.COXIA_BUILD_SCRIPT?.trim() ? need(env, 'COXIA_BUILD_SCRIPT') : join(dirname(appLink), 'server', 'deploy', 'build-release.sh'),
    service: env.COXIA_SERVICE?.trim() || 'coxia.service',
    notify: env.COXIA_UPDATE_NOTICE?.trim() !== '0',
  };
}

export interface ServiceUserConfig {
  /** The user the cores run as; root steps hand work to it. */
  user: string;
  /** Its home: where the deploy key lives (`.ssh/`). */
  home: string;
}

/** Who `deploy-key` and `import` act for. The home defaults to the folder that holds the data folder, as the install script lays it out. */
export function loadServiceUserConfig(env: NodeJS.ProcessEnv): ServiceUserConfig {
  const user = env.COXIA_SERVICE_USER?.trim() || 'coxia';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new ConfigError('COXIA_SERVICE_USER is not a valid user name');
  const home = env.COXIA_HOME?.trim() ? need(env, 'COXIA_HOME') : dirname(need(env, 'COXIA_DATA_DIR'));
  return { user, home };
}

export interface ImportConfig extends ServiceUserConfig {
  dataDir: string;
  stateDir: string;
  masterKeyFile: string;
  /** The headless bundle; its `--import` places the workspace. */
  entry: string;
  /** Clones go to <reposDir>/<workspace id>/<repo id>. */
  reposDir: string;
  /** Where a bundle is unpacked: a folder of the service user, outside the data folder. */
  tmpDir: string;
  service: string;
  /** Allow a remote that is a local path or file:// (tests). The real one is ssh, https or git only. */
  allowLocalRemotes: boolean;
}

/** What `coxia-server import` needs: the paths the service itself runs with, plus where the clones go. */
export function loadImportConfig(env: NodeJS.ProcessEnv): ImportConfig {
  const base = loadStatusConfig(env);
  const svc = loadServiceUserConfig(env);
  const entry = env.COXIA_ENTRY?.trim() ? need(env, 'COXIA_ENTRY') : join(need(env, 'COXIA_DIR'), ENTRY_RELATIVE);
  return {
    ...svc,
    dataDir: base.dataDir,
    stateDir: base.stateDir,
    masterKeyFile: need(env, 'COXIA_MASTER_KEY_FILE'),
    entry,
    reposDir: env.COXIA_REPOS_DIR?.trim() ? need(env, 'COXIA_REPOS_DIR') : join(svc.home, 'repos'),
    tmpDir: env.COXIA_IMPORT_TMP_DIR?.trim() ? need(env, 'COXIA_IMPORT_TMP_DIR') : join(svc.home, 'import-tmp'),
    service: env.COXIA_SERVICE?.trim() || 'coxia.service',
    allowLocalRemotes: env.COXIA_IMPORT_ALLOW_LOCAL_REMOTES?.trim() === '1',
  };
}
