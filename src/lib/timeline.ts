import { DISPOSITIONS, dispMeta } from './dispositions.ts';
import { fyLabel } from './fy.ts';
import { groupApps, heldBySovereignty, planFor, scopeVMs } from './projection.ts';
import type { PlanMap, Settings, VM } from './types.ts';

export interface TimelineEntry {
  key: string;
  name: string;
  vms: number;
  vcpu: number;
  q?: number;
  conf?: string;
}

export interface Timeline {
  /** Column labels: one per FY in the horizon, then "Later / no target". */
  cols: string[];
  /** Moving treatments → entries per column. */
  move: Record<string, TimelineEntry[][]>;
  /** Stay-on-prem treatments → entries (no timing). Sovereignty includes pinned clusters. */
  stay: Record<string, TimelineEntry[]>;
  undecided: TimelineEntry[];
  /** Virtualization resources – excluded from the footprint, listed for reference. */
  virt: TimelineEntry[];
}

/**
 * Treatment timeline matrix (treatment × FY). `allVms` is the full inventory; footprint scoping
 * (powered-off, virtualization exclusion, sovereignty pins) is applied here.
 */
export function buildTimeline(allVms: VM[], plans: PlanMap, settings: Settings): Timeline {
  const vms = scopeVMs(allVms, settings, plans);
  const sov = settings.sovereignClusters ?? {};
  const cols: string[] = [];
  for (let fy = settings.currentFY; fy <= settings.horizonFY; fy++) cols.push(fyLabel(fy));
  cols.push('Later / no target');
  const move: Timeline['move'] = {};
  const stay: Timeline['stay'] = {};
  const undecided: TimelineEntry[] = [];
  const pinned = new Map<string, TimelineEntry>();
  for (const d of DISPOSITIONS) if (d.leavesOnPrem) move[d.id] = cols.map(() => []);
  for (const a of groupApps(vms)) {
    const p = planFor(plans, a.key);
    const m = dispMeta(p.disposition);
    // Pinned VMs that would otherwise move (or are undecided) are listed under Sovereignty-bound by cluster.
    const held = a.vms.filter((v) => heldBySovereignty(v, p) || (v.pinned && m.group === 'Undecided'));
    for (const v of held) {
      const e = pinned.get(v.location) ?? { key: `pin:${v.location}`, name: `Pinned cluster ${v.location}${sov[v.location] ? ` (${sov[v.location]})` : ''}`, vms: 0, vcpu: 0 };
      e.vms++;
      e.vcpu += v.vcpu;
      pinned.set(v.location, e);
    }
    const rest = a.vms.filter((v) => !held.includes(v));
    if (!rest.length) continue;
    const e: TimelineEntry = { key: a.key, name: a.name, vms: rest.length, vcpu: rest.reduce((x, v) => x + v.vcpu, 0), q: p.targetFY ? (p.targetQ ?? 4) : undefined, conf: p.confidence };
    if (m.leavesOnPrem) {
      const inRange = p.targetFY && p.targetFY >= settings.currentFY && p.targetFY <= settings.horizonFY;
      move[p.disposition][inRange ? p.targetFY! - settings.currentFY : cols.length - 1].push(e);
    } else if (m.group === 'Retain') (stay[p.disposition] ??= []).push(e);
    else undecided.push(e);
  }
  stay.retain_sovereignty = [...(stay.retain_sovereignty ?? []), ...pinned.values()];
  const virtVms = scopeVMs(allVms, settings).filter((v) => planFor(plans, v.appKey).disposition === 'virt_resource');
  const virt = groupApps(virtVms).map((a) => ({ key: a.key, name: a.name, vms: a.vmCount, vcpu: a.vcpu }));
  const bySize = (x: TimelineEntry, y: TimelineEntry) => y.vms - x.vms || x.name.localeCompare(y.name);
  for (const k of Object.keys(move)) move[k].forEach((c) => c.sort(bySize));
  for (const k of Object.keys(stay)) stay[k].sort(bySize);
  undecided.sort(bySize);
  virt.sort(bySize);
  return { cols, move, stay, undecided, virt };
}

export const sumVms = (es: TimelineEntry[]) => es.reduce((x, e) => x + e.vms, 0);
export const sumVcpu = (es: TimelineEntry[]) => es.reduce((x, e) => x + e.vcpu, 0);
