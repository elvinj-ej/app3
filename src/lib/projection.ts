import { DISP, DISPOSITIONS, dispMeta } from './dispositions.ts';
import { fyEnd, fyLabel, fyOf, fyQuarterEnd, fyQuarterOf, quarterLabel } from './fy.ts';
import { parseApp } from './parse.ts';
import type { AppInfo, AppPlan, ConfidenceWeights, Disposition, PlanMap, Settings, VM } from './types.ts';
import { DEFAULT_WEIGHTS, moveWeight } from './defaults.ts';

export const DEFAULT_PLAN: AppPlan = { disposition: 'tbd' };

export function planFor(plans: PlanMap, key: string): AppPlan {
  const p = plans[key];
  if (!p) return DEFAULT_PLAN;
  // Unknown treatment (e.g. written by a newer version) – treat as Undecided instead of failing.
  return DISP[p.disposition] ? p : { ...p, disposition: 'tbd' };
}

/** The date an application is treated as gone from on-prem, or null if it stays / is unscheduled. */
export function exitDate(plan: AppPlan): Date | null {
  if (!dispMeta(plan.disposition).leavesOnPrem || !plan.targetFY) return null;
  return fyQuarterEnd(plan.targetFY, plan.targetQ ?? 4);
}

export function scopeVMs(vms: VM[], settings: Settings): VM[] {
  return settings.includePoweredOff ? vms : vms.filter((v) => v.poweredOn);
}

export interface Totals {
  vms: number;
  vcpu: number;
  memGB: number;
}

export function totals(vms: VM[]): Totals {
  let vcpu = 0;
  let memGB = 0;
  for (const v of vms) {
    vcpu += v.vcpu;
    memGB += v.memGB;
  }
  return { vms: vms.length, vcpu, memGB };
}

export function footprintAt(vms: VM[], plans: PlanMap, at: Date, filter?: (v: VM) => boolean): Totals {
  const remaining = vms.filter((v) => {
    if (filter && !filter(v)) return false;
    const d = exitDate(planFor(plans, v.appKey));
    return !d || d > at;
  });
  return totals(remaining);
}

export interface Scenarios {
  /** Every scheduled move happens on time. */
  plan: Totals;
  /** Each move weighted by its confidence (headline forecast). */
  risk: Totals;
  /** Only High-confidence moves happen. */
  committed: Totals;
}

/** On-prem footprint remaining at a date under the three confidence scenarios. */
export function footprintScenarios(vms: VM[], plans: PlanMap, at: Date, weights: ConfidenceWeights = DEFAULT_WEIGHTS, filter?: (v: VM) => boolean): Scenarios {
  const z = () => ({ vms: 0, vcpu: 0, memGB: 0 });
  const plan = z(), risk = z(), committed = z();
  for (const v of vms) {
    if (filter && !filter(v)) continue;
    const p = planFor(plans, v.appKey);
    const d = exitDate(p);
    const gone = !!d && d <= at;
    const add = (t: Totals, f: number) => {
      t.vms += f;
      t.vcpu += v.vcpu * f;
      t.memGB += v.memGB * f;
    };
    add(plan, gone ? 0 : 1);
    add(risk, gone ? 1 - moveWeight(p.confidence, weights) : 1);
    add(committed, gone && p.confidence === 'high' ? 0 : 1);
  }
  return { plan, risk, committed };
}

export type Granularity = 'quarter' | 'fy';

export interface Period {
  label: string; // "FY28 Q1" or "FY28"
  fy: number;
  q: number; // 1-4 (4 for FY granularity)
  end: Date;
}

/** Reporting periods from the current quarter / FY up to the end of the horizon FY. */
export function periods(settings: Settings, gran: Granularity, today = new Date()): Period[] {
  const out: Period[] = [];
  if (gran === 'fy') {
    for (let fy = settings.currentFY; fy <= settings.horizonFY; fy++) out.push({ label: fyLabel(fy), fy, q: 4, end: fyEnd(fy) });
    return out;
  }
  const startQ = settings.currentFY === fyOf(today) ? fyQuarterOf(today) : 1;
  for (let fy = settings.currentFY; fy <= settings.horizonFY; fy++) {
    for (let q = fy === settings.currentFY ? startQ : 1; q <= 4; q++) {
      out.push({ label: quarterLabel(fy, q), fy, q, end: fyQuarterEnd(fy, q) });
    }
  }
  return out;
}

