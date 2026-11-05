import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import readExcelFile from 'read-excel-file/universal';
import { Store, type SharedSettings } from './db.ts';
import { buildTreatmentWorkbook } from './export.ts';
import { inventoryFromSheets, parsedDomain, setDomainOverrides } from '../src/lib/parse.ts';
import { defaultSettings } from '../src/lib/defaults.ts';
import { DISPOSITIONS } from '../src/lib/dispositions.ts';
import { fyOf } from '../src/lib/fy.ts';
import { applyRules } from '../src/lib/rules.ts';
import { NO_APP } from '../src/lib/parse.ts';
import type { AppPlan, Disposition, Inventory, Settings, UploadDiff } from '../src/lib/types.ts';

// ---------- config ----------
const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(argVal('port') ?? process.env.PORT ?? 9080);
const HOST = argVal('host') ?? process.env.HOST ?? '0.0.0.0';
// Release package: server.mjs sits next to app/ and data/. Source checkout: use ./dist and ./data.
const isRelease = existsSync(join(here, 'app', 'index.html'));
const baseDir = isRelease ? here : process.cwd();
const DB_PATH = resolve(argVal('db') ?? process.env.DB_PATH ?? join(baseDir, 'data', 'footprint.db'));
const STATIC_DIR = [join(here, 'app'), join(process.cwd(), 'dist'), join(here, '..', 'dist')].find((d) => existsSync(join(d, 'index.html')));

const store = new Store(DB_PATH);

// Application mapping rules agreed with the owner (Nov 2026). Applied once; later edits happen in the app.
const SEED_BY = 'Setup (agreed mapping, Nov 2026)';
const SAP = 'SAP (CSV) - Tier1 - SCC (ERP)';
const seeded = store.seedRules('seed_rules_2026_11', [
  { kind: 'merge', source: 'SAP (CSV) - Tier1 - SCC (ERP specific to Brisbane)', target: SAP, note: 'Combine SAP applications', createdBy: SEED_BY },
  { kind: 'vm', source: 'cbo-saptestvm01', target: SAP, note: 'Untagged SAP test VM', createdBy: SEED_BY },
  { kind: 'merge', source: 'Ysoft - Tier3 - ISD (Print Services)', target: 'Ysoft - Tier0 - ISD (Print Services)', note: 'Combine Ysoft applications', createdBy: SEED_BY },
  { kind: 'merge', source: 'JAMA (CSV) - Tier3 - R&D (Requirement mgmt.)', target: 'JAMA (CSV) - Tier3 - R&D (Requirement Management)', note: 'Combine JAMA applications', createdBy: SEED_BY },
  { kind: 'merge', source: 'AuditBase - TierX - SCC (For EUC team)', target: 'AuditBase - TierX - ISD (Auditabase tool)', note: 'Combine AuditBase applications', createdBy: SEED_BY },
  { kind: 'merge', source: 'VIVA - TierX - SCC (Reimbursement Application Services)', target: 'VIVA (reinburcement Germany) - TierX - SCC (Viva application)', note: 'Combine VIVA applications', createdBy: SEED_BY },
]);
if (seeded) console.log(`  Added ${seeded} application mapping rules`);

// v2.6 one-time setup agreed with the owner: two virtualization-platform applications and two domain corrections.
if (!store.hasFlag('seed_v26')) {
  const VIRT = ['Hosting_vSpere VMWare - Tier0 - ISD (Virtualization Services)', 'Hosting_HyperFlex - Tier0 - ISD (Compute Hosting Services)'];
  const DOMAINS: Record<string, string> = {
    'Nucleus - Tier1 - ISD (Web content management)': 'R&D',
    'HP_Quality Center (CSV) - Tier3 - ISD (Application test mgmt.)': 'SCC',
  };
  if (store.existed) console.log(`  Backup before v2.6 setup: ${store.backup('v26-setup')}`);
  store.tx(() => {
    for (const k of VIRT) store.writePlan(k, { disposition: 'virt_resource' }, SEED_BY, 'update');
    const cur = store.getSettings(sharedDefaults());
    const overrides = { ...(cur.domainOverrides ?? {}) };
    for (const [k, d] of Object.entries(DOMAINS)) {
      if (overrides[k]) continue;
      overrides[k] = d;
      store.logEvent(k, `Domain set to ${d} (was ${parsedDomain(k)} in VMInfo)`, SEED_BY);
    }
    store.saveSettings({ ...cur, domainOverrides: overrides });
    store.setFlag('seed_v26');
  });
  console.log('  Set 2 Virtualization Resource applications and 2 domain corrections');
}

