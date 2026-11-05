import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppPlan, HistoryEntry, Inventory, PlanMap, Settings, UploadDiff, UploadMeta } from '../src/lib/types.ts';

export type SharedSettings = Omit<Settings, 'currentFY'>;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        vm_count INTEGER NOT NULL,
        powered_on INTEGER NOT NULL,
        vcpu INTEGER NOT NULL,
        app_count INTEGER NOT NULL,
        cluster_count INTEGER NOT NULL,
        diff_json TEXT NOT NULL,
        inventory_json TEXT NOT NULL,
        file BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        app_key TEXT PRIMARY KEY,
        disposition TEXT NOT NULL,
        target_fy INTEGER,
        target_q INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_key TEXT NOT NULL,
        action TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        changed_by TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plan_history_app ON plan_history(app_key, id);
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- revision counter (clients poll this to pick up others' changes) ----------
  rev(): number {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = 'rev'`).get() as { value: string } | undefined;
    return r ? Number(r.value) : 0;
  }
  bump() {
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`).run();
  }

  // ---------- settings ----------
  getSettings(defaults: SharedSettings): SharedSettings {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = 'settings'`).get() as { value: string } | undefined;
    return { ...defaults, ...(r ? JSON.parse(r.value) : {}) };
  }
  saveSettings(s: SharedSettings) {
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(s));
    this.bump();
  }

  // ---------- plans ----------
  private rowToPlan(r: Record<string, unknown>): AppPlan {
    const p: AppPlan = {
      disposition: r.disposition as AppPlan['disposition'],
      version: Number(r.version),
      updatedBy: String(r.updated_by),
      updatedAt: String(r.updated_at),
    };
    if (r.target_fy != null) p.targetFY = Number(r.target_fy);
    if (r.target_q != null) p.targetQ = Number(r.target_q) as AppPlan['targetQ'];
    if (r.notes) p.notes = String(r.notes);
    return p;
  }

  getPlans(): PlanMap {
    const rows = this.db.prepare(`SELECT * FROM plans`).all() as Record<string, unknown>[];
    return Object.fromEntries(rows.map((r) => [String(r.app_key), this.rowToPlan(r)]));
  }

  getPlan(key: string): AppPlan | null {
    const r = this.db.prepare(`SELECT * FROM plans WHERE app_key = ?`).get(key) as Record<string, unknown> | undefined;
    return r ? this.rowToPlan(r) : null;
  }

  /** Upsert one plan and record history. Returns the stored plan. */
  writePlan(key: string, next: Pick<AppPlan, 'disposition' | 'targetFY' | 'targetQ' | 'notes'>, user: string, action: HistoryEntry['action']): AppPlan {
    const before = this.getPlan(key);
    const now = new Date().toISOString();
    const clean = {
      disposition: next.disposition,
      targetFY: next.targetFY ?? null,
      targetQ: next.targetFY ? (next.targetQ ?? 4) : null,
      notes: next.notes ?? '',
    };
    const same =
      before &&
      before.disposition === clean.disposition &&
      (before.targetFY ?? null) === clean.targetFY &&
      (before.targetQ ?? null) === clean.targetQ &&
      (before.notes ?? '') === clean.notes;
    if (same) return before;
    this.db
      .prepare(
        `INSERT INTO plans(app_key, disposition, target_fy, target_q, notes, version, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(app_key) DO UPDATE SET disposition = excluded.disposition, target_fy = excluded.target_fy,
           target_q = excluded.target_q, notes = excluded.notes, version = plans.version + 1,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, clean.disposition, clean.targetFY, clean.targetQ, clean.notes, user, now);
    const after = this.getPlan(key)!;
    this.addHistory(key, action, before && strip(before), strip(after), user, now);
    this.bump();
    return after;
  }

  renamePlan(from: string, to: string, user: string) {
    const p = this.getPlan(from);
    if (!p) throw new Error('No decision exists for the old application name');
    if (this.getPlan(to)) throw new Error('The new application already has a decision');
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE plans SET app_key = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE app_key = ?`).run(to, user, now, from);
    this.db.prepare(`UPDATE plan_history SET app_key = ? WHERE app_key = ?`).run(to, from);
    this.addHistory(to, 'rename', { notes: `renamed from: ${from}` } as Partial<AppPlan>, strip(this.getPlan(to)!), user, now);
    this.bump();
  }

  private addHistory(key: string, action: string, before: unknown, after: unknown, user: string, at: string) {
    this.db
      .prepare(`INSERT INTO plan_history(app_key, action, before_json, after_json, changed_by, changed_at) VALUES(?, ?, ?, ?, ?, ?)`)
      .run(key, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, user, at);
  }

  history(opts: { appKey?: string; limit?: number }): HistoryEntry[] {
    const limit = Math.min(opts.limit ?? 200, 5000);
    const rows = (
      opts.appKey
        ? this.db.prepare(`SELECT * FROM plan_history WHERE app_key = ? ORDER BY id DESC LIMIT ?`).all(opts.appKey, limit)
        : this.db.prepare(`SELECT * FROM plan_history ORDER BY id DESC LIMIT ?`).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      appKey: String(r.app_key),
      action: r.action as HistoryEntry['action'],
      before: r.before_json ? JSON.parse(String(r.before_json)) : null,
      after: r.after_json ? JSON.parse(String(r.after_json)) : null,
      changedBy: String(r.changed_by),
      changedAt: String(r.changed_at),
    }));
  }

  // ---------- uploads ----------
  private rowToUpload(r: Record<string, unknown>): UploadMeta {
    return {
      id: Number(r.id),
      filename: String(r.filename),
      uploadedBy: String(r.uploaded_by),
      uploadedAt: String(r.uploaded_at),
      note: String(r.note ?? ''),
      vmCount: Number(r.vm_count),
      poweredOn: Number(r.powered_on),
      vcpu: Number(r.vcpu),
      appCount: Number(r.app_count),
      clusterCount: Number(r.cluster_count),
      diff: JSON.parse(String(r.diff_json)) as UploadDiff,
    };
  }

  listUploads(): UploadMeta[] {
    const rows = this.db
      .prepare(`SELECT id, filename, uploaded_by, uploaded_at, note, vm_count, powered_on, vcpu, app_count, cluster_count, diff_json FROM uploads ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToUpload(r));
  }

  latestUploadId(): number | null {
    const r = this.db.prepare(`SELECT MAX(id) AS id FROM uploads`).get() as { id: number | null };
    return r.id ?? null;
  }

  getInventory(id: number): Inventory | null {
    const r = this.db.prepare(`SELECT id, filename, uploaded_by, uploaded_at, inventory_json FROM uploads WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const inv = JSON.parse(String(r.inventory_json)) as Inventory;
    return { ...inv, uploadId: Number(r.id), sourceFile: String(r.filename), uploadedBy: String(r.uploaded_by), loadedAt: String(r.uploaded_at), isDemo: false };
  }

  getUploadFile(id: number): { filename: string; file: Uint8Array } | null {
    const r = this.db.prepare(`SELECT filename, file FROM uploads WHERE id = ?`).get(id) as { filename: string; file: Uint8Array } | undefined;
    return r ?? null;
  }

  findBySha(sha: string): number | null {
    const r = this.db.prepare(`SELECT id FROM uploads WHERE sha256 = ? ORDER BY id DESC LIMIT 1`).get(sha) as { id: number } | undefined;
    return r?.id ?? null;
  }

  addUpload(u: Omit<UploadMeta, 'id'> & { sha256: string; inventory: Inventory; file: Uint8Array }): number {
    const { vms, clusters } = u.inventory;
    const res = this.db
      .prepare(
        `INSERT INTO uploads(filename, uploaded_by, uploaded_at, note, sha256, vm_count, powered_on, vcpu, app_count, cluster_count, diff_json, inventory_json, file)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.filename, u.uploadedBy, u.uploadedAt, u.note, u.sha256, u.vmCount, u.poweredOn, u.vcpu, u.appCount, u.clusterCount,
        JSON.stringify(u.diff), JSON.stringify({ vms, clusters }), u.file);
    this.bump();
    return Number(res.lastInsertRowid);
  }
}

function strip(p: AppPlan): Partial<AppPlan> {
  const { disposition, targetFY, targetQ, notes } = p;
  return { disposition, targetFY, targetQ, notes };
}
