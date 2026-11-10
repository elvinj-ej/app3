import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppPlan, AppRule, HistoryEntry, Inventory, PlanMap, Settings, UploadDiff, UploadMeta } from '../src/lib/types.ts';

export type SharedSettings = Omit<Settings, 'currentFY'>;

export const SCHEMA_VERSION = 6;

export class Store {
  db: DatabaseSync;
  path: string;
  existed: boolean;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path) && statSync(path).size > 0;
    this.db = new DatabaseSync(path);
    this.path = path;
    this.existed = existed;
    this.db.exec(`
      PRAGMA journal_mode = DELETE; -- single self-contained file: safe to copy for backup at any time
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
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
    this.migrate();
  }

  /** Additive, data-preserving schema upgrades. A copy of the database is saved before any change. */
  private migrate() {
    const cur = Number((this.db.prepare(`SELECT value FROM kv WHERE key = 'schema'`).get() as { value: string } | undefined)?.value ?? 1);
    if (cur >= SCHEMA_VERSION) return;
    const cols = (this.db.prepare(`PRAGMA table_info(plans)`).all() as { name: string }[]).map((c) => c.name);
    // Additive columns only – existing rows keep every value.
    const add: [string, string][] = ([['confidence', 'TEXT'], ['review_fy', 'INTEGER'], ['review_q', 'INTEGER']] as [string, string][]).filter(([c]) => !cols.includes(c));
    const hasRules = !!this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_rules'`).get();
    const ruleCols = hasRules ? (this.db.prepare(`PRAGMA table_info(app_rules)`).all() as { name: string }[]).map((c) => c.name) : [];
    const needCompCol = hasRules && !ruleCols.includes('keep_components');
    const upCols = (this.db.prepare(`PRAGMA table_info(uploads)`).all() as { name: string }[]).map((c) => c.name);
    const upAdd: [string, string][] = ([['status', "TEXT NOT NULL DEFAULT 'confirmed'"], ['confirmed_by', 'TEXT'], ['confirmed_at', 'TEXT'], ['base_upload_id', 'INTEGER'], ['report_json', 'TEXT']] as [string, string][]).filter(([c]) => !upCols.includes(c));
    if ((add.length || !hasRules || needCompCol || upAdd.length) && this.existed) {
      const dir = join(dirname(this.path), 'backups');
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `footprint-before-schema${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      copyFileSync(this.path, dest);
      console.log(`  Database upgraded – previous version backed up to ${dest}`);
    }
    this.tx(() => {
      for (const [c, t] of add) this.db.exec(`ALTER TABLE plans ADD COLUMN ${c} ${t}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS app_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        keep_components INTEGER NOT NULL DEFAULT 0,
        UNIQUE(kind, source)
      )`);
      if (needCompCol) this.db.exec(`ALTER TABLE app_rules ADD COLUMN keep_components INTEGER NOT NULL DEFAULT 0`);
      // Existing uploads were made current immediately in earlier versions: they count as confirmed by their uploader.
      for (const [c, t] of upAdd) this.db.exec(`ALTER TABLE uploads ADD COLUMN ${c} ${t}`);
      if (upAdd.some(([c]) => c === 'confirmed_by')) this.db.exec(`UPDATE uploads SET confirmed_by = uploaded_by, confirmed_at = uploaded_at WHERE confirmed_by IS NULL`);
      this.db.prepare(`INSERT INTO kv(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    });
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
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
    if (r.confidence) p.confidence = String(r.confidence) as AppPlan['confidence'];
    if (r.review_fy != null) p.reviewFY = Number(r.review_fy);
    if (r.review_q != null) p.reviewQ = Number(r.review_q) as AppPlan['reviewQ'];
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
  writePlan(key: string, next: Pick<AppPlan, 'disposition' | 'targetFY' | 'targetQ' | 'notes' | 'confidence' | 'reviewFY' | 'reviewQ'>, user: string, action: HistoryEntry['action']): AppPlan {
    const before = this.getPlan(key);
    const now = new Date().toISOString();
    const clean = {
      disposition: next.disposition,
      targetFY: next.targetFY ?? null,
      targetQ: next.targetFY ? (next.targetQ ?? 4) : null,
      notes: next.notes ?? '',
      confidence: next.confidence ?? null,
      reviewFY: next.reviewFY ?? null,
      reviewQ: next.reviewFY ? (next.reviewQ ?? 4) : null,
    };
    const same =
      before &&
      before.disposition === clean.disposition &&
      (before.targetFY ?? null) === clean.targetFY &&
      (before.targetQ ?? null) === clean.targetQ &&
      (before.notes ?? '') === clean.notes &&
      (before.confidence ?? null) === clean.confidence &&
      (before.reviewFY ?? null) === clean.reviewFY &&
      (before.reviewQ ?? null) === clean.reviewQ;
    if (same) return before;
    this.db
      .prepare(
        `INSERT INTO plans(app_key, disposition, target_fy, target_q, notes, confidence, review_fy, review_q, version, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(app_key) DO UPDATE SET disposition = excluded.disposition, target_fy = excluded.target_fy,
           target_q = excluded.target_q, notes = excluded.notes, confidence = excluded.confidence, review_fy = excluded.review_fy, review_q = excluded.review_q, version = plans.version + 1,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, clean.disposition, clean.targetFY, clean.targetQ, clean.notes, clean.confidence, clean.reviewFY, clean.reviewQ, user, now);
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

  hasFlag(key: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(key);
  }
  setFlag(key: string) {
    this.db.prepare(`INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, new Date().toISOString());
  }

  /** Copy the database file to data/backups before a data-changing upgrade step. */
  backup(tag: string): string {
    const dir = join(dirname(this.path), 'backups');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `footprint-before-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    copyFileSync(this.path, dest);
    return dest;
  }

  uploadIds(): number[] {
    return (this.db.prepare(`SELECT id FROM uploads ORDER BY id`).all() as { id: number }[]).map((r) => Number(r.id));
  }

  /** Replace the stored (parsed) inventory of an upload – used to add newly supported columns from the original file. */
  replaceInventory(id: number, inv: { vms: unknown[]; clusters: unknown[] }) {
    this.db.prepare(`UPDATE uploads SET inventory_json = ? WHERE id = ?`).run(JSON.stringify({ vms: inv.vms, clusters: inv.clusters }), id);
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('inv_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`).run();
    this.bump();
  }

  /** Team banner after an inventory change: shown to everyone until someone marks it handled. */
  attention(): { uploadId: number; by: string; at: string; count: number; revert?: boolean } | null {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = 'attention'`).get() as { value: string } | undefined;
    if (!r) return null;
    const a = JSON.parse(r.value);
    return a.cleared ? null : a;
  }
  setAttention(a: { uploadId: number; by: string; at: string; count: number; revert?: boolean }) {
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('attention', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(a));
    this.bump();
  }
  clearAttention(user: string) {
    const a = this.attention();
    if (!a) return;
    this.db.prepare(`UPDATE kv SET value = ? WHERE key = 'attention'`).run(JSON.stringify({ ...a, cleared: true, clearedBy: user, clearedAt: new Date().toISOString() }));
    this.bump();
  }

  /** Record a non-decision event (e.g. a settings change) in the Activity log. */
  logEvent(subject: string, text: string, user: string, action: 'setting' | 'inventory' = 'setting') {
    this.addHistory(subject, action, null, { notes: text }, user, new Date().toISOString());
  }

  /** Remove a decision (kept in the change history). */
  deletePlan(key: string, user: string) {
    const before = this.getPlan(key);
    if (!before) return;
    this.db.prepare(`DELETE FROM plans WHERE app_key = ?`).run(key);
    this.addHistory(key, 'delete', strip(before), null, user, new Date().toISOString());
    this.bump();
  }

  // ---------- application mapping rules ----------
  listRules(): AppRule[] {
    const rows = this.db.prepare(`SELECT * FROM app_rules ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id), kind: r.kind as AppRule['kind'], source: String(r.source), target: String(r.target), components: Number(r.keep_components ?? 0) === 1,
      note: String(r.note ?? ''), createdBy: String(r.created_by), createdAt: String(r.created_at),
    }));
  }

  rulesRev(): string {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM app_rules`).get() as { n: number; m: number };
    const inv = this.db.prepare(`SELECT value FROM kv WHERE key = 'inv_rev'`).get() as { value: string } | undefined;
    return `${r.n}.${r.m}.${inv?.value ?? 0}`;
  }

  /**
   * Add a rule. For merges, decisions are never lost: a decision that only exists on the source moves to the target;
   * when both exist, `keep` picks which one the target ends up with ('target' leaves the source's decision in place
   * as an unmatched decision unless discardSource is set).
   */
  addRule(rule: Omit<AppRule, 'id' | 'createdAt'>, opts: { keep?: 'target' | 'source'; discardSource?: boolean } = {}): AppRule {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(`INSERT INTO app_rules(kind, source, target, note, created_by, created_at, keep_components) VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(rule.kind, rule.source, rule.target, rule.note, rule.createdBy, now, rule.kind === 'merge' && rule.components ? 1 : 0);
    const label = rule.kind === 'merge' ? `Merged “${rule.source}” into this application${rule.components ? ' (kept as a component)' : ''}` : `VM ${rule.source} assigned to this application`;
    this.addHistory(rule.target, 'rule', null, { notes: `${label}${rule.note ? ` – ${rule.note}` : ''}` }, rule.createdBy, now);
    if (rule.kind === 'merge') {
      const src = this.getPlan(rule.source);
      const tgt = this.getPlan(rule.target);
      if (src && !tgt) this.renamePlan(rule.source, rule.target, rule.createdBy);
      else if (src && tgt) {
        if (opts.keep === 'source') {
          this.writePlan(rule.target, { disposition: src.disposition, targetFY: src.targetFY, targetQ: src.targetQ, notes: src.notes, confidence: src.confidence, reviewFY: src.reviewFY, reviewQ: src.reviewQ }, rule.createdBy, 'rule');
          this.deletePlan(rule.source, rule.createdBy);
        } else if (opts.discardSource) this.deletePlan(rule.source, rule.createdBy);
      }
    }
    this.bump();
    return this.listRules().find((r) => r.id === Number(res.lastInsertRowid))!;
  }

  setRuleComponents(id: number, on: boolean, user: string) {
    const r = this.listRules().find((x) => x.id === id);
    if (!r || r.kind !== 'merge') return;
    this.db.prepare(`UPDATE app_rules SET keep_components = ? WHERE id = ?`).run(on ? 1 : 0, id);
    this.addHistory(r.target, 'rule', null, { notes: `“${r.source}” ${on ? 'now shown as a component' : 'no longer shown as a component'}` }, user, new Date().toISOString());
    this.bump();
  }

  deleteRule(id: number, user: string) {
    const r = this.listRules().find((x) => x.id === id);
    if (!r) return;
    this.db.prepare(`DELETE FROM app_rules WHERE id = ?`).run(id);
    const label = r.kind === 'merge' ? `Removed merge of “${r.source}” into this application` : `Removed assignment of VM ${r.source} to this application`;
    this.addHistory(r.target, 'rule', null, { notes: label }, user, new Date().toISOString());
    this.bump();
  }

  /** One-time setup of rules agreed with the owner; skipped if already applied once (even if later removed). */
  seedRules(key: string, rules: Omit<AppRule, 'id' | 'createdAt'>[]) {
    if (this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key)) return 0;
    if (this.existed && this.latestUploadId()) console.log(`  Backup before mapping setup: ${this.backup(key)}`);
    let n = 0;
    this.tx(() => {
      for (const r of rules) {
        const exists = this.db.prepare(`SELECT id FROM app_rules WHERE kind = ? AND source = ?`).get(r.kind, r.source);
        if (!exists) {
          this.addRule(r);
          n++;
        }
      }
      this.db.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(key, new Date().toISOString());
    });
    return n;
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
      status: (r.status as UploadMeta['status']) ?? 'confirmed',
      confirmedBy: r.confirmed_by ? String(r.confirmed_by) : undefined,
      confirmedAt: r.confirmed_at ? String(r.confirmed_at) : undefined,
      baseUploadId: r.base_upload_id == null ? null : Number(r.base_upload_id),
      isCurrent: Number(r.id) === this.latestUploadId(),
      attentionCount: r.report_json ? (JSON.parse(String(r.report_json)).attentionCount as number) : undefined,
    };
  }

  listUploads(): UploadMeta[] {
    const rows = this.db
      .prepare(`SELECT id, filename, uploaded_by, uploaded_at, note, vm_count, powered_on, vcpu, app_count, cluster_count, diff_json, status, confirmed_by, confirmed_at, base_upload_id, report_json FROM uploads ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToUpload(r));
  }

  /** The upload that drives the dashboards: the one last made current, else the newest confirmed upload. */
  latestUploadId(): number | null {
    const k = this.db.prepare(`SELECT value FROM kv WHERE key = 'current_upload_id'`).get() as { value: string } | undefined;
    if (k) {
      const ok = this.db.prepare(`SELECT id FROM uploads WHERE id = ? AND status = 'confirmed'`).get(Number(k.value));
      if (ok) return Number(k.value);
    }
    const r = this.db.prepare(`SELECT MAX(id) AS id FROM uploads WHERE status = 'confirmed'`).get() as { id: number | null };
    return r.id ?? null;
  }

  uploadStatus(id: number): UploadMeta['status'] | null {
    const r = this.db.prepare(`SELECT status FROM uploads WHERE id = ?`).get(id) as { status: string } | undefined;
    return (r?.status as UploadMeta['status']) ?? null;
  }

  /** Make an upload the current inventory (confirming a staged one, or reverting to an earlier one). */
  makeCurrent(id: number, user: string) {
    const st = this.uploadStatus(id);
    const now = new Date().toISOString();
    if (st === 'staged') this.db.prepare(`UPDATE uploads SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?`).run(user, now, id);
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('current_upload_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(id));
    this.db.prepare(`INSERT INTO kv(key, value) VALUES('inv_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`).run();
    this.bump();
  }

  discardUpload(id: number) {
    this.db.prepare(`UPDATE uploads SET status = 'discarded' WHERE id = ? AND status = 'staged'`).run(id);
    this.bump();
  }

  saveReport(id: number, report: unknown) {
    this.db.prepare(`UPDATE uploads SET report_json = ? WHERE id = ?`).run(JSON.stringify(report), id);
  }

  getReport(id: number): unknown | null {
    const r = this.db.prepare(`SELECT report_json FROM uploads WHERE id = ?`).get(id) as { report_json: string | null } | undefined;
    return r?.report_json ? JSON.parse(r.report_json) : null;
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
        `INSERT INTO uploads(filename, uploaded_by, uploaded_at, note, sha256, vm_count, powered_on, vcpu, app_count, cluster_count, diff_json, inventory_json, file, status, base_upload_id)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.filename, u.uploadedBy, u.uploadedAt, u.note, u.sha256, u.vmCount, u.poweredOn, u.vcpu, u.appCount, u.clusterCount,
        JSON.stringify(u.diff), JSON.stringify({ vms, clusters }), u.file, u.status ?? 'staged', u.baseUploadId ?? null);
    this.bump();
    return Number(res.lastInsertRowid);
  }
}

function strip(p: AppPlan): Partial<AppPlan> {
  const { disposition, targetFY, targetQ, notes, confidence, reviewFY, reviewQ } = p;
  return { disposition, targetFY, targetQ, notes, confidence, reviewFY, reviewQ };
}