/** Inventory as the app sees it: the uploaded file with mapping rules applied. */
function mappedInventory(id: number): Inventory | null {
  const inv = store.getInventory(id);
  return inv ? applyRules(inv, store.listRules()).inventory : null;
}
const VALID_DISP = new Set<Disposition>(DISPOSITIONS.map((d) => d.id));

function sharedDefaults(): SharedSettings {
  const { currentFY: _c, ...rest } = defaultSettings();
  void _c;
  return rest;
}
function fullSettings(): Settings {
  const s = { ...store.getSettings(sharedDefaults()), currentFY: fyOf(new Date()) };
  setDomainOverrides(s.domainOverrides);
  return s;
}
function userOf(req: Request): string {
  const raw = req.header('x-user');
  let u = '';
  try {
    u = raw ? decodeURIComponent(raw) : '';
  } catch {
    u = raw ?? '';
  }
  u = u.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  return u || 'Anonymous';
}

class HttpError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const VALID_CONF = new Set(['high', 'medium', 'low', 'unknown']);

function cleanPlan(input: Partial<AppPlan>): Pick<AppPlan, 'disposition' | 'targetFY' | 'targetQ' | 'notes' | 'confidence' | 'reviewFY' | 'reviewQ'> {
  const disposition = (input.disposition ?? 'tbd') as Disposition;
  if (!VALID_DISP.has(disposition)) throw new HttpError(400, `Unknown disposition: ${disposition}`);
  let targetFY: number | undefined = input.targetFY == null ? undefined : Number(input.targetFY);
  if (targetFY !== undefined && (!Number.isInteger(targetFY) || targetFY < 20 || targetFY > 99)) throw new HttpError(400, 'targetFY must be a 2-digit FY number');
  let targetQ = input.targetQ == null ? undefined : (Number(input.targetQ) as AppPlan['targetQ']);
  if (targetQ !== undefined && ![1, 2, 3, 4].includes(targetQ)) throw new HttpError(400, 'targetQ must be 1-4');
  const keep = DISPOSITIONS.find((d) => d.id === disposition)!.leavesOnPrem;
  if (!keep) {
    targetFY = undefined;
    targetQ = undefined;
  }
  const notes = String(input.notes ?? '').slice(0, 4000);
  let confidence = input.confidence ? String(input.confidence) as AppPlan['confidence'] : undefined;
  if (confidence && !VALID_CONF.has(confidence)) throw new HttpError(400, `Unknown confidence: ${confidence}`);
  if (!keep) confidence = undefined;
  // Review-by quarter: only for applications that stay on-prem.
  const retains = DISPOSITIONS.find((d) => d.id === disposition)!.group === 'Retain';
  let reviewFY: number | undefined = input.reviewFY == null ? undefined : Number(input.reviewFY);
  if (reviewFY !== undefined && (!Number.isInteger(reviewFY) || reviewFY < 20 || reviewFY > 99)) throw new HttpError(400, 'reviewFY must be a 2-digit FY number');
  let reviewQ = input.reviewQ == null ? undefined : (Number(input.reviewQ) as AppPlan['reviewQ']);
  if (reviewQ !== undefined && ![1, 2, 3, 4].includes(reviewQ)) throw new HttpError(400, 'reviewQ must be 1-4');
  if (!retains) {
    reviewFY = undefined;
    reviewQ = undefined;
  }
  return { disposition, targetFY, targetQ: targetFY ? (targetQ ?? 4) : undefined, notes, confidence, reviewFY, reviewQ: reviewFY ? (reviewQ ?? 4) : undefined };
}

