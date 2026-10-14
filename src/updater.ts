// Updating the core with a safety net: build the new release beside the running one, wait for a safe point, snapshot the data, switch, watch the new
// version, and go back (release and data together) if it does not hold. Everything that touches the machine (systemd, the build, the network) comes in
// through UpdaterDeps, so the tests run the whole flow against fake releases.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { appendUpdate, readUpdates, type UpdateEvent, type UpdateRecord } from './audit.ts';
import { LOOPBACK, type UpdateConfig } from './config.ts';
import { adminSocketPath, fetchHealth, fetchStatus, inspectWork, postNotice, readWorkspaceIds, runnerAnswers, webBasePath } from './core.ts';
import { loadPorts } from './ports.ts';
import { activeVersion, hasRelease, newestAfter, pruneReleases, releaseDir, swapLink } from './releases.ts';
import { listSnapshots, pruneSnapshots, restoreSnapshot, takeSnapshot, type Snapshot } from './snapshots.ts';
import { PORTS_FILE, STATE_FILE, type SupervisorState } from './supervisor.ts';

export interface UpdaterDeps {
  /** Stops the service and, with it, every core (SIGTERM, then SIGKILL after the supervisor's deadline). */
  stop: () => Promise<void>;
  start: () => Promise<void>;
  /** Builds <releases>/<version> from the public repository; throws when it cannot. */
  build: (version: string) => Promise<void>;
  /** The tag names of the public repository. */
  listTags: () => Promise<string[]>;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How often the health check looks. */
  pollMs?: number;
  /** How long a new version has to come up fully before "not up yet" counts as a failure. */
  graceMs?: number;
  /** How long the version we went back to is watched. */
  rollbackWatchMs?: number;
}

export type Trigger = 'timer' | 'manual';

export type UpdateResult =
  | { status: 'off' | 'up-to-date' }
  | { status: 'available'; version: string; busy: string[] }
  | { status: 'postponed'; version: string; busy: string[] }
  | { status: 'updated'; from: string; to: string; snapshot: string }
  | { status: 'failed'; reason: string }
  | { status: 'rolled-back'; from: string; to: string; reason: string; keptData: string }
  | { status: 'rollback-failed'; reason: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class UpdateError extends Error {}

// --- one updater at a time ---------------------------------------------------------------------------------------------------------

function acquireLock(stateDir: string): () => void {
  const file = join(stateDir, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        // a lock left by an updater that died
      }
      if (alive) throw new UpdateError(`another update or rollback is running (pid ${pid})`);
      rmSync(file, { force: true });
    }
  }
  throw new UpdateError('cannot take the update lock');
}

// --- safe point --------------------------------------------------------------------------------------------------------------------

function supervisorState(stateDir: string): SupervisorState | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')) as SupervisorState;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Asks every running core whether it can be stopped now (see inspectWork). A core that cannot be asked counts as busy: not knowing is not a safe
 * point. With the supervisor not running there is no core, so nothing to ask. Returns why not, empty when it is safe.
 */
export async function safePoint(cfg: UpdateConfig): Promise<string[]> {
  const state = supervisorState(cfg.stateDir);
  if (!state || !pidAlive(state.pid)) return [];
  const ids = readWorkspaceIds(cfg.dataDir);
  if (ids === null) return ['the workspace registry cannot be read'];
  const busy: string[] = [];
  for (const id of ids) {
    try {
      for (const why of (await inspectWork(adminSocketPath(cfg.dataDir, id))).busy) busy.push(`${id}: ${why}`);
    } catch (e) {
      busy.push(`${id}: cannot ask the core (${(e as Error).message})`);
    }
  }
  return busy;
}

// --- health ------------------------------------------------------------------------------------------------------------------------

async function problemsOf(cfg: UpdateConfig, expected: string): Promise<{ problems: string[]; restarted: boolean }> {
  const ids = readWorkspaceIds(cfg.dataDir);
  if (ids === null) return { problems: ['the workspace registry cannot be read'], restarted: false };
  const state = supervisorState(cfg.stateDir);
  if (!state || !pidAlive(state.pid)) return { problems: ['the supervisor is not running'], restarted: false };
  const ports = loadPorts(join(cfg.stateDir, PORTS_FILE));
  const problems: string[] = [];
  let restarted = false;
  for (const id of ids) {
    const row = state.workspaces.find((w) => w.id === id);
    const port = ports[id];
    if (!row || port === undefined) {
      problems.push(`${id}: not started yet`);
      continue;
    }
    // A core that had to be restarted crashed on this version: a restart loop begins here, so one is already a failure.
    if (row.restarts > 0) {
      restarted = true;
      problems.push(`${id}: restarted ${row.restarts} time(s)`);
      continue;
    }
    if (row.state !== 'running') {
      problems.push(`${id}: process is ${row.state}`);
      continue;
    }
    const health = await fetchHealth(LOOPBACK, port, 2000);
    if (!health) {
      problems.push(`${id}: /healthz does not answer`);
      continue;
    }
    if (health.version !== expected) {
      problems.push(`${id}: runs version ${health.version ?? '?'}, expected ${expected}`);
      continue;
    }
    const socket = adminSocketPath(cfg.dataDir, id);
    if (!(await runnerAnswers(socket))) {
      problems.push(`${id}: the runner does not answer on the admin socket`);
      continue;
    }
    try {
      const base = await webBasePath(socket);
      const code = await fetchStatus(LOOPBACK, port, base);
      if (code !== 200) problems.push(`${id}: the web client at ${base} answered ${code ?? 'nothing'}`);
    } catch (e) {
      problems.push(`${id}: cannot read the web client's path (${(e as Error).message})`);
    }
  }
  return { problems, restarted };
}

