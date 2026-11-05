import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import readExcelFile from 'read-excel-file/universal';
import { Store, type SharedSettings } from './db.ts';
import { buildTreatmentWorkbook } from './export.ts';
import { inventoryFromSheets } from '../src/lib/parse.ts';
import { defaultSettings } from '../src/lib/defaults.ts';
import { DISPOSITIONS } from '../src/lib/dispositions.ts';
import { fyOf } from '../src/lib/fy.ts';
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
const VALID_DISP = new Set<Disposition>(DISPOSITIONS.map((d) => d.id));

function sharedDefaults(): SharedSettings {
  const { currentFY: _c, ...rest } = defaultSettings();
  void _c;
  return rest;
}
function fullSettings(): Settings {
  return { ...store.getSettings(sharedDefaults()), currentFY: fyOf(new Date()) };
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

function cleanPlan(input: Partial<AppPlan>): Pick<AppPlan, 'disposition' | 'targetFY' | 'targetQ' | 'notes' | 'confidence'> {
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
  return { disposition, targetFY, targetQ: targetFY ? (targetQ ?? 4) : undefined, notes, confidence };
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
  res.json({ rev: store.rev(), settings: fullSettings(), plans: store.getPlans(), latestUpload: uploads[0] ?? null, uploadCount: uploads.length });
});

api.get('/inventory/latest', (_req, res) => {
  const id = store.latestUploadId();
  if (!id) return res.status(204).end();
  res.json(store.getInventory(id));
});
api.get('/inventory/:id', (req, res) => {
  const inv = store.getInventory(Number(req.params.id));
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
  const inv = id ? store.getInventory(id) : null;
  const buf = await buildTreatmentWorkbook({ inventory: inv, plans: store.getPlans(), settings: fullSettings(), history: store.history({ limit: 5000 }), uploads: store.listUploads(), basis: req.query.basis === 'plan' ? 'plan' : 'risk' });
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