function appTotals(inv: Inventory | null) {
  const m = new Map<string, { vms: number; vcpu: number }>();
  for (const v of inv?.vms ?? []) {
    const r = m.get(v.appKey) ?? { vms: 0, vcpu: 0 };
    r.vms++;
    r.vcpu += v.vcpu;
    m.set(v.appKey, r);
  }
  return m;
}

function diffInventories(prev: Inventory | null, next: Inventory): UploadDiff {
  const plans = store.getPlans();
  const pa = appTotals(prev);
  const na = appTotals(next);
  const pv = new Set((prev?.vms ?? []).map((v) => v.name));
  const nv = new Set(next.vms.map((v) => v.name));
  const sum = (inv: Inventory | null) => (inv?.vms ?? []).reduce((s, v) => s + v.vcpu, 0);
  return {
    previousUploadId: prev?.uploadId ?? null,
    vmDelta: next.vms.length - (prev?.vms.length ?? 0),
    vcpuDelta: sum(next) - sum(prev),
    vmsAdded: prev ? [...nv].filter((n) => !pv.has(n)).sort() : [],
    vmsRemoved: [...pv].filter((n) => !nv.has(n)).sort(),
    appsAdded: prev ? [...na.entries()].filter(([k]) => !pa.has(k)).map(([key, t]) => ({ key, ...t })).sort((a, b) => b.vcpu - a.vcpu) : [],
    appsRemoved: [...pa.entries()].filter(([k]) => !na.has(k)).map(([key, t]) => ({ key, ...t, hadDecision: !!plans[key] })).sort((a, b) => b.vcpu - a.vcpu),
  };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const api = express.Router();
api.use(express.json({ limit: '5mb' }));
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

api.get('/health', (_req, res) => res.json({ ok: true }));
api.get('/rev', (_req, res) => res.json({ rev: store.rev() }));

api.get('/state', (_req, res) => {
  const uploads = store.listUploads();
  res.json({ rev: store.rev(), settings: fullSettings(), plans: store.getPlans(), latestUpload: uploads[0] ?? null, uploadCount: uploads.length, rulesRev: store.rulesRev() });
});

api.get('/inventory/latest', (_req, res) => {
  const id = store.latestUploadId();
  if (!id) return res.status(204).end();
  res.json(mappedInventory(id));
});
api.get('/inventory/:id', (req, res) => {
  const inv = mappedInventory(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

api.put('/plans', wrap((req, res) => {
  const { key, plan, baseVersion } = req.body ?? {};
  if (typeof key !== 'string' || !key) throw new HttpError(400, 'key is required');
  const current = store.getPlan(key);
  if (typeof baseVersion === 'number' && (current?.version ?? 0) !== baseVersion) {
    throw new HttpError(409, `${current?.updatedBy ?? 'Someone'} changed this application meanwhile`, { current });
  }
  const merged = { ...(current ?? { disposition: 'tbd' }), ...(plan ?? {}) } as AppPlan;
  const saved = store.tx(() => store.writePlan(key, cleanPlan(merged), userOf(req), 'update'));
  res.json({ plan: saved, rev: store.rev() });
}));

api.post('/plans/bulk', wrap((req, res) => {
  const { keys, patch } = req.body ?? {};
  if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, 'keys is required');
  const user = userOf(req);
  const out = store.tx(() =>
    Object.fromEntries(
      keys.map((k: string) => {
        const current = store.getPlan(k) ?? { disposition: 'tbd' as Disposition };
        return [k, store.writePlan(k, cleanPlan({ ...current, ...patch }), user, 'bulk')];
      }),
    ),
  );
  res.json({ plans: out, rev: store.rev() });
}));

api.post('/plans/import', wrap((req, res) => {
  const plans = req.body?.plans;
  if (!plans || typeof plans !== 'object') throw new HttpError(400, 'plans object is required');
  const user = userOf(req);
  const n = store.tx(() => {
    let count = 0;
    for (const [k, p] of Object.entries(plans as Record<string, AppPlan>)) {
      store.writePlan(k, cleanPlan(p), user, 'import');
      count++;
    }
    return count;
  });
  res.json({ imported: n, rev: store.rev() });
}));

api.post('/plans/rename', wrap((req, res) => {
  const { from, to } = req.body ?? {};
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) throw new HttpError(400, 'from and to are required');
  try {
    store.tx(() => store.renamePlan(from, to, userOf(req)));
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  res.json({ ok: true, rev: store.rev() });
}));

// ---------- application mapping rules ----------
api.get('/rules', (_req, res) => {
  const rules = store.listRules();
  const id = store.latestUploadId();
  const inv = id ? store.getInventory(id) : null;
  const effects = inv ? applyRules(inv, rules).effects : {};
  const keys = new Set((inv?.vms ?? []).map((v) => v.appKey));
  const names = new Set((inv?.vms ?? []).map((v) => v.name.toLowerCase()));
  res.json(rules.map((r) => ({
    ...r,
    effect: effects[r.id] ?? { vms: 0, vcpu: 0 },
    sourceFound: r.kind === 'merge' ? keys.has(r.source) : names.has(r.source.toLowerCase()),
  })));
});

api.post('/rules', wrap((req, res) => {
  const { kind, source, target, note, keep } = req.body ?? {};
  if (kind !== 'merge' && kind !== 'vm') throw new HttpError(400, 'kind must be merge or vm');
  const src = String(source ?? '').trim();
  const tgt = String(target ?? '').trim();
  if (!src || !tgt) throw new HttpError(400, 'source and target are required');
  if (kind === 'merge' && src === tgt) throw new HttpError(400, 'An application cannot be merged into itself');
  if (tgt === NO_APP) throw new HttpError(400, 'Choose a real application as the target');
  const rules = store.listRules();
  if (rules.some((r) => r.kind === kind && r.source.toLowerCase() === src.toLowerCase())) throw new HttpError(409, 'A rule for this already exists – remove it first');
  if (kind === 'merge' && rules.some((r) => r.kind === 'merge' && r.source === tgt)) throw new HttpError(400, `“${tgt}” is itself merged into another application – pick that one as the target`);
  if (kind === 'merge') {
    const sp = store.getPlan(src);
    const tp = store.getPlan(tgt);
    const differs = sp && tp && (sp.disposition !== tp.disposition || sp.targetFY !== tp.targetFY || sp.targetQ !== tp.targetQ || sp.confidence !== tp.confidence);
    if (differs && keep !== 'target' && keep !== 'source' && keep !== 'both') {
      throw new HttpError(409, 'Both applications have a decision – choose which one to keep', { needsChoice: true, source: sp, target: tp });
    }
  }
  const rule = store.tx(() => store.addRule({ kind, source: src, target: tgt, note: String(note ?? '').slice(0, 500), createdBy: userOf(req) }, { keep: keep === 'source' ? 'source' : 'target', discardSource: keep === 'target' }));
  res.json({ rule, rev: store.rev() });
}));

api.delete('/rules/:id', wrap((req, res) => {
  store.tx(() => store.deleteRule(Number(req.params.id), userOf(req)));
  res.json({ ok: true, rev: store.rev() });
}));

api.delete('/plans', wrap((req, res) => {
  const key = String(req.query.key ?? '');
  if (!key) throw new HttpError(400, 'key is required');
  store.tx(() => store.deletePlan(key, userOf(req)));
  res.json({ ok: true, rev: store.rev() });
}));

api.get('/history', (req, res) => {
  res.json(store.history({ appKey: typeof req.query.app === 'string' ? req.query.app : undefined, limit: Number(req.query.limit) || 300 }));
});

api.put('/settings', wrap((req, res) => {
  const patch = req.body ?? {};
  const cur = store.getSettings(sharedDefaults());
  const next: SharedSettings = { ...cur };
  if (patch.horizonFY !== undefined) next.horizonFY = Math.max(fyOf(new Date()) + 1, Math.min(99, Number(patch.horizonFY) || cur.horizonFY));
  if (patch.includePoweredOff !== undefined) next.includePoweredOff = !!patch.includePoweredOff;
  if (Array.isArray(patch.deadlines)) next.deadlines = patch.deadlines.slice(0, 50);
  if (patch.clusterVendor && typeof patch.clusterVendor === 'object') next.clusterVendor = patch.clusterVendor;
  if (patch.sovereignClusters && typeof patch.sovereignClusters === 'object' && !Array.isArray(patch.sovereignClusters)) {
    const nextSov: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch.sovereignClusters as Record<string, unknown>).slice(0, 300)) nextSov[String(k).slice(0, 200)] = String(v ?? '').slice(0, 300);
    const before = cur.sovereignClusters ?? {};
    const user = userOf(req);
    for (const k of new Set([...Object.keys(before), ...Object.keys(nextSov)])) {
      const was = k in before, now = k in nextSov;
      if (was && !now) store.logEvent(`Cluster: ${k}`, `Data-sovereignty pin removed from cluster ${k}`, user);
      else if (!was && now) store.logEvent(`Cluster: ${k}`, `Cluster ${k} pinned on-prem for data sovereignty${nextSov[k] ? ` – ${nextSov[k]}` : ''}`, user);
      else if (was && now && before[k] !== nextSov[k]) store.logEvent(`Cluster: ${k}`, `Data-sovereignty reason for ${k} changed to “${nextSov[k]}”`, user);
    }
    next.sovereignClusters = nextSov;
  }
  if (patch.domainOverrides && typeof patch.domainOverrides === 'object' && !Array.isArray(patch.domainOverrides)) {
    const nextD: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch.domainOverrides as Record<string, unknown>).slice(0, 2000)) {
      const d = String(v ?? '').trim().slice(0, 60);
      if (d) nextD[String(k)] = d;
    }
    const before = cur.domainOverrides ?? {};
    const user = userOf(req);
    for (const k of new Set([...Object.keys(before), ...Object.keys(nextD)])) {
      if (before[k] === nextD[k]) continue;
      store.logEvent(k, nextD[k] ? `Domain set to ${nextD[k]} (VMInfo says ${parsedDomain(k)})` : `Domain override removed – back to ${parsedDomain(k)} from VMInfo`, user);
    }
    next.domainOverrides = nextD;
  }
  if (patch.confidenceWeights && typeof patch.confidenceWeights === 'object') {
    const w = { ...cur.confidenceWeights };
    for (const k of ['high', 'medium', 'low', 'unknown', 'unrated'] as const) {
      const v = Number(patch.confidenceWeights[k]);
      if (Number.isFinite(v)) w[k] = Math.max(0, Math.min(100, Math.round(v)));
    }
    next.confidenceWeights = w;
  }
  store.saveSettings(next);
  res.json({ settings: fullSettings(), rev: store.rev() });
}));