/**
 * Passes when every workspace is up on `expected`, answers the runner and serves the web client, and keeps doing so for `windowMs` after the first
 * look at which all of that held. Getting there may take `graceMs` ("not up yet" is not a failure before); a restart is a failure at once, and so is
 * any later look that fails.
 */
export async function watchHealth(cfg: UpdateConfig, deps: UpdaterDeps, expected: string, windowMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sleep = deps.sleep ?? defaultSleep;
  const poll = deps.pollMs ?? 5000;
  const grace = deps.graceMs ?? 120_000;
  const began = Date.now();
  let healthySince: number | null = null;
  for (;;) {
    const { problems, restarted } = await problemsOf(cfg, expected);
    const nowMs = Date.now();
    if (problems.length === 0) healthySince ??= nowMs;
    else if (restarted || healthySince !== null || nowMs - began >= grace) return { ok: false, reason: problems.join('; ') };
    if (healthySince !== null && nowMs - healthySince >= windowMs) return { ok: true };
    await sleep(poll);
  }
}

// --- the flows ---------------------------------------------------------------------------------------------------------------------

async function tell(cfg: UpdateConfig, deps: UpdaterDeps, text: string): Promise<void> {
  if (!cfg.notify) return;
  const ids = readWorkspaceIds(cfg.dataDir) ?? [];
  for (const id of ids) {
    const posted = await postNotice(adminSocketPath(cfg.dataDir, id), `[coxia-server] ${text}`);
    if (!posted) deps.log(`could not post the notice in workspace ${id}`);
  }
}

function record(cfg: UpdateConfig, deps: UpdaterDeps, event: UpdateEvent, r: Omit<UpdateRecord, 'at' | 'event'>): void {
  appendUpdate(cfg.stateDir, { at: (deps.now?.() ?? new Date()).toISOString(), event, ...r });
}

/** Back to a snapshot: stop, put its data back, point at the release it was taken under, start, watch. */
async function goBack(cfg: UpdateConfig, deps: UpdaterDeps, snapshot: Snapshot, failedVersion: string, trigger: UpdateRecord['trigger'], reason: string): Promise<UpdateResult> {
  const now = deps.now?.() ?? new Date();
  const to = failedVersion;
  const from = snapshot.meta.from;
  deps.log(`ROLLBACK ${to} -> ${from}: ${reason}`);
  try {
    if (!hasRelease(cfg.releasesDir, from)) throw new UpdateError(`the release ${from} is no longer on the machine`);
    await deps.stop();
    const keptData = await restoreSnapshot(snapshot, cfg.dataDir, cfg.snapshotsDir, to, now);
    swapLink(cfg.appLink, releaseDir(cfg.releasesDir, from));
    await deps.start();
    const watched = await watchHealth(cfg, deps, from, deps.rollbackWatchMs ?? 60_000);
    if (!watched.ok) throw new UpdateError(`the previous version does not come up healthy either: ${watched.reason}`);
    record(cfg, deps, 'rollback', { from: to, to: from, trigger, snapshot: snapshot.name, keptData, reason });
    deps.log(`rolled back to ${from}; the data of ${to} is kept in ${keptData}`);
    await tell(
      cfg,
      deps,
      trigger === 'manual'
        ? `Rolled back from ${to} to ${from}, with its data from before the update.`
        : `Version ${to} failed its health check (${reason}) and was rolled back to ${from} with its data from before the update.`,
    );
    return { status: 'rolled-back', from: to, to: from, reason, keptData };
  } catch (e) {
    const why = (e as Error).message;
    record(cfg, deps, 'rollback-failed', { from: to, to: from, trigger, snapshot: snapshot.name, reason: `${reason}; rollback: ${why}` });
    deps.log(`ROLLBACK FAILED: ${why}. Snapshot ${snapshot.dir} still holds the data of ${from}.`);
    return { status: 'rollback-failed', reason: why };
  }
}

