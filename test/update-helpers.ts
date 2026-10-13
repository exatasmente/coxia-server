import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UpdateConfig } from '../src/config.ts';
import { Supervisor } from '../src/supervisor.ts';
import type { UpdaterDeps } from '../src/updater.ts';
import { FAKE_CORE, freePort, sandbox } from './helpers.ts';

/** What a fake release does differently from a healthy one; each key is an environment variable of test/fake-core.mjs. */
export type Behaviour = Partial<Record<'FAKE_CORE_VERSION' | 'FAKE_CORE_MARKER' | 'FAKE_CORE_CRASH_AFTER_MS' | 'FAKE_CORE_NO_WEB', string>>;

export interface Harness {
  root: string;
  cfg: UpdateConfig;
  deps: UpdaterDeps;
  /** The tags the "public repository" lists. */
  tags: string[];
  /** What building a version makes; a missing entry makes a healthy release that reports its own version. */
  behaviours: Record<string, Behaviour | 'build-fails'>;
  built: string[];
  journal: string[];
  noticesFile: string;
  stateFile: string;
  supervisor: () => Supervisor | null;
  makeRelease: (version: string, behaviour?: Behaviour) => void;
  /** Starts the supervisor on the active release, as systemd would have. */
  boot: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export const readTree = (dir: string, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) Object.assign(out, readTree(join(dir, e.name), rel));
    else if (e.isFile()) out[rel] = readFileSync(join(dir, e.name), 'utf8');
  }
  return out;
};

/**
 * An instance in a temp folder: data with a registry, a config and a 0600 secrets file, a releases folder with the current version, the app link, and
 * a supervisor that can be started and stopped in-process in place of systemd. Nothing outside the temp folder is touched.
 */
export async function harness(current = '1.0.0-beta.1'): Promise<Harness> {
  const s = sandbox(await freePort());
  s.setWorkspaces(['alpha']);
  writeFileSync(join(s.dataDir, 'config.json'), '{"schema":22}\n');
  writeFileSync(join(s.dataDir, 'secrets.json'), '{"k":"v"}\n', { mode: 0o600 });
  chmodSync(join(s.dataDir, 'secrets.json'), 0o600);
  mkdirSync(join(s.dataDir, 'workspaces', 'alpha', 'runs'), { recursive: true });
  writeFileSync(join(s.dataDir, 'workspaces', 'alpha', 'runs', 'r-1.json'), '{"status":"gate"}\n');
  mkdirSync(s.stateDir, { recursive: true });

  const releasesDir = join(s.root, 'opt', 'releases');
  const appLink = join(s.root, 'opt', 'app');
  const snapshotsDir = join(s.root, 'snapshots');
  const stateFile = join(s.root, 'fake-state.json');
  const noticesFile = join(s.root, 'notices.jsonl');
  writeFileSync(stateFile, JSON.stringify({ actions: [], runs: [] }));

  const cfg: UpdateConfig = {
    dataDir: s.dataDir,
    stateDir: s.stateDir,
    appLink,
    releasesDir,
    snapshotsDir,
    channel: 'beta',
    repoUrl: 'https://example.com/group/project.git',
    healthMinutes: 0.01,
    buildScript: '/nonexistent',
    service: 'coxia.service',
    notify: true,
  };

  let supervisor: Supervisor | null = null;
  let clock = Date.parse('2026-03-01T10:00:00Z');

  const makeRelease = (version: string, behaviour: Behaviour = {}) => {
    const dir = join(releasesDir, version, 'out', 'headless');
    mkdirSync(dir, { recursive: true });
    const env = { FAKE_CORE_VERSION: version, ...behaviour };
    // Sets the behaviour, then runs the shared fake core in this process, with the flags the supervisor gave.
    writeFileSync(join(dir, 'coxia.mjs'), `Object.assign(process.env, ${JSON.stringify(env)});\nawait import(${JSON.stringify(pathToFileURL(FAKE_CORE).href)});\n`);
  };

  const h: Harness = {
    root: s.root,
    cfg,
    tags: [`v${current}`],
    behaviours: {},
    built: [],
    journal: [],
    noticesFile,
    stateFile,
    supervisor: () => supervisor,
    makeRelease,
    boot: async () => {
      supervisor = new Supervisor({
        ...s.options({ entry: join(appLink, 'out', 'headless', 'coxia.mjs') }),
        env: { FAKE_CORE_STATE: stateFile, FAKE_CORE_NOTICES: noticesFile },
      });
      supervisor.start();
    },
    shutdown: async () => {
      await supervisor?.stop();
      supervisor = null;
    },
    deps: {
      stop: async () => {
        await supervisor?.stop();
        supervisor = null;
      },
      start: () => h.boot(),
      build: async (version) => {
        h.built.push(version);
        const how = h.behaviours[version];
        if (how === 'build-fails') throw new Error('npm ci failed');
        makeRelease(version, how ?? {});
      },
      listTags: async () => h.tags,
      log: (line) => h.journal.push(line),
      // Every call is a minute later, so snapshot names never collide.
      now: () => new Date((clock += 60_000)),
      pollMs: 50,
      graceMs: 1500,
      rollbackWatchMs: 400,
    },
  };

  makeRelease(current);
  symlinkSync(join(releasesDir, current), appLink);
  return h;
}