api.get('/uploads', (_req, res) => res.json(store.listUploads()));

api.post('/uploads', express.raw({ type: () => true, limit: '80mb' }), wrap(async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length < 100) throw new HttpError(400, 'Empty upload');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, 'This is not an .xlsx file');
  let filename = 'VMInfo.xlsx';
  let note = '';
  try {
    filename = decodeURIComponent(req.header('x-filename') ?? filename).slice(0, 200);
    note = decodeURIComponent(req.header('x-note') ?? '').slice(0, 1000);
  } catch { /* keep defaults */ }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const dup = store.findBySha(sha256);
  if (dup && dup === store.latestUploadId() && req.query.force !== '1') {
    throw new HttpError(409, `This file is identical to the current inventory (upload #${dup}).`);
  }
  let inv: Inventory;
  try {
    const sheets = (await readExcelFile(new Blob([new Uint8Array(buf)]))) as unknown as { sheet: string; data: unknown[][] }[];
    inv = inventoryFromSheets(sheets, filename);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  const prevId = store.latestUploadId();
  const prev = prevId ? store.getInventory(prevId) : null;
  const diff = diffInventories(prev, inv);
  const id = store.addUpload({
    filename, uploadedBy: userOf(req), uploadedAt: new Date().toISOString(), note, sha256,
    vmCount: inv.vms.length, poweredOn: inv.vms.filter((v) => v.poweredOn).length,
    vcpu: inv.vms.reduce((s, v) => s + v.vcpu, 0), appCount: new Set(inv.vms.map((v) => v.appKey)).size,
    clusterCount: inv.clusters.length, diff, inventory: inv, file: new Uint8Array(buf),
  });
  res.json({ upload: store.listUploads().find((u) => u.id === id), rev: store.rev() });
}));

