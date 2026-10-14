// Snapshots of the data folder: <snapshots>/<timestamp>-<fromVersion>/{data,meta.json}. `cp -a` keeps owners, modes (secrets.json stays 0600) and times.
// The master key is not in the data folder and is not copied. A data folder set aside by a rollback goes to <timestamp>-failed-<version> and is never pruned:
// it is the person's data.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const KEEP_SNAPSHOTS = 2;

export interface SnapshotMeta {
  from: string;
  to: string;
  createdAt: string;
}

export interface Snapshot {
  name: string;
  dir: string;
  meta: SnapshotMeta;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function copyTree(from: string, to: string): Promise<void> {
  await run('cp', ['-a', '--reflink=auto', from, to]);
}

/** Bytes under a folder (links not followed). */
export function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(path);
    else total += lstatSync(path).size;
  }
  return total;
}

/** A copy that does not fit must not start: a half-written snapshot is worse than none. */
function assertRoom(dataDir: string, snapshotsDir: string): void {
  const need = treeBytes(dataDir);
  const fs = statfsSync(snapshotsDir);
  const free = fs.bavail * fs.bsize;
  if (free < need * 1.1 + 1024 * 1024) throw new Error(`not enough room for a snapshot in ${snapshotsDir}: ${need} bytes of data, ${free} free`);
}

/** Copies the whole data folder. The caller has stopped the cores. Removes what it wrote if the copy fails. */
export async function takeSnapshot(dataDir: string, snapshotsDir: string, meta: Omit<SnapshotMeta, 'createdAt'>, now: Date): Promise<Snapshot> {
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o750 });
  assertRoom(dataDir, snapshotsDir);
  const name = `${stamp(now)}-${meta.from}`;
  const dir = join(snapshotsDir, name);
  try {
    mkdirSync(dir, { mode: 0o755 });
    await copyTree(dataDir, join(dir, 'data'));
    const full: SnapshotMeta = { ...meta, createdAt: now.toISOString() };
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`, { mode: 0o644 });
    return { name, dir, meta: full };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Snapshots on the machine, newest first. A folder without a readable meta.json (or a failed-data folder) is not one. */
export function listSnapshots(snapshotsDir: string): Snapshot[] {
  if (!existsSync(snapshotsDir)) return [];
  const out: Snapshot[] = [];
  for (const name of readdirSync(snapshotsDir)) {
    if (name.includes('-failed-')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(snapshotsDir, name, 'meta.json'), 'utf8')) as SnapshotMeta;
      if (typeof meta.from === 'string' && typeof meta.to === 'string' && existsSync(join(snapshotsDir, name, 'data'))) out.push({ name, dir: join(snapshotsDir, name), meta });
    } catch {
      // not a snapshot
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** The data folders that rollbacks set aside, by name. */
export function listFailedData(snapshotsDir: string): string[] {
  return existsSync(snapshotsDir) ? readdirSync(snapshotsDir).filter((n) => n.includes('-failed-')).sort() : [];
}

/** Keeps the newest `keep`; returns the names removed. */
export function pruneSnapshots(snapshotsDir: string, keep = KEEP_SNAPSHOTS): string[] {
  const removed: string[] = [];
  for (const s of listSnapshots(snapshotsDir).slice(keep)) {
    rmSync(s.dir, { recursive: true, force: true });
    removed.push(s.name);
  }
  return removed;
}

/**
 * Puts a snapshot's data back. The copy is made beside the data folder first and the swap is two renames, so a failure leaves the folder as it was.
 * What was there is moved to <snapshots>/<timestamp>-failed-<version>/data, not deleted. Returns that path.
 */
export async function restoreSnapshot(snapshot: Snapshot, dataDir: string, snapshotsDir: string, failedVersion: string, now: Date): Promise<string> {
  const staging = `${dataDir}.restoring`;
  const aside = join(snapshotsDir, `${stamp(now)}-failed-${failedVersion}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    await copyTree(join(snapshot.dir, 'data'), staging);
    mkdirSync(aside, { recursive: true, mode: 0o755 });
    renameSync(dataDir, join(aside, 'data'));
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  renameSync(staging, dataDir);
  return join(aside, 'data');
}
