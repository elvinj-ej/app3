import { DISP, DISPOSITIONS } from './dispositions.ts';
import { fyEnd, fyLabel, fyOf, fyQuarterEnd, fyQuarterOf, quarterLabel } from './fy.ts';
import { parseApp } from './parse.ts';
import type { AppInfo, AppPlan, Disposition, PlanMap, Settings, VM } from './types.ts';

export const DEFAULT_PLAN: AppPlan = { disposition: 'tbd' };

export function planFor(plans: PlanMap, key: string): AppPlan {
  return plans[key] ?? DEFAULT_PLAN;
}

/** The date an application is treated as gone from on-prem, or null if it stays / is unscheduled. */
export function exitDate(plan: AppPlan): Date | null {
  if (!DISP[plan.disposition].leavesOnPrem || !plan.targetFY) return null;
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
  vms: number;
  vcpu: number;
  vmsPct: number;
  vcpuPct: number;
}

/** "Now" plus the projected on-prem footprint at the end of each period up to the horizon. */
export function trend(vms: VM[], plans: PlanMap, settings: Settings, gran: Granularity = 'fy'): TrendPoint[] {
  const base = totals(vms);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const pts: TrendPoint[] = [{ label: 'Now', vms: base.vms, vcpu: base.vcpu, vmsPct: 100, vcpuPct: 100 }];
  for (const p of periods(settings, gran)) {
    const t = footprintAt(vms, plans, p.end);
    pts.push({ label: p.label, vms: t.vms, vcpu: t.vcpu, vmsPct: pct(t.vms, base.vms), vcpuPct: pct(t.vcpu, base.vcpu) });
  }
  return pts;
}

export type ExitRow = { label: string; total: number; apps: number } & Partial<Record<Disposition, number>>;

/** vCPU (or VMs) leaving on-prem in each period, split by disposition. Exits past the horizon are omitted. */
export function exitsBy(vms: VM[], plans: PlanMap, settings: Settings, metric: 'vcpu' | 'vms', gran: Granularity = 'fy'): ExitRow[] {
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
    const amt = metric === 'vcpu' ? v.vcpu : 1;
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
    if (DISP[p.disposition].leavesOnPrem && !p.targetFY) s.unscheduledVms++;
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