api.get('/uploads/:id/file', (req, res) => {
  const f = store.getUploadFile(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.end(Buffer.from(f.file));
});

api.get('/export/treatment-plan.xlsx', wrap(async (req, res) => {
  const id = store.latestUploadId();
  const inv = id ? mappedInventory(id) : null;
  const buf = await buildTreatmentWorkbook({ rules: store.listRules(), inventory: inv, plans: store.getPlans(), settings: fullSettings(), history: store.history({ limit: 5000 }), uploads: store.listUploads(), basis: req.query.basis === 'plan' ? 'plan' : 'risk' });
  const name = `Treatment-Plan-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.end(buf);
}));

api.get('/backup', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="footprint-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ version: 1, exportedAt: new Date().toISOString(), settings: store.getSettings(sharedDefaults()), plans: store.getPlans(), history: store.history({ limit: 100000 }) });
});

api.use((req, res) => res.status(404).json({ error: `No API route ${req.method} ${req.path}` }));
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.body as object) });
  const e = err as { type?: string; message?: string };
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  console.error(err);
  res.status(500).json({ error: e?.message ?? 'Server error' });
});

app.use('/api', api);

if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR, { index: 'index.html', maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(STATIC_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('Web app not built. Run "npm run build" first (API is available under /api).'));
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    store.close();
    process.exit(0);
  });
}

/** Earlier versions did not store the RVTools utilisation columns – re-read them from the stored original files once. */
async function backfillUsage() {
  if (store.hasFlag('backfill_usage_v26')) return;
  const ids = store.uploadIds();
  const todo = ids.filter((id) => {
    const inv = store.getInventory(id);
    return inv && inv.vms.length && inv.vms.every((v) => v.cpuAvgPct === undefined && v.memAvgPct === undefined);
  });
  if (todo.length) {
    const dest = store.backup('usage-backfill');
    let n = 0;
    for (const id of todo) {
      try {
        const f = store.getUploadFile(id)!;
        const sheets = (await readExcelFile(new Blob([new Uint8Array(f.file)]))) as unknown as { sheet: string; data: unknown[][] }[];
        const fresh = inventoryFromSheets(sheets, f.filename);
        const byName = new Map(fresh.vms.map((v) => [`${v.name}|${v.vcenter}`, v]));
        const inv = store.getInventory(id)!;
        // Only add the new columns; every other stored value stays exactly as it was.
        const vms = inv.vms.map((v) => {
          const fv = byName.get(`${v.name}|${v.vcenter}`);
          return fv ? { ...v, cpuAvgPct: fv.cpuAvgPct, memAvgPct: fv.memAvgPct } : v;
        });
        store.replaceInventory(id, { vms, clusters: inv.clusters });
        n++;
      } catch (e) {
        console.error(`  Could not read utilisation from upload #${id}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`  Added RVTools utilisation to ${n} earlier upload(s) – backup: ${dest}`);
  }
  store.setFlag('backfill_usage_v26');
}
backfillUsage().catch((e) => console.error(e));

app.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  OnPrem Transformation Planner is running`);
  console.log(`    Local:    http://localhost:${PORT}`);
  console.log(`    Network:  http://${hostname()}:${PORT}`);
  console.log(`    Database: ${DB_PATH}`);
  console.log('');
}).on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Start with a different port, e.g. --port 9000` : e);
  process.exit(1);
});
