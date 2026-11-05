import writeExcelFile from 'write-excel-file/node';
import { DISP, DISPOSITIONS } from '../src/lib/dispositions.ts';
import { fyLabel, fyOf, fyQuarterEnd, parseISODate, quarterLabel, quarterRange } from '../src/lib/fy.ts';
import { byDisposition, exitDate, exitsBy, footprintScenarios, groupApps, periods, planFor, scopeVMs, totals, trend } from '../src/lib/projection.ts';
import { CONFIDENCE, CONFIDENCE_LABEL, VENDOR_LABEL, deadlineVendor, moveWeight, vendorOf } from '../src/lib/defaults.ts';
import { addCharts, type ChartDef } from './charts.ts';
import { APP_NAME } from '../src/lib/brand.ts';
import { parseApp } from '../src/lib/parse.ts';
import type { HistoryEntry, Inventory, PlanMap, Settings, UploadMeta } from '../src/lib/types.ts';

type Cell = { value?: unknown; type?: unknown; format?: string; fontWeight?: 'bold'; fontSize?: number; backgroundColor?: string; color?: string; wrap?: boolean } | null;
type Row = Cell[];

const H = (v: string): Cell => ({ value: v, fontWeight: 'bold', backgroundColor: '#1F4E79', color: '#FFFFFF' });
const S = (v: unknown): Cell => (v === undefined || v === null || v === '' ? null : { value: String(v), type: String });
const N = (v: number | undefined | null): Cell => (v === undefined || v === null ? null : { value: v, type: Number, format: '#,##0' });
const D = (v: Date | string | undefined | null): Cell => {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : { value: d, type: Date, format: 'dd-mmm-yyyy' };
};
const DT = (v: string | undefined): Cell => (v ? { value: new Date(v), type: Date, format: 'dd-mmm-yyyy hh:mm' } : null);

function sheet(name: string, header: string[], rows: Row[], widths: number[]) {
  return {
    sheet: name,
    data: [header.map(H), ...rows],
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: 1,
  };
}

