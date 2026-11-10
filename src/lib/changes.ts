import { dispMeta } from './dispositions.ts';
import { defaultVendor, isOnExec, vendorOf } from './defaults.ts';
import { fyQuarterEnd, parseISODate } from './fy.ts';
import { parseApp, NO_APP } from './parse.ts';
import { applyRules } from './rules.ts';
import { footprintScenarios, groupApps, planFor, scopeVMs, totals } from './projection.ts';
import type { AppRule, Inventory, PlanMap, Settings, VM } from './types.ts';

/** "Needs attention" thresholds for a decided application whose footprint moved (both conditions must hold). */
export const SHIFT_THRESHOLDS = { pct: 10, vcpu: 5, memGB: 10, storGB: 1024 };

export interface FieldChange { field: string; from: string; to: string }
export interface VmRef { name: string; app: string; cluster: string; vcpu: number; created?: string; buildUser?: string }
export interface AppDelta { key: string; vms: number; vcpu: number; hadDecision?: boolean }
export interface ShiftedApp {
  key: string; treatment: string;
  vcpu: [number, number]; memGB: [number, number]; storGB: [number, number];
  reasons: string[]; grewWhileRetiring: boolean;
}
type T4 = { vms: number; vcpu: number; memGB: number; storGB: number };

export interface ChangeReport {
  baseUploadId: number | null;
  targetUploadId: number | null;
  totals: { before: T4; after: T4 };
  apps: { added: AppDelta[]; removed: AppDelta[]; renamed: { from: string; to: string; sharedVms: number }[] };
  vms: { added: VmRef[]; removed: VmRef[]; changed: { name: string; app: string; changes: FieldChange[] }[] };
  effects: {
    forecast: { endBefore: { risk: number; plan: number }; endAfter: { risk: number; plan: number }; horizonFY: number };
    deadlines: { label: string; date: string; before: number; after: number }[];
    attention: {
      newApps: AppDelta[];
      parked: { key: string; treatment: string }[];
      shifted: ShiftedApp[];
      newVmsInMovingApps: { vm: string; app: string; treatment: string }[];
    };
    rules: { noLongerNeeded: string[]; conflicts: string[] };
    sovereignty: { onto: { vm: string; cluster: string }[]; off: { vm: string; cluster: string }[] };
    hardware: { vm: string; from: string; to: string }[];
  };
  attentionCount: number;
}

const vmId = (v: VM) => `${v.name.toLowerCase()}|${v.vcenter.toLowerCase()}`;
const r = (n: number) => Math.round(n * 10) / 10;

