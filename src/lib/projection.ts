import { DISP, DISPOSITIONS } from './dispositions';
import { fyEnd, fyLabel, fyQuarterEnd } from './fy';
import { parseApp } from './parse';
import type { AppInfo, AppPlan, Disposition, PlanMap, Settings, VM } from './types';

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

export interface TrendPoint {
  label: string;
  vms: number;
  vcpu: number;
  vmsPct: number;
  vcpuPct: number;
}

/** "Now" plus the projected on-prem footprint at the end of each FY up to the horizon. */
export function trend(vms: VM[], plans: PlanMap, settings: Settings): TrendPoint[] {
  const base = totals(vms);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const pts: TrendPoint[] = [
    { label: 'Now', vms: base.vms, vcpu: base.vcpu, vmsPct: 100, vcpuPct: 100 },
  ];
  for (let fy = settings.currentFY; fy <= settings.horizonFY; fy++) {
    const t = footprintAt(vms, plans, fyEnd(fy));
    pts.push({ label: fyLabel(fy), vms: t.vms, vcpu: t.vcpu, vmsPct: pct(t.vms, base.vms), vcpuPct: pct(t.vcpu, base.vcpu) });
  }
  return pts;
}

export type ExitRow = { label: string; total: number } & Partial<Record<Disposition, number>>;

/** vCPU (or VMs) leaving on-prem in each FY, split by disposition. */
export function exitsByFY(vms: VM[], plans: PlanMap, settings: Settings, metric: 'vcpu' | 'vms'): ExitRow[] {
  const rows: ExitRow[] = [];
  for (let fy = settings.currentFY; fy <= settings.horizonFY; fy++) {
    rows.push({ label: fyLabel(fy), total: 0 });
  }
  for (const v of vms) {
    const p = planFor(plans, v.appKey);
    if (!DISP[p.disposition].leavesOnPrem || !p.targetFY) continue;
    const idx = Math.min(Math.max(p.targetFY, settings.currentFY), settings.horizonFY) - settings.currentFY;
    const r = rows[idx];
    const amt = metric === 'vcpu' ? v.vcpu : 1;
    r[p.disposition] = (r[p.disposition] ?? 0) + amt;
    r.total += amt;
  }
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
