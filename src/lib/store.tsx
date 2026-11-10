import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, setApiUser } from './api';
import { setDomainOverrides } from './parse';
import { defaultSettings } from './defaults';
import type { AppPlan, Inventory, PlanMap, Settings, UploadMeta } from './types';

export { defaultVendor, vendorOf } from './defaults';

const EMPTY_INV: Inventory = { sourceFile: '', loadedAt: '', isDemo: false, vms: [], clusters: [] };
const POLL_MS = 8000;

interface StateResponse {
  rev: number;
  settings: Settings;
  plans: PlanMap;
  latestUpload: UploadMeta | null;
  uploadCount: number;
  rulesRev?: string;
  staged?: StagedUpload[];
  attention?: Attention | null;
}

export interface StagedUpload { id: number; filename: string; uploadedBy: string; uploadedAt: string }
export interface Attention { uploadId: number; by: string; at: string; count: number; revert?: boolean }

interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

interface Store {
  ready: boolean;
  connError: string | null;
  user: string;
  setUser: (u: string) => void;
  hasInventory: boolean;
  inventory: Inventory;
  latestUpload: UploadMeta | null;
  plans: PlanMap;
  settings: Settings;
  rev: number;
  setPlan: (key: string, patch: Partial<AppPlan>) => Promise<void>;
  setPlans: (keys: string[], patch: Partial<AppPlan>) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  uploadInventory: (file: File, note: string, force?: boolean) => Promise<UploadMeta>;
  staged: StagedUpload[];
  attention: Attention | null;
  renamePlan: (from: string, to: string) => Promise<void>;
  importPlans: (plans: PlanMap) => Promise<number>;
  refresh: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
}

const Ctx = createContext<Store | null>(null);

function readUser(): string {
  try {
    return localStorage.getItem('fp.user') ?? '';
  } catch {
    return '';
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState(() => {
    const u = readUser();
    setApiUser(u);
    return u;
  });
  const [ready, setReady] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [latestUpload, setLatestUpload] = useState<UploadMeta | null>(null);
  const [plans, setPlansState] = useState<PlanMap>({});
  const [settings, setSettingsRaw] = useState<Settings>(defaultSettings());
  // Domain overrides must be registered before anything renders with the new settings.
  const setSettings = useCallback((v: Settings | ((s: Settings) => Settings)) => {
    setSettingsRaw((prev) => {
      const next = typeof v === 'function' ? (v as (s: Settings) => Settings)(prev) : v;
      setDomainOverrides(next.domainOverrides);
      return next;
    });
  }, []);
  const [rev, setRev] = useState(-1);
  const [staged, setStaged] = useState<StagedUpload[]>([]);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const invIdRef = useRef<string | null>(null);
  const revRef = useRef(-1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    const s = await api<StateResponse>('/state');
    setPlansState(s.plans);
    setSettings(s.settings);
    setLatestUpload(s.latestUpload);
    setStaged(s.staged ?? []);
    setAttention(s.attention ?? null);
    revRef.current = s.rev;
    setRev(s.rev);
    const latestId = s.latestUpload?.id ?? null;
    const tag = latestId ? `${latestId}|${s.rulesRev ?? ''}` : null;
    if (tag !== invIdRef.current) {
      const inv = latestId ? await api<Inventory>('/inventory/latest') : null;
      invIdRef.current = tag;
      setInventory(inv);
    }
    setConnError(null);
    setReady(true);
  }, []);

  // initial load + poll for other people's changes
  useEffect(() => {
    let stop = false;
    refresh().catch((e) => setConnError(e instanceof Error ? e.message : String(e)));
    const t = setInterval(async () => {
      if (stop || document.hidden) return;
      try {
        const { rev: r } = await api<{ rev: number }>('/rev');
        if (r !== revRef.current) await refresh();
        else setConnError(null);
      } catch (e) {
        setConnError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [refresh]);

  const setUser = useCallback((u: string) => {
    const clean = u.trim().slice(0, 80);
    try {
      localStorage.setItem('fp.user', clean);
    } catch {
      /* ignore */
    }
    setApiUser(clean);
    setUserState(clean);
  }, []);

  const setPlan = useCallback(
    async (key: string, patch: Partial<AppPlan>) => {
      const before = plans[key];
      setPlansState((p) => ({ ...p, [key]: { ...(p[key] ?? { disposition: 'tbd' as const }), ...patch } }));
      try {
        const r = await api<{ plan: AppPlan }>('/plans', { method: 'PUT', json: { key, plan: patch, baseVersion: before?.version ?? 0 } });
        setPlansState((p) => ({ ...p, [key]: r.plan }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const cur = e.body.current as AppPlan | null;
          setPlansState((p) => {
            const n = { ...p };
            if (cur) n[key] = cur;
            else delete n[key];
            return n;
          });
          toast(`${e.message} – their version is now shown. Re-apply your change if still needed.`, 'error');
        } else {
          setPlansState((p) => {
            const n = { ...p };
            if (before) n[key] = before;
            else delete n[key];
            return n;
          });
          toast(`Could not save: ${e instanceof Error ? e.message : e}`, 'error');
        }
      }
    },
    [plans, toast],
  );

  const setPlans = useCallback(
    async (keys: string[], patch: Partial<AppPlan>) => {
      try {
        const r = await api<{ plans: PlanMap }>('/plans/bulk', { json: { keys, patch } });
        setPlansState((p) => ({ ...p, ...r.plans }));
        toast(`Updated ${keys.length} applications`);
      } catch (e) {
        toast(`Could not save: ${e instanceof Error ? e.message : e}`, 'error');
      }
    },
    [toast],
  );

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings((s) => ({ ...s, ...patch }));
      try {
        const r = await api<{ settings: Settings }>('/settings', { method: 'PUT', json: patch });
        setSettings(r.settings);
      } catch (e) {
        toast(`Could not save settings: ${e instanceof Error ? e.message : e}`, 'error');
        refresh().catch(() => undefined);
      }
    },
    [toast, refresh],
  );

  const uploadInventory = useCallback(
    async (file: File, note: string, force = false) => {
      const r = await api<{ upload: UploadMeta; report: unknown }>(`/uploads${force ? '?force=1' : ''}`, {
        raw: file,
        headers: { 'x-filename': encodeURIComponent(file.name), 'x-note': encodeURIComponent(note) },
      });
      await refresh();
      return r.upload;
    },
    [refresh],
  );

  const renamePlan = useCallback(
    async (from: string, to: string) => {
      await api('/plans/rename', { json: { from, to } });
      await refresh();
    },
    [refresh],
  );

  const importPlans = useCallback(
    async (p: PlanMap) => {
      const r = await api<{ imported: number }>('/plans/import', { json: { plans: p } });
      await refresh();
      return r.imported;
    },
    [refresh],
  );

  const value = useMemo<Store>(
    () => ({
      ready, connError, user, setUser,
      hasInventory: !!inventory,
      inventory: inventory ?? EMPTY_INV,
      latestUpload, plans, settings, rev,
      setPlan, setPlans, updateSettings, uploadInventory, renamePlan, importPlans, refresh, toast, toasts, staged, attention,
    }),
    [ready, connError, user, setUser, inventory, latestUpload, plans, settings, rev, setPlan, setPlans, updateSettings, uploadInventory, renamePlan, importPlans, refresh, toast, toasts, staged, attention],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}