export function periodIndexFor(ps: Period[], d: Date): number {
  for (let i = 0; i < ps.length; i++) if (d <= ps[i].end) return i;
  return -1;
}

export interface TrendPoint {
  label: string;
  /** Risk-adjusted (headline) */
  vms: number;
  vcpu: number;
  vmsPct: number;
  vcpuPct: number;
  /** Full plan (best case) and committed (High confidence only) */
  vmsPlan: number;
  vcpuPlan: number;
  vmsCommit: number;
  vcpuCommit: number;
  vmsPlanPct: number;
  vcpuPlanPct: number;
  vmsCommitPct: number;
  vcpuCommitPct: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** "Now" plus the projected on-prem footprint at the end of each period up to the horizon. */
export function trend(vms: VM[], plans: PlanMap, settings: Settings, gran: Granularity = 'fy'): TrendPoint[] {
  const base = totals(vms);
  const pct = (n: number, d: number) => (d ? r1((n / d) * 100) : 0);
  const point = (label: string, sc: Scenarios): TrendPoint => ({
    label,
    vms: Math.round(sc.risk.vms), vcpu: Math.round(sc.risk.vcpu),
    vmsPct: pct(sc.risk.vms, base.vms), vcpuPct: pct(sc.risk.vcpu, base.vcpu),
    vmsPlan: sc.plan.vms, vcpuPlan: sc.plan.vcpu, vmsCommit: sc.committed.vms, vcpuCommit: sc.committed.vcpu,
    vmsPlanPct: pct(sc.plan.vms, base.vms), vcpuPlanPct: pct(sc.plan.vcpu, base.vcpu),
    vmsCommitPct: pct(sc.committed.vms, base.vms), vcpuCommitPct: pct(sc.committed.vcpu, base.vcpu),
  });
  const b = { vms: base.vms, vcpu: base.vcpu, memGB: base.memGB };
  const pts: TrendPoint[] = [point('Now', { plan: b, risk: b, committed: b })];
  const w = settings.confidenceWeights ?? DEFAULT_WEIGHTS;
  for (const p of periods(settings, gran)) pts.push(point(p.label, footprintScenarios(vms, plans, p.end, w)));
  return pts;
}

export type ExitRow = { label: string; total: number; apps: number } & Partial<Record<Disposition, number>>;

/** vCPU (or VMs) leaving on-prem in each period, split by disposition. Exits past the horizon are omitted. */
/** weighted = true multiplies each move by its confidence weight (risk-adjusted view). */
export function exitsBy(vms: VM[], plans: PlanMap, settings: Settings, metric: 'vcpu' | 'vms', gran: Granularity = 'fy', weighted = false): ExitRow[] {
  const ps = periods(settings, gran);
  const rows: ExitRow[] = ps.map((p) => ({ label: p.label, total: 0, apps: 0 }));
  const appSeen = ps.map(() => new Set<string>());
  for (const v of vms) {
    const d = exitDate(planFor(plans, v.appKey));
    if (!d) continue;
    let idx = periodIndexFor(ps, d);
    if (idx < 0) continue;
    if (d < new Date() && idx > 0) idx = 0;
    const r = rows[idx];
    const disp = planFor(plans, v.appKey).disposition;
    const w = weighted ? moveWeight(planFor(plans, v.appKey).confidence, settings.confidenceWeights ?? DEFAULT_WEIGHTS) : 1;
    const amt = (metric === 'vcpu' ? v.vcpu : 1) * w;
    r[disp] = (r[disp] ?? 0) + amt;
    r.total += amt;
    appSeen[idx].add(v.appKey);
  }
  rows.forEach((r, i) => (r.apps = appSeen[i].size));
  return rows;
}

export interface DispositionSummary {
  id: Disposition;
  apps: number;
  vms: number;
  vcpu: number;
  unscheduledVms: number;
}

export function byDisposition(vms: VM[], plans: PlanMap): DispositionSummary[] {
  const m = new Map<Disposition, DispositionSummary & { appSet: Set<string> }>();
  for (const d of DISPOSITIONS) m.set(d.id, { id: d.id, apps: 0, vms: 0, vcpu: 0, unscheduledVms: 0, appSet: new Set() });
  for (const v of vms) {
    const p = planFor(plans, v.appKey);
    const s = m.get(p.disposition)!;
    s.vms++;
    s.vcpu += v.vcpu;
    s.appSet.add(v.appKey);
    if (dispMeta(p.disposition).leavesOnPrem && !p.targetFY) s.unscheduledVms++;
  }
  return [...m.values()].map(({ appSet, ...s }) => ({ ...s, apps: appSet.size }));
}

export interface AppRow extends AppInfo {
  vms: VM[];
  vmCount: number;
  vcpu: number;
  memGB: number;
  storageGB: number;
  environments: string[];
  sites: string[];
  owner: string;
}

export function groupApps(vms: VM[]): AppRow[] {
  const m = new Map<string, AppRow>();
  for (const v of vms) {
    let r = m.get(v.appKey);
    if (!r) {
      r = { ...parseApp(v.appKey), vms: [], vmCount: 0, vcpu: 0, memGB: 0, storageGB: 0, environments: [], sites: [], owner: v.owner };
      m.set(v.appKey, r);
    }
    r.vms.push(v);
    r.vmCount++;
    r.vcpu += v.vcpu;
    r.memGB += v.memGB;
    r.storageGB += v.storageProvGB;
    if (!r.environments.includes(v.environment)) r.environments.push(v.environment);
    if (!r.sites.includes(v.site)) r.sites.push(v.site);
    if (!r.owner && v.owner) r.owner = v.owner;
  }
  return [...m.values()];
}

export interface StayBucket {
  id: 'retain_sovereignty' | 'retain_latency' | 'retain_maintain' | 'tbd' | 'unscheduled' | 'risk';
  label: string;
  color: string;
  vms: number;
  vcpu: number;
  apps: number;
}

/**
 * Why the footprint is still on-prem at a date (default: end of the horizon FY).
 * The buckets add up to the headline remaining footprint for the chosen basis.
 */
export function whatStays(vms: VM[], plans: PlanMap, settings: Settings, basis: 'risk' | 'plan', at: Date = fyEnd(settings.horizonFY)): StayBucket[] {
  const w = settings.confidenceWeights ?? DEFAULT_WEIGHTS;
  const defs: Omit<StayBucket, 'vms' | 'vcpu' | 'apps'>[] = [
    { id: 'retain_sovereignty', label: 'Stay – Data Sovereignty', color: 'var(--s6)' },
    { id: 'retain_latency', label: 'Stay – Latency', color: 'var(--s7)' },
    { id: 'retain_maintain', label: 'Stay – Maintain', color: 'var(--s8)' },
    { id: 'tbd', label: 'Undecided', color: 'var(--s-tbd)' },
    { id: 'unscheduled', label: 'Moving, but no target or after horizon', color: 'var(--text-3)' },
    { id: 'risk', label: 'Scheduled moves at risk (confidence shortfall)', color: 'var(--c-low)' },
  ];
  const acc = new Map(defs.map((d) => [d.id, { ...d, vms: 0, vcpu: 0, apps: 0, set: new Set<string>() }]));
  const add = (id: StayBucket['id'], v: VM, f: number) => {
    if (f <= 0) return;
    const r = acc.get(id)!;
    r.vms += f;
    r.vcpu += v.vcpu * f;
    r.set.add(v.appKey);
  };
  for (const v of vms) {
    const p = planFor(plans, v.appKey);
    const m = dispMeta(p.disposition);
    if (!m.leavesOnPrem) {
      add(p.disposition === 'tbd' ? 'tbd' : (p.disposition as StayBucket['id']), v, 1);
      continue;
    }
    const d = exitDate(p);
    if (!d || d > at) add('unscheduled', v, 1);
    else if (basis === 'risk') add('risk', v, 1 - moveWeight(p.confidence, w));
  }
  return [...acc.values()].map(({ set, ...r }) => ({ ...r, apps: set.size }));
}
