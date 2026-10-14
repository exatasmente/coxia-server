import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { ENTRY_RELATIVE } from './core.ts';

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
  return { ...base, masterKeyFile, entry, rendererDir };
}
