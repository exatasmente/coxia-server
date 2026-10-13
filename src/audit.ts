// <state>/updates.jsonl: one line per thing the updater did or declined to do. Mode 0644 so `coxia-server status` (the service user) can read what root wrote.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATES_FILE = 'updates.jsonl';

export type UpdateEvent = 'update' | 'update-failed' | 'update-postponed' | 'rollback' | 'rollback-failed';

export interface UpdateRecord {
  at: string;
  event: UpdateEvent;
  from: string;
  to: string;
  /** What started it. */
  trigger: 'timer' | 'manual' | 'health-check';
  snapshot?: string;
  /** The data folder a rollback set aside. */
  keptData?: string;
  reason?: string;
}

export function appendUpdate(stateDir: string, record: UpdateRecord): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(stateDir, UPDATES_FILE), `${JSON.stringify(record)}\n`, { mode: 0o644 });
}

export function readUpdates(stateDir: string): UpdateRecord[] {
  try {
    return readFileSync(join(stateDir, UPDATES_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UpdateRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