export async function buildTreatmentWorkbook(input: {
  inventory: Inventory | null;
  plans: PlanMap;
  settings: Settings;
  history: HistoryEntry[];
  uploads: UploadMeta[];
  /** Headline basis for the Executive Summary: risk-adjusted (default) or full plan. */
  basis?: 'risk' | 'plan';
}): Promise<Buffer> {
  const { inventory, plans, settings, history, uploads } = input;
  const isRisk = input.basis !== 'plan';
  const bName = isRisk ? 'Risk-adjusted' : 'Full plan';
  const altName = isRisk ? 'Full plan' : 'Risk-adjusted';
  const allVms = inventory?.vms ?? [];
  const vms = scopeVMs(allVms, settings);
  const apps = groupApps(allVms);
  const scopeNote = settings.includePoweredOff ? 'all VMs' : 'powered-on VMs only';
  const W8 = settings.confidenceWeights;

  // 1. Treatment plan – one row per application
  const appRows = apps
    .map((a) => ({ a, p: planFor(plans, a.key), exit: exitDate(planFor(plans, a.key)) }))
    .sort((x, y) => (x.exit?.getTime() ?? Infinity) - (y.exit?.getTime() ?? Infinity) || y.a.vcpu - x.a.vcpu);
  const treatment = sheet(
    'Treatment plan',
    ['Application_Primary', 'Application', 'Domain', 'Tier', 'Service', 'Owner', 'VMs', 'Powered-on VMs', 'vCPU', 'vRAM (GB)', 'Storage (GB)',
      'Environments', 'vCenters', 'Treatment', 'Treatment group', 'Target FY', 'Target quarter', 'Target period', 'Off on-prem by', 'Confidence', 'Counted as moved (risk-adj.)', 'Notes', 'Last updated by', 'Last updated'],
    appRows.map(({ a, p, exit }) => {
      const m = DISP[p.disposition];
      const scheduled = m.leavesOnPrem && p.targetFY;
      return [
        S(a.key), S(a.name), S(a.domain), S(a.tier), S(a.service), S(a.owner), N(a.vmCount), N(a.vms.filter((v) => v.poweredOn).length),
        N(a.vcpu), N(Math.round(a.memGB)), N(Math.round(a.storageGB)), S(a.environments.join(', ')), S(a.sites.join(', ')),
        S(m.label), S(m.group === 'Exit' ? 'Retire / SaaS' : m.group === 'Cloud' ? 'Hyperscaler' : m.group === 'Retain' ? 'Stays on-prem' : 'Undecided'),
        S(scheduled ? fyLabel(p.targetFY!) : m.leavesOnPrem ? 'Not scheduled' : ''),
        S(scheduled ? `Q${p.targetQ ?? 4}` : ''),
        S(scheduled ? `${quarterLabel(p.targetFY!, p.targetQ ?? 4)} (${quarterRange(p.targetFY!, p.targetQ ?? 4)})` : ''),
        D(exit),
        S(scheduled ? (p.confidence ? CONFIDENCE_LABEL[p.confidence] : 'Not rated') : ''),
        scheduled ? { value: moveWeight(p.confidence, W8), type: Number, format: '0%' } : null,
        S(p.notes), S(p.updatedBy), DT(p.updatedAt),
      ];
    }),
    [48, 28, 10, 9, 28, 22, 7, 9, 7, 9, 10, 18, 12, 28, 14, 12, 9, 26, 13, 11, 12, 40, 18, 17],
  );

  // 2. Quarterly roadmap
  const ps = periods(settings, 'quarter');
  const exitsV = exitsBy(vms, plans, settings, 'vcpu', 'quarter');
  const exitsN = exitsBy(vms, plans, settings, 'vms', 'quarter');
  const leaving = DISPOSITIONS.filter((d) => d.leavesOnPrem);
  const roadmap = sheet(
    'Quarterly roadmap',
    ['Quarter', 'Period', 'Quarter end', 'Apps leaving', 'VMs leaving', 'vCPU leaving', ...leaving.map((d) => `vCPU – ${d.short}`), 'VMs remaining (risk-adj.)', 'vCPU remaining (risk-adj.)', 'vCPU remaining – full plan', 'vCPU remaining – committed'],
    ps.map((p, i) => {
      const rem = footprintScenarios(vms, plans, p.end, W8);
      return [
        S(p.label), S(quarterRange(p.fy, p.q)), D(fyQuarterEnd(p.fy, p.q)), N(exitsV[i].apps), N(exitsN[i].total), N(exitsV[i].total),
        ...leaving.map((d) => N(exitsV[i][d.id] ?? 0)), N(Math.round(rem.risk.vms)), N(Math.round(rem.risk.vcpu)), N(rem.plan.vcpu), N(rem.committed.vcpu),
      ];
    }),
    [12, 16, 13, 12, 11, 12, ...leaving.map(() => 14), 15, 15, 15, 15],
  );

  // 3. Apps by quarter (the "what leaves when" list)
  const byQuarter = sheet(
    'Apps by quarter',
    ['Quarter', 'Period', 'Application', 'Domain', 'Treatment', 'Confidence', 'VMs', 'vCPU', 'Notes'],
    appRows
      .filter(({ exit }) => exit)
      .map(({ a, p }) => [
        S(quarterLabel(p.targetFY!, p.targetQ ?? 4)), S(quarterRange(p.targetFY!, p.targetQ ?? 4)), S(a.name), S(a.domain),
        S(DISP[p.disposition].label), S(p.confidence ? CONFIDENCE_LABEL[p.confidence] : 'Not rated'), N(a.vmCount), N(a.vcpu), S(p.notes),
      ]),
    [12, 16, 32, 10, 28, 11, 7, 7, 40],
  );

  // 4. VMs with their application's treatment
  const vmSheet = sheet(
    'VMs',
    ['VMName', 'PowerState', 'Application_Primary', 'Domain', 'Tier', 'Environment', 'vCenter', 'VMLocation', 'GuestOS', 'vCPU', 'Memory (GB)', 'Storage (GB)', 'Treatment', 'Target period', 'Off on-prem by'],
    [...allVms]
      .sort((x, y) => x.appKey.localeCompare(y.appKey) || x.name.localeCompare(y.name))
      .map((v) => {
        const a = parseApp(v.appKey);
        const p = planFor(plans, v.appKey);
        const ex = exitDate(p);
        return [
          S(v.name), S(v.poweredOn ? 'PoweredOn' : 'PoweredOff'), S(v.appKey), S(a.domain), S(a.tier), S(v.environment), S(v.vcenter),
          S(v.location), S(v.os), N(v.vcpu), N(v.memGB), N(Math.round(v.storageProvGB)), S(DISP[p.disposition].label),
          S(ex ? quarterLabel(p.targetFY!, p.targetQ ?? 4) : ''), D(ex),
        ];
      }),
    [28, 11, 48, 10, 9, 11, 26, 18, 32, 6, 10, 10, 26, 12, 13],
  );

  // 5. Decisions that no longer match an application in the latest inventory
  const keys = new Set(apps.map((a) => a.key));
  const orphans = Object.entries(plans).filter(([k]) => !keys.has(k));

  // 6. Change log
  const fmtPlan = (p: HistoryEntry['before']) => {
    if (!p) return '';
    const m = p.disposition ? DISP[p.disposition]?.label ?? p.disposition : '';
    const t = p.targetFY ? ` · ${quarterLabel(p.targetFY, p.targetQ ?? 4)}` : '';
    const c = p.confidence ? ` · ${CONFIDENCE_LABEL[p.confidence]} confidence` : '';
    return `${m}${t}${c}${p.notes ? ` · ${p.notes}` : ''}`;
  };
  const changeLog = sheet(
    'Change log',
    ['When', 'Who', 'Application_Primary', 'Action', 'Before', 'After'],
    history.map((h) => [DT(h.changedAt), S(h.changedBy), S(h.appKey), S(h.action), S(fmtPlan(h.before)), S(fmtPlan(h.after))]),
    [17, 20, 48, 9, 40, 40],
  );

  // 7. Upload history
  const uploadSheet = sheet(
    'Inventory uploads',
    ['Upload #', 'File', 'Uploaded by', 'Uploaded at', 'Note', 'VMs', 'Powered on', 'vCPU', 'Applications', 'VMs added', 'VMs removed', 'Apps added', 'Apps removed'],
    uploads.map((u) => [N(u.id), S(u.filename), S(u.uploadedBy), DT(u.uploadedAt), S(u.note), N(u.vmCount), N(u.poweredOn), N(u.vcpu), N(u.appCount),
      N(u.diff.vmsAdded.length), N(u.diff.vmsRemoved.length), N(u.diff.appsAdded.length), N(u.diff.appsRemoved.length)]),
    [9, 36, 20, 17, 30, 7, 10, 7, 12, 10, 11, 10, 12],
  );

  // ---------- Executive summary (tables + native charts) & chart data ----------
  const base = totals(vms);
  const endS = footprintScenarios(vms, plans, fyQuarterEnd(settings.horizonFY, 4), W8);
  const endT = { vms: Math.round((isRisk ? endS.risk : endS.plan).vms), vcpu: Math.round((isRisk ? endS.risk : endS.plan).vcpu) };
  const decided = apps.filter((a) => planFor(plans, a.key).disposition !== 'tbd');
  const decidedVcpu = vms.filter((v) => planFor(plans, v.appKey).disposition !== 'tbd').reduce((x, v) => x + v.vcpu, 0);

  // Headline series follow the chosen basis; the "Plan" fields then hold the alternative scenario.
  const swap = (p: ReturnType<typeof trend>[number]) =>
    isRisk ? p : { ...p, vms: p.vmsPlan, vcpu: p.vcpuPlan, vmsPct: p.vmsPlanPct, vcpuPct: p.vcpuPlanPct, vmsPlan: p.vms, vcpuPlan: p.vcpu, vmsPlanPct: p.vmsPct, vcpuPlanPct: p.vcpuPct };
  const tq = trend(vms, plans, settings, 'quarter').map(swap);
  const tf = trend(vms, plans, settings, 'fy').map(swap);
  const exitsC = exitsBy(vms, plans, settings, 'vcpu', 'quarter', isRisk);
  const disp = byDisposition(vms, plans);

  // Chart data sheet layout (1-based rows; row 1 = headers)
  const CD = "'Chart data'";
  const rng = (col: string, n: number) => `${CD}!$${col}$2:$${col}$${n + 1}`;
  const leaveCols = ['L', 'M', 'N', 'O', 'P'];
  const cdHeader = ['Period', `VMs remaining (${bName})`, `vCPU remaining (${bName})`, 'VMs % of today', 'vCPU % of today', '', 'FY', 'VMs remaining', 'vCPU remaining', '', 'Quarter',
    ...leaving.map((d) => `vCPU leaving – ${d.short}`), 'vCPU leaving – total', '', 'Treatment', 'vCPU', 'VMs', 'Apps', '', `vCPU – ${altName}`, 'vCPU – committed', `VMs – ${altName}`, 'VMs – committed'];
  const nRows = Math.max(tq.length, tf.length, exitsC.length, DISPOSITIONS.length);
  const cdRows: Row[] = [];
  for (let r = 0; r < nRows; r++) {
    const q = tq[r], f = tf[r], e = exitsC[r], dm = DISPOSITIONS[r];
    const ds = dm ? disp.find((x) => x.id === dm.id)! : null;
    cdRows.push([
      q ? S(q.label) : null, q ? N(q.vms) : null, q ? N(q.vcpu) : null, q ? N(q.vmsPct) : null, q ? N(q.vcpuPct) : null, null,
      f ? S(f.label === 'Now' ? 'Now' : `End ${f.label}`) : null, f ? N(f.vms) : null, f ? N(f.vcpu) : null, null,
      e ? S(e.label) : null, ...leaving.map((d) => (e ? N(e[d.id] ?? 0) : null)), e ? N(e.total) : null, null,
      dm ? S(dm.label) : null, ds ? N(ds.vcpu) : null, ds ? N(ds.vms) : null, ds ? N(ds.apps) : null, null,
      q ? N(q.vcpuPlan) : null, q ? N(q.vcpuCommit) : null, q ? N(q.vmsPlan) : null, q ? N(q.vmsCommit) : null,
    ]);
  }
  const chartData = sheet('Chart data', cdHeader, cdRows, [12, 13, 13, 13, 13, 3, 12, 13, 13, 3, 11, ...leaving.map(() => 16), 16, 3, 30, 9, 9, 8, 3, 14, 14, 14, 14]);

  const C = (v: unknown, extra: Partial<NonNullable<Cell>> = {}): Cell => (v === null || v === undefined ? null : { ...(typeof v === 'number' ? { value: v, type: Number, format: '#,##0' } : { value: String(v), type: String }), ...extra });
  const B = (v: string): Cell => ({ value: v, type: String, fontWeight: 'bold' });
  const TH = (v: string): Cell => ({ value: v, type: String, fontWeight: 'bold', backgroundColor: '#E4EFFC' });
  const ex: Row[] = [];
  ex.push([{ value: `${APP_NAME} – Executive Summary`, type: String, fontWeight: 'bold', fontSize: 16 } as Cell]);
  ex.push([C(`Generated ${new Date().toLocaleString('en-AU')} · Inventory: ${inventory ? `${inventory.sourceFile} (upload #${inventory.uploadId})` : 'none'} · Basis: ${scopeNote} · FY starts 1 July`, { color: '#52514E' })]);
  ex.push([]);
  ex.push([TH('Key figures'), TH('Value')]);
  ex.push([C('VMs on-prem today'), N(base.vms)]);
  ex.push([C('vCPU on-prem today'), N(base.vcpu)]);
  ex.push([C(`VMs projected at end of ${fyLabel(settings.horizonFY)} (${bName.toLowerCase()})`), N(endT.vms)]);
  ex.push([C(`vCPU projected at end of ${fyLabel(settings.horizonFY)} (${bName.toLowerCase()})`), N(endT.vcpu)]);
  ex.push([C(`vCPU at end of ${fyLabel(settings.horizonFY)} – full plan (all moves on time)`), N(endS.plan.vcpu)]);
  ex.push([C(`vCPU at end of ${fyLabel(settings.horizonFY)} – committed (High confidence only)`), N(endS.committed.vcpu)]);
  ex.push([C('vCPU reduction by horizon'), { value: base.vcpu ? (base.vcpu - endT.vcpu) / base.vcpu : 0, type: Number, format: '0%' }]);
  ex.push([C('Applications with a treatment decision'), C(`${decided.length} of ${apps.length}`)]);
  ex.push([C('Share of vCPU with a decision'), { value: base.vcpu ? decidedVcpu / base.vcpu : 0, type: Number, format: '0%' }]);
  ex.push([]);
  ex.push([TH('Deadline'), TH('Date'), TH('Status'), TH('VMs risk-adj.'), TH('vCPU risk-adj.'), TH('vCPU full plan'), TH('vCPU committed')]);
  for (const d of [...settings.deadlines].sort((a, b) => a.date.localeCompare(b.date))) {
    const at = parseISODate(d.date);
    const vendor = deadlineVendor(d.kind);
    const fp = footprintScenarios(vms, plans, at, W8, vendor ? (v) => vendorOf(settings, v.location) === vendor : undefined);
    ex.push([C(`${d.label}${vendor ? ` (on ${VENDOR_LABEL[vendor]} clusters)` : ''}`), D(at), C(`${fyLabel(fyOf(at))} · ${d.confirmed ? 'confirmed' : 'date to confirm'}`), N(Math.round(fp.risk.vms)), N(Math.round(fp.risk.vcpu)), N(fp.plan.vcpu), N(fp.committed.vcpu)]);
  }
  ex.push([]);
  ex.push([TH('Confidence (scheduled moves)'), TH('Apps'), TH('VMs'), TH('vCPU'), TH('Weight')]);
  {
    const acc: Record<string, { apps: Set<string>; vms: number; vcpu: number }> = {};
    for (const v of vms) {
      const p = planFor(plans, v.appKey);
      if (!exitDate(p)) continue;
      const k = p.confidence ?? 'unrated';
      const r = (acc[k] ??= { apps: new Set(), vms: 0, vcpu: 0 });
      r.apps.add(v.appKey); r.vms++; r.vcpu += v.vcpu;
    }
    for (const c of [...CONFIDENCE.map((x) => ({ id: x.id as string, label: x.label })), { id: 'unrated', label: 'Not rated' }]) {
      const r = acc[c.id];
      ex.push([C(c.label), N(r?.apps.size ?? 0), N(r?.vms ?? 0), N(r?.vcpu ?? 0), { value: (W8[c.id as keyof typeof W8] ?? 0) / 100, type: Number, format: '0%' }]);
    }
  }
  ex.push([]);
  ex.push([TH('Treatment'), TH('Apps'), TH('VMs'), TH('vCPU'), TH('% of vCPU')]);
  for (const dm of DISPOSITIONS) {
    const x = disp.find((y) => y.id === dm.id)!;
    ex.push([C(dm.label), N(x.apps), N(x.vms), N(x.vcpu), { value: base.vcpu ? x.vcpu / base.vcpu : 0, type: Number, format: '0%' }]);
  }
  ex.push([]);
  ex.push([TH('Domain'), TH('Apps'), TH('VMs'), TH('vCPU'), TH(`vCPU end ${fyLabel(settings.horizonFY)} (${isRisk ? 'risk-adj.' : 'full plan'})`)]);
  const domains = new Map<string, { apps: Set<string>; vms: number; vcpu: number }>();
  for (const v of vms) {
    const dn = parseApp(v.appKey).domain;
    const r = domains.get(dn) ?? { apps: new Set<string>(), vms: 0, vcpu: 0 };
    r.apps.add(v.appKey); r.vms++; r.vcpu += v.vcpu;
    domains.set(dn, r);
  }
  for (const [dn, r] of [...domains.entries()].sort((a, b) => b[1].vcpu - a[1].vcpu)) {
    ex.push([C(dn), N(r.apps.size), N(r.vms), N(r.vcpu), N(Math.round(footprintScenarios(vms, plans, fyQuarterEnd(settings.horizonFY, 4), W8, (v) => parseApp(v.appKey).domain === dn)[isRisk ? 'risk' : 'plan'].vcpu))]);
  }
  if (inventory?.clusters.length) {
    ex.push([]);
    ex.push([TH('Hardware vendor'), TH('Clusters'), TH('ESXi hosts'), TH('Physical cores'), TH('Running vCPU')]);
    const hw = new Map<string, { c: number; h: number; k: number; v: number }>();
    for (const c of inventory.clusters) {
      const vn = VENDOR_LABEL[vendorOf(settings, c.name)];
      const r = hw.get(vn) ?? { c: 0, h: 0, k: 0, v: 0 };
      r.c++; r.h += c.hosts; r.k += c.cores; r.v += c.runningVcpu;
      hw.set(vn, r);
    }
    for (const [vn, r] of hw) ex.push([C(vn), N(r.c), N(r.h), N(r.k), N(r.v)]);
  }
  void B;
  const execSheet = { sheet: 'Executive Summary', data: ex, columns: [{ width: 52 }, { width: 13 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 3 }, ...Array.from({ length: 18 }, () => ({ width: 10.5 }))] };

  const qCats = tq.map((p) => p.label);
  const fCats = tf.map((p) => (p.label === 'Now' ? 'Now' : `End ${p.label}`));
  const W = 9, Hrows = 20, col0 = 8;
  const pos = (i: number) => ({ col: col0 + (i % 2) * (W + 0), row: 3 + Math.floor(i / 2) * (Hrows + 1), cols: W, rows: Hrows });
  const COL = { vm: '2A78D6', vcpu: 'EB6834' };
  const SLOT: Record<string, string> = { retire: '2A78D6', saas: 'EB6834', modernize_aws: '1BAF7A', modernize_azure: 'EDA100', rehost_aws: 'E87BA4', retain_sovereignty: '008300', retain_latency: '6250D6', tbd: 'B9B8B0' };
  const charts: ChartDef[] = [
    { type: 'line', title: `On-prem footprint by quarter, ${bName.toLowerCase()} (% of today)`, catRef: rng('A', tq.length), categories: qCats, numFmt: '0"%"', yMax: 100,
      series: [
        { name: 'VMs', valRef: rng('D', tq.length), values: tq.map((p) => p.vmsPct), color: COL.vm },
        { name: 'vCPU', valRef: rng('E', tq.length), values: tq.map((p) => p.vcpuPct), color: COL.vcpu },
      ], at: pos(0) },
    { type: 'column', stacked: true, title: `vCPU leaving on-prem per quarter, by treatment (${bName.toLowerCase()})`, catRef: rng('K', exitsC.length), categories: exitsC.map((e) => e.label),
      series: leaving.map((d, i) => ({ name: d.short, valRef: rng(leaveCols[i], exitsC.length), values: exitsC.map((e) => Math.round((e[d.id] ?? 0) * 10) / 10), color: SLOT[d.id] })), at: pos(1) },
    { type: 'line', title: 'vCPU remaining on-prem by quarter – confidence range', catRef: rng('A', tq.length), categories: qCats,
      series: [
        { name: 'Committed (High only)', valRef: rng('Y', tq.length), values: tq.map((p) => p.vcpuCommit), color: '52514E', dash: true, noMarker: true },
        { name: bName, valRef: rng('C', tq.length), values: tq.map((p) => p.vcpu), color: COL.vcpu },
        { name: altName, valRef: rng('X', tq.length), values: tq.map((p) => p.vcpuPlan), color: '9A9992', dash: true, noMarker: true },
      ], at: pos(2) },
    { type: 'line', title: 'VMs remaining on-prem by quarter – confidence range', catRef: rng('A', tq.length), categories: qCats,
      series: [
        { name: 'Committed (High only)', valRef: rng('AA', tq.length), values: tq.map((p) => p.vmsCommit), color: '52514E', dash: true, noMarker: true },
        { name: bName, valRef: rng('B', tq.length), values: tq.map((p) => p.vms), color: COL.vm },
        { name: altName, valRef: rng('Z', tq.length), values: tq.map((p) => p.vmsPlan), color: '9A9992', dash: true, noMarker: true },
      ], at: pos(3) },
    { type: 'column', title: `vCPU remaining at the end of each FY (${bName.toLowerCase()})`, catRef: rng('G', tf.length), categories: fCats,
      series: [{ name: 'vCPU', valRef: rng('I', tf.length), values: tf.map((p) => p.vcpu), color: COL.vcpu }], at: pos(4) },
    { type: 'bar', title: "Today's vCPU by treatment", catRef: rng('S', DISPOSITIONS.length), categories: DISPOSITIONS.map((d) => d.label),
      series: [{ name: 'vCPU', valRef: rng('T', DISPOSITIONS.length), values: DISPOSITIONS.map((d) => disp.find((x) => x.id === d.id)!.vcpu), color: '2A78D6' }], at: pos(5) },
  ];

  const sheets = [execSheet, treatment, roadmap, byQuarter, vmSheet, changeLog, uploadSheet, chartData];
  if (orphans.length) {
    sheets.push(sheet('Unmatched decisions', ['Application_Primary (not in latest inventory)', 'Treatment', 'Target period', 'Notes', 'Last updated by'],
      orphans.map(([k, p]) => [S(k), S(DISP[p.disposition].label), S(p.targetFY ? quarterLabel(p.targetFY, p.targetQ ?? 4) : ''), S(p.notes), S(p.updatedBy)]),
      [52, 28, 12, 40, 20]));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await writeExcelFile(sheets as any).toBuffer()) as Buffer;
  return Buffer.from(addCharts(new Uint8Array(raw), 'Executive Summary', charts));
}
