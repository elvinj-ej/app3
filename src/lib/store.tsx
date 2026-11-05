import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fyOf } from './fy';
import { makeDemoInventory } from './demo';
import type { AppPlan, Deadline, HwVendor, Inventory, PlanMap, Settings } from './types';

const K_INV = 'fp.inventory.v1';
const K_PLAN = 'fp.plan.v1';
const K_SET = 'fp.settings.v1';

function load<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Could not persist', key, e);
  }
}

export const DEFAULT_DEADLINES: Deadline[] = [
  { id: 'vmware', label: 'VMware (Broadcom VCF) renewal', date: '2027-12-31', kind: 'VMware', confirmed: false, note: 'Subscription term end – set the contract date' },
  { id: 'cisco', label: 'Cisco HyperFlex HW renewal', date: '2028-06-30', kind: 'Cisco', confirmed: false, note: 'HX support / refresh – set the contract date' },
  { id: 'lenovo', label: 'Lenovo HW renewal', date: '2029-03-31', kind: 'Lenovo', confirmed: false, note: 'Server warranty / refresh – set the contract date' },
];

export function defaultVendor(clusterName: string): HwVendor {
  return /-HX-/i.test(clusterName) ? 'Cisco' : 'Lenovo';
}

function defaultSettings(): Settings {
  const fy = fyOf(new Date());
  return { currentFY: fy, horizonFY: fy + 5, includePoweredOff: false, deadlines: DEFAULT_DEADLINES, clusterVendor: {} };
}

interface Store {
  inventory: Inventory;
  plans: PlanMap;
  settings: Settings;
  setInventory: (inv: Inventory) => void;
  setPlan: (key: string, patch: Partial<AppPlan>) => void;
  setPlans: (keys: string[], patch: Partial<AppPlan>) => void;
  replacePlans: (p: PlanMap) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetAll: () => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [inventory, setInv] = useState<Inventory>(() => load<Inventory>(K_INV) ?? makeDemoInventory());
  const [plans, setPlansState] = useState<PlanMap>(() => load<PlanMap>(K_PLAN) ?? {});
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaultSettings(), ...(load<Settings>(K_SET) ?? {}) }));

  useEffect(() => save(K_INV, inventory), [inventory]);
  useEffect(() => save(K_PLAN, plans), [plans]);
  useEffect(() => save(K_SET, settings), [settings]);

  const setPlans = useCallback((keys: string[], patch: Partial<AppPlan>) => {
    setPlansState((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        const merged: AppPlan = { ...(prev[k] ?? { disposition: 'tbd' }), ...patch };
        if (merged.disposition === 'tbd' && !merged.notes && !merged.targetFY) delete next[k];
        else next[k] = merged;
      }
      return next;
    });
  }, []);

  const value = useMemo<Store>(
    () => ({
      inventory,
      plans,
      settings,
      setInventory: setInv,
      setPlan: (key, patch) => setPlans([key], patch),
      setPlans,
      replacePlans: setPlansState,
      updateSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
      resetAll: () => {
        setInv(makeDemoInventory());
        setPlansState({});
        setSettings(defaultSettings());
      },
    }),
    [inventory, plans, settings, setPlans],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

export function vendorOf(settings: Settings, cluster: string): HwVendor {
  return settings.clusterVendor[cluster] ?? defaultVendor(cluster);
}