/** Compare two inventories (raw, as uploaded) and work out what changed and what it does to the plan. */
export function compareInventories(base: Inventory | null, next: Inventory, plans: PlanMap, settings: Settings, rules: AppRule[],
  ids: { base: number | null; target: number | null } = { base: base?.uploadId ?? null, target: next.uploadId ?? null }): ChangeReport {
  const empty: Inventory = { sourceFile: '', loadedAt: '', isDemo: false, vms: [], clusters: [] };
  const rawB = base ?? empty;
  const mapB = applyRules(rawB, rules).inventory;
  const mapN = applyRules(next, rules).inventory;
  const sov = settings.sovereignClusters ?? {};
  const vend = (loc: string) => (settings.clusterVendor ? vendorOf(settings, loc) : defaultVendor(loc));

  // ---- totals (footprint scope: powered-on unless the setting includes powered-off; virtualization excluded)
  const sB = scopeVMs(mapB.vms, settings, plans);
  const sN = scopeVMs(mapN.vms, settings, plans);
  const t = (vms: VM[]): T4 => { const x = totals(vms); return { vms: x.vms, vcpu: x.vcpu, memGB: r(x.memGB), storGB: r(x.storGB) }; };

  // ---- applications (after mapping rules)
  const appsB = new Map(groupApps(mapB.vms).map((a) => [a.key, a]));
  const appsN = new Map(groupApps(mapN.vms).map((a) => [a.key, a]));
  const added = [...appsN.values()].filter((a) => !appsB.has(a.key) && a.key !== NO_APP).map((a) => ({ key: a.key, vms: a.vmCount, vcpu: a.vcpu }));
  const removed = [...appsB.values()].filter((a) => !appsN.has(a.key)).map((a) => ({ key: a.key, vms: a.vmCount, vcpu: a.vcpu, hadDecision: !!plans[a.key] }));
  // Probable renames: most VMs of a removed application now belong to one new application.
  const nByVm = new Map(mapN.vms.map((v) => [vmId(v), v.appKey]));
  const renamed: ChangeReport['apps']['renamed'] = [];
  for (const rm of removed) {
    const counts = new Map<string, number>();
    for (const v of appsB.get(rm.key)!.vms) { const k = nByVm.get(vmId(v)); if (k && added.some((a) => a.key === k)) counts.set(k, (counts.get(k) ?? 0) + 1); }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= Math.max(1, rm.vms / 2)) renamed.push({ from: rm.key, to: best[0], sharedVms: best[1] });
  }

  // ---- VMs (raw values as in the file)
  const bMap = new Map(rawB.vms.map((v) => [vmId(v), v]));
  const nMap = new Map(next.vms.map((v) => [vmId(v), v]));
  const ref = (v: VM): VmRef => ({ name: v.name, app: v.appKey, cluster: v.location, vcpu: v.vcpu, created: v.createdDate, buildUser: v.buildUser });
  const vmAdded = next.vms.filter((v) => !bMap.has(vmId(v))).map(ref);
  const vmRemoved = rawB.vms.filter((v) => !nMap.has(vmId(v))).map(ref);
  const gb = (n: number) => `${r(n)} GB`;
  const fields: [string, (v: VM) => string][] = [
    ['vCPU', (v) => String(v.vcpu)], ['vRAM', (v) => gb(v.memGB)], ['Storage', (v) => gb(v.storageProvGB)],
    ['Power', (v) => (v.poweredOn ? 'On' : 'Off')], ['Application_Primary', (v) => v.appKey], ['Environment', (v) => v.environment],
    ['Cluster', (v) => v.location], ['Owner', (v) => v.owner || '—'],
  ];
  const changed: ChangeReport['vms']['changed'] = [];
  for (const v of next.vms) {
    const o = bMap.get(vmId(v));
    if (!o) continue;
    const ch = fields.map(([f, g]) => ({ field: f, from: g(o), to: g(v) })).filter((c) => c.from !== c.to);
    if (ch.length) changed.push({ name: v.name, app: v.appKey, changes: ch });
  }

  // ---- effects on the forecast
  const end = fyQuarterEnd(settings.horizonFY, 4);
  const w = settings.confidenceWeights;
  const eB = footprintScenarios(sB, plans, end, w), eN = footprintScenarios(sN, plans, end, w);
  const deadlines = settings.deadlines.filter(isOnExec).sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const at = parseISODate(d.date);
    return { label: d.label, date: d.date, before: Math.round(footprintScenarios(sB, plans, at, w).risk.vcpu), after: Math.round(footprintScenarios(sN, plans, at, w).risk.vcpu) };
  });

  // ---- decisions needing attention
  const newApps = added.filter((a) => !plans[a.key]);
  const nKeys = new Set(mapN.vms.map((v) => v.appKey));
  const parked = Object.entries(plans).filter(([k]) => !nKeys.has(k) && appsB.has(k)).map(([k, p]) => ({ key: k, treatment: dispMeta(p.disposition).label }));
  const scopedApps = (vms: VM[]) => new Map(groupApps(vms).map((a) => [a.key, a]));
  const aB = scopedApps(sB), aN = scopedApps(sN);
  const shifted: ShiftedApp[] = [];
  for (const [k, p] of Object.entries(plans)) {
    if (p.disposition === 'tbd' || p.disposition === 'virt_resource') continue;
    const b = aB.get(k), n = aN.get(k);
    if (!b || !n) continue;
    const pair = (x: number, y: number): [number, number] => [r(x), r(y)];
    const vc = pair(b.vcpu, n.vcpu), me = pair(b.memGB, n.memGB), st = pair(b.storageGB, n.storageGB);
    const hit = (v: [number, number], abs: number) => Math.abs(v[1] - v[0]) >= abs && (v[0] === 0 || Math.abs(v[1] - v[0]) / v[0] * 100 >= SHIFT_THRESHOLDS.pct);
    const reasons: string[] = [];
    if (hit(vc, SHIFT_THRESHOLDS.vcpu)) reasons.push(`vCPU ${vc[0]} → ${vc[1]}`);
    if (hit(me, SHIFT_THRESHOLDS.memGB)) reasons.push(`vRAM ${me[0]} → ${me[1]} GB`);
    if (hit(st, SHIFT_THRESHOLDS.storGB)) reasons.push(`Storage ${r(st[0] / 1024)} → ${r(st[1] / 1024)} TB`);
    if (reasons.length) shifted.push({ key: k, treatment: dispMeta(p.disposition).label, vcpu: vc, memGB: me, storGB: st, reasons, grewWhileRetiring: p.disposition === 'retire' && vc[1] > vc[0] });
  }
  const newVmsInMovingApps = mapN.vms
    .filter((v) => !bMap.has(vmId(v)) && dispMeta(planFor(plans, v.appKey).disposition).leavesOnPrem)
    .map((v) => ({ vm: v.name, app: v.appKey, treatment: dispMeta(planFor(plans, v.appKey).disposition).label }));

  // ---- mapping rules, sovereignty, hardware
  const effB = applyRules(rawB, rules).effects, effN = applyRules(next, rules).effects;
  const rawKeysN = new Set(next.vms.map((v) => v.appKey));
  const namesN = new Set(next.vms.map((v) => v.name.toLowerCase()));
  const noLongerNeeded = rules.filter((x) => (x.kind === 'merge' ? !rawKeysN.has(x.source) : !namesN.has(x.source.toLowerCase())) && (base ? (x.kind === 'merge' ? rawB.vms.some((v) => v.appKey === x.source) : rawB.vms.some((v) => v.name.toLowerCase() === x.source.toLowerCase())) : false))
    .map((x) => `${x.kind === 'merge' ? 'Merge' : 'VM'}: ${x.source} → ${x.target}`);
  const conflicts = rules.filter((x) => effN[x.id]?.conflict && !effB[x.id]?.conflict).map((x) => `VM ${x.source}: file now says “${effN[x.id].conflict}”`);
  const onto: { vm: string; cluster: string }[] = [], off: { vm: string; cluster: string }[] = [], hardware: { vm: string; from: string; to: string }[] = [];
  for (const v of next.vms) {
    const o = bMap.get(vmId(v));
    if (!o || o.location === v.location) continue;
    if (sov[v.location] !== undefined && sov[o.location] === undefined) onto.push({ vm: v.name, cluster: v.location });
    if (sov[o.location] !== undefined && sov[v.location] === undefined) off.push({ vm: v.name, cluster: o.location });
    if (vend(o.location) !== vend(v.location)) hardware.push({ vm: v.name, from: `${o.location} (${vend(o.location)})`, to: `${v.location} (${vend(v.location)})` });
  }
  const attentionCount = newApps.length + parked.length + shifted.length + newVmsInMovingApps.length + conflicts.length + onto.length;

  return {
    baseUploadId: ids.base, targetUploadId: ids.target,
    totals: { before: t(sB), after: t(sN) },
    apps: { added, removed, renamed },
    vms: { added: vmAdded, removed: vmRemoved, changed },
    effects: {
      forecast: { endBefore: { risk: Math.round(eB.risk.vcpu), plan: Math.round(eB.plan.vcpu) }, endAfter: { risk: Math.round(eN.risk.vcpu), plan: Math.round(eN.plan.vcpu) }, horizonFY: settings.horizonFY },
      deadlines,
      attention: { newApps, parked, shifted, newVmsInMovingApps },
      rules: { noLongerNeeded, conflicts },
      sovereignty: { onto, off },
      hardware,
    },
    attentionCount,
  };
}

export { parseApp };