/** Versions a rollback already left: the timer must not install the same failing version every few hours. `update --now` may. */
function rolledBackVersions(stateDir: string): Set<string> {
  return new Set(readUpdates(stateDir).filter((r) => r.event === 'rollback').map((r) => r.from));
}

/** `check`: say what would happen and change nothing. `force`: follow the channel even when it is off (`update --now`). */
export async function runUpdate(cfg: UpdateConfig, deps: UpdaterDeps, opts: { trigger: Trigger; check?: boolean; force?: boolean }): Promise<UpdateResult> {
  const channel = opts.force && cfg.channel === 'off' ? 'beta' : cfg.channel;
  if (channel === 'off') return { status: 'off' };
  const current = activeVersion(cfg.appLink);
  if (!current) throw new UpdateError(`${cfg.appLink} is not a link to a release folder; run the install script (it sets up the releases folder)`);
  const skip = opts.trigger === 'timer' || opts.check ? rolledBackVersions(cfg.stateDir) : new Set<string>();
  const tags = (await deps.listTags()).filter((t) => !skip.has(t.replace(/^v/, '')));
  const version = newestAfter(tags, current, channel);
  if (!version) return { status: 'up-to-date' };
  if (opts.check) return { status: 'available', version, busy: await safePoint(cfg) };

  const unlock = acquireLock(cfg.stateDir);
  try {
    // Built beside the running version, which keeps serving: only the switch below stops anything.
    if (!hasRelease(cfg.releasesDir, version)) {
      deps.log(`building ${version}`);
      try {
        await deps.build(version);
        if (!hasRelease(cfg.releasesDir, version)) throw new Error('the build did not produce the headless bundle');
      } catch (e) {
        const reason = `build of ${version} failed: ${(e as Error).message}`;
        record(cfg, deps, 'update-failed', { from: current, to: version, trigger: opts.trigger, reason });
        deps.log(reason);
        return { status: 'failed', reason };
      }
    }

    const busy = await safePoint(cfg);
    if (busy.length > 0) {
      record(cfg, deps, 'update-postponed', { from: current, to: version, trigger: opts.trigger, reason: busy.join('; ') });
      deps.log(`update to ${version} postponed, not at a safe point: ${busy.join('; ')}`);
      return { status: 'postponed', version, busy };
    }

    deps.log(`updating ${current} -> ${version}`);
    await deps.stop();
    let snapshot: Snapshot;
    try {
      snapshot = await takeSnapshot(cfg.dataDir, cfg.snapshotsDir, { from: current, to: version }, deps.now?.() ?? new Date());
    } catch (e) {
      // Nothing was changed yet: the old version comes back up as it was.
      const reason = `snapshot failed, update abandoned: ${(e as Error).message}`;
      record(cfg, deps, 'update-failed', { from: current, to: version, trigger: opts.trigger, reason });
      deps.log(reason);
      await deps.start();
      return { status: 'failed', reason };
    }

    swapLink(cfg.appLink, releaseDir(cfg.releasesDir, version));
    let failure: string | null = null;
    try {
      await deps.start();
      const watched = await watchHealth(cfg, deps, version, cfg.healthMinutes * 60_000);
      if (!watched.ok) failure = watched.reason;
    } catch (e) {
      failure = `start failed: ${(e as Error).message}`;
    }
    if (failure !== null) return await goBack(cfg, deps, snapshot, version, 'health-check', failure);

    pruneSnapshots(cfg.snapshotsDir);
    pruneReleases(cfg.releasesDir, [version, current]);
    record(cfg, deps, 'update', { from: current, to: version, trigger: opts.trigger, snapshot: snapshot.name });
    deps.log(`updated to ${version}, healthy; snapshot ${snapshot.name}`);
    await tell(cfg, deps, `Updated from ${current} to ${version}. A snapshot of the data from before the update is kept on the server.`);
    return { status: 'updated', from: current, to: version, snapshot: snapshot.name };
  } finally {
    unlock();
  }
}

/** Manual rollback: the newest snapshot, the release it was taken under, and the data as it was then. What was written since goes aside, not away. */
export async function runRollback(cfg: UpdateConfig, deps: UpdaterDeps): Promise<UpdateResult> {
  const current = activeVersion(cfg.appLink);
  if (!current) throw new UpdateError(`${cfg.appLink} is not a link to a release folder`);
  const snapshot = listSnapshots(cfg.snapshotsDir).find((s) => s.meta.to === current);
  if (!snapshot) throw new UpdateError(`no snapshot was taken for an update to ${current}; there is nothing to go back to`);
  const unlock = acquireLock(cfg.stateDir);
  try {
    return await goBack(cfg, deps, snapshot, current, 'manual', 'rollback asked for');
  } finally {
    unlock();
  }
}

