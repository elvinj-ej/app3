import { NO_APP, parseApp } from './parse.ts';
import type { AppRule, Inventory, RuleEffect, VM } from './types.ts';

/**
 * Apply mapping rules to an inventory. VM rules (by VM name) win over merge rules; merge rules
 * follow chains (A→B, B→C) up to a few steps. Returns a new inventory plus per-rule effects.
 */
export function applyRules(inv: Inventory, rules: AppRule[]): { inventory: Inventory; effects: Record<number, RuleEffect> } {
  const effects: Record<number, RuleEffect> = Object.fromEntries(rules.map((r) => [r.id, { vms: 0, vcpu: 0 }]));
  if (!rules.length) return { inventory: inv, effects };
  const vmRules = new Map(rules.filter((r) => r.kind === 'vm').map((r) => [r.source.toLowerCase(), r]));
  const merges = new Map(rules.filter((r) => r.kind === 'merge').map((r) => [r.source, r]));
  const vms: VM[] = inv.vms.map((v) => {
    const orig = v.appKey;
    let key = orig;
    const vr = vmRules.get(v.name.toLowerCase());
    if (vr) {
      key = vr.target;
      effects[vr.id].vms++;
      effects[vr.id].vcpu += v.vcpu;
      if (orig && orig !== NO_APP && orig !== vr.target) effects[vr.id].conflict = orig;
    }
    for (let i = 0; i < 5; i++) {
      const m = merges.get(key);
      if (!m || m.target === key) break;
      key = m.target;
      effects[m.id].vms++;
      effects[m.id].vcpu += v.vcpu;
    }
    return key === orig ? v : { ...v, appKey: key, origAppKey: orig };
  });
  // Merged applications shown with components: every VM of the target is labelled with the service of its original label.
  const compTargets = new Set(rules.filter((r) => r.kind === 'merge' && r.components).map((r) => finalTarget(r.target, merges)));
  const out = compTargets.size
    ? vms.map((v) => (compTargets.has(v.appKey) ? { ...v, component: componentName(v.origAppKey && v.origAppKey !== NO_APP ? v.origAppKey : v.appKey) } : v))
    : vms;
  return { inventory: { ...inv, vms: out }, effects };
}

function finalTarget(key: string, merges: Map<string, AppRule>): string {
  for (let i = 0; i < 5; i++) {
    const m = merges.get(key);
    if (!m || m.target === key) break;
    key = m.target;
  }
  return key;
}

/** Component label for an Application_Primary: its service text, else its name. */
export function componentName(key: string): string {
  const a = parseApp(key);
  return a.service || a.name;
}
