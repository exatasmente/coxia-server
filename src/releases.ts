// Releases side by side: every version is built into <releases>/<version>, and the app link (what the supervisor runs the core through) points at the
// active one. Switching versions is a swap of that link plus a supervisor restart.
import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Channel } from './config.ts';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** What a release folder may be called: a version, never a path. */
export const VERSION_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function parseSemver(text: string): Semver | null {
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const isNum = (s: string): boolean => /^\d+$/.test(s);

/** Semver precedence: a prerelease sorts below its release, numeric identifiers below alphanumeric ones. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNum(x) && isNum(y)) return Number(x) < Number(y) ? -1 : 1;
    if (isNum(x) !== isNum(y)) return isNum(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The newest version above `current` that the channel follows: beta takes every release and prerelease, stable only releases. null: nothing newer. */
export function newestAfter(tags: readonly string[], current: string, channel: Channel): string | null {
  if (channel === 'off') return null;
  const cur = parseSemver(current);
  let best: { version: string; sv: Semver } | null = null;
  for (const tag of tags) {
    const sv = parseSemver(tag);
    if (!sv || (channel === 'stable' && sv.pre.length > 0)) continue;
    if (cur && compareSemver(sv, cur) <= 0) continue;
    if (!best || compareSemver(sv, best.sv) > 0) best = { version: tag.replace(/^v/, ''), sv };
  }
  return best?.version ?? null;
}

/** The tag names in `git ls-remote --tags --refs` output. */
export function tagsOf(lsRemote: string): string[] {
  return lsRemote
    .split('\n')
    .map((line) => /\trefs\/tags\/(\S+)$/.exec(line)?.[1])
    .filter((t): t is string => t !== undefined);
}

/** The version the app link points at (the name of its release folder); null when it is not a link into the releases folder. */
export function activeVersion(appLink: string): string | null {
  try {
    if (!lstatSync(appLink).isSymbolicLink()) return null;
    const name = basename(resolve(dirname(appLink), readlinkSync(appLink)));
    return VERSION_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

export const releaseDir = (releasesDir: string, version: string): string => join(releasesDir, version);
export const hasRelease = (releasesDir: string, version: string): boolean => VERSION_NAME.test(version) && existsSync(join(releasesDir, version, 'out', 'headless', 'coxia.mjs'));

/** Points the app link at a release, atomically: a link made beside it replaces it by rename, so there is no moment without one. */
export function swapLink(appLink: string, target: string): void {
  const tmp = `${appLink}.new-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, appLink);
}

/** Removes every release folder but the ones named (the active and the previous one). */
export function pruneReleases(releasesDir: string, keep: readonly string[]): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(releasesDir)) {
    if (keep.includes(name) || !VERSION_NAME.test(name)) continue;
    rmSync(join(releasesDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
