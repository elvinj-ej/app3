import { Fragment, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { DISP, DISPOSITIONS } from '../lib/dispositions';
import { fyLabel } from '../lib/fy';
import { groupApps, planFor, scopeVMs, type AppRow } from '../lib/projection';
import { parseApp, TIER_ORDER } from '../lib/parse';
import { fmt } from '../lib/useColors';
import type { AppPlan, Disposition, Quarter, VM } from '../lib/types';
import { downloadCSV } from '../lib/exporter';

type View = 'apps' | 'vms';
type SortDir = 1 | -1;
type AppSortKey = 'name' | 'domain' | 'tier' | 'vmCount' | 'vcpu' | 'disposition' | 'target';
type VmSortKey = 'name' | 'app' | 'domain' | 'tier' | 'environment' | 'location' | 'vcpu' | 'memGB' | 'disposition';

const tierRank = (t: string) => {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 99 : i;
};
const dispRank = (d: Disposition) => DISPOSITIONS.findIndex((x) => x.id === d);
const targetRank = (p: AppPlan) => (p.targetFY ? p.targetFY * 10 + (p.targetQ ?? 4) : 9999);

export default function Planner() {
  const { inventory, plans, settings, setPlan, setPlans } = useStore();
  const [view, setView] = useState<View>('apps');
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [tier, setTier] = useState('');
  const [disp, setDisp] = useState('');
  const [site, setSite] = useState('');
  const [env, setEnv] = useState('');
  const [sortApp, setSortApp] = useState<{ k: AppSortKey; d: SortDir }>({ k: 'vcpu', d: -1 });
  const [sortVm, setSortVm] = useState<{ k: VmSortKey; d: SortDir }>({ k: 'app', d: 1 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const vms = useMemo(() => scopeVMs(inventory.vms, settings), [inventory, settings]);
  const allApps = useMemo(() => groupApps(vms), [vms]);

  const domains = useMemo(() => [...new Set(allApps.map((a) => a.domain))].sort(), [allApps]);
  const tiers = useMemo(() => [...new Set(allApps.map((a) => a.tier))].sort((a, b) => tierRank(a) - tierRank(b)), [allApps]);
  const sites = useMemo(() => [...new Set(vms.map((v) => v.site))].sort(), [vms]);
  const envs = useMemo(() => [...new Set(vms.map((v) => v.environment))].sort(), [vms]);

  const fyOptions: number[] = [];
  for (let fy = settings.currentFY; fy <= settings.horizonFY + 2; fy++) fyOptions.push(fy);

  const ql = q.trim().toLowerCase();
  const vmMatches = (v: VM) =>
    (!site || v.site === site) &&
    (!env || v.environment === env);
  const appMatches = (a: AppRow) =>
    (!domain || a.domain === domain) &&
    (!tier || a.tier === tier) &&
    (!disp || planFor(plans, a.key).disposition === disp);

  const apps = useMemo(() => {
    const out = allApps
      .filter(appMatches)
      .filter((a) => (!site && !env) || a.vms.some(vmMatches))
      .filter((a) => !ql || a.key.toLowerCase().includes(ql) || a.owner.toLowerCase().includes(ql) || a.vms.some((v) => v.name.toLowerCase().includes(ql)));
    const { k, d } = sortApp;
    const val = (a: AppRow): string | number => {
      const p = planFor(plans, a.key);
      switch (k) {
        case 'name': return a.name.toLowerCase();
        case 'domain': return a.domain.toLowerCase() + '\u0000' + a.name.toLowerCase();
        case 'tier': return tierRank(a.tier);
        case 'vmCount': return a.vmCount;
        case 'vcpu': return a.vcpu;
        case 'disposition': return dispRank(p.disposition);
        case 'target': return targetRank(p);
      }
    };
    return out.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : b.vcpu - a.vcpu) * d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allApps, plans, domain, tier, disp, site, env, ql, sortApp]);

  const vmRows = useMemo(() => {
    if (view !== 'vms') return [];
    const out = vms.filter((v) => {
      const a = parseApp(v.appKey);
      return (
        vmMatches(v) &&
        (!domain || a.domain === domain) &&
        (!tier || a.tier === tier) &&
        (!disp || planFor(plans, v.appKey).disposition === disp) &&
        (!ql || v.name.toLowerCase().includes(ql) || v.appKey.toLowerCase().includes(ql) || v.owner.toLowerCase().includes(ql))
      );
    });
    const { k, d } = sortVm;
    const val = (v: VM): string | number => {
      const a = parseApp(v.appKey);
      switch (k) {
        case 'name': return v.name.toLowerCase();
        case 'app': return a.name.toLowerCase() + '\u0000' + v.name.toLowerCase();
        case 'domain': return a.domain.toLowerCase() + '\u0000' + a.name.toLowerCase() + '\u0000' + v.name.toLowerCase();
        case 'tier': return tierRank(a.tier) * 1000 + 0;
        case 'environment': return v.environment.toLowerCase();
        case 'location': return v.location.toLowerCase();
        case 'vcpu': return v.vcpu;
        case 'memGB': return v.memGB;
        case 'disposition': return dispRank(planFor(plans, v.appKey).disposition);
      }
    };
    return out.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, vms, plans, domain, tier, disp, site, env, ql, sortVm]);

  const shown = view === 'apps'
    ? { apps: apps.length, vms: apps.reduce((s, a) => s + a.vmCount, 0), vcpu: apps.reduce((s, a) => s + a.vcpu, 0) }
    : { apps: new Set(vmRows.map((v) => v.appKey)).size, vms: vmRows.length, vcpu: vmRows.reduce((s, v) => s + v.vcpu, 0) };
  const decided = allApps.filter((a) => planFor(plans, a.key).disposition !== 'tbd').length;

  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  const AppTh = ({ k, children, r }: { k: AppSortKey; children: React.ReactNode; r?: boolean }) => (
    <th className={`sortable${r ? ' r' : ''}`} aria-sort={sortApp.k === k ? (sortApp.d === 1 ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSortApp((s) => ({ k, d: s.k === k ? ((-s.d) as SortDir) : k === 'vcpu' || k === 'vmCount' ? -1 : 1 }))}>
      {children} {sortApp.k === k ? (sortApp.d === 1 ? '▲' : '▼') : ''}
    </th>
  );
  const VmTh = ({ k, children, r }: { k: VmSortKey; children: React.ReactNode; r?: boolean }) => (
    <th className={`sortable${r ? ' r' : ''}`} aria-sort={sortVm.k === k ? (sortVm.d === 1 ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSortVm((s) => ({ k, d: s.k === k ? ((-s.d) as SortDir) : k === 'vcpu' || k === 'memGB' ? -1 : 1 }))}>
      {children} {sortVm.k === k ? (sortVm.d === 1 ? '▲' : '▼') : ''}
    </th>
  );

  const exportView = () => {
    const rows = (view === 'apps' ? apps.flatMap((a) => a.vms.filter((v) => (!site && !env) || vmMatches(v))) : vmRows).map((v) => {
      const a = parseApp(v.appKey);
      const p = planFor(plans, v.appKey);
      return {
        VMName: v.name, Application_Primary: v.appKey, Application: a.name, Domain: a.domain, Tier: a.tier,
        Environment: v.environment, VCenter: v.vcenter, VMLocation: v.location, PowerState: v.poweredOn ? 'PoweredOn' : 'PoweredOff',
        vCPU: v.vcpu, MemoryGB: v.memGB, Disposition: DISP[p.disposition].label,
        TargetFY: p.targetFY ? fyLabel(p.targetFY) : '', TargetQuarter: p.targetFY ? `Q${p.targetQ ?? 4}` : '', Notes: p.notes ?? '',
      };
    });
    downloadCSV(`footprint-plan-${view}.csv`, rows);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Application planner</h1>
          <p>
            Capture a disposition and target FY for each application (from <code>Application_Primary</code>). {decided} of{' '}
            {allApps.length} applications decided. Changes save automatically in this browser.
          </p>
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={view === 'apps'} onClick={() => setView('apps')}>By application</button>
            <button aria-pressed={view === 'vms'} onClick={() => setView('vms')}>By VM</button>
          </div>
          <button className="btn" onClick={exportView}>Export CSV</button>
        </div>
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 12 }}>
          <div className="filters">
            <input className="input" placeholder="Search application, VM or owner…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="select" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
              <option value="">All domains</option>
              {domains.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select className="select" value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
              <option value="">All tiers</option>
              {tiers.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select className="select" value={disp} onChange={(e) => setDisp(e.target.value)} aria-label="Disposition">
              <option value="">All dispositions</option>
              {DISPOSITIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <select className="select" value={site} onChange={(e) => setSite(e.target.value)} aria-label="vCenter">
              <option value="">All vCenters</option>
              {sites.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select className="select" value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
              <option value="">All environments</option>
              {envs.map((d) => <option key={d}>{d}</option>)}
            </select>
            {(q || domain || tier || disp || site || env) && (
              <button className="btn btn-sm" onClick={() => { setQ(''); setDomain(''); setTier(''); setDisp(''); setSite(''); setEnv(''); }}>Clear</button>
            )}
            <span className="note" style={{ marginLeft: 'auto' }}>
              {shown.apps} apps · {fmt(shown.vms)} VMs · {fmt(shown.vcpu)} vCPU
            </span>
          </div>
        </div>

        {view === 'apps' ? (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" aria-label="Select all"
                      checked={apps.length > 0 && apps.every((a) => selected.has(a.key))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(apps.map((a) => a.key)) : new Set())} />
                  </th>
                  <th style={{ width: 20 }} />
                  <AppTh k="name">Application</AppTh>
                  <AppTh k="domain">Domain</AppTh>
                  <AppTh k="tier">Tier</AppTh>
                  <AppTh k="vmCount" r>VMs</AppTh>
                  <AppTh k="vcpu" r>vCPU</AppTh>
                  <th>Envs</th>
                  <AppTh k="disposition">Disposition</AppTh>
                  <AppTh k="target">Leaves on-prem</AppTh>
                  <th style={{ minWidth: 180 }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => {
                  const p = planFor(plans, a.key);
                  const meta = DISP[p.disposition];
                  const open = expanded.has(a.key);
                  const subVms = (!site && !env) ? a.vms : a.vms.filter(vmMatches);
                  return (
                    <Fragment key={a.key}>
                      <tr className={selected.has(a.key) ? 'sel' : undefined}>
                        <td><input type="checkbox" aria-label={`Select ${a.name}`} checked={selected.has(a.key)} onChange={() => setSelected((s) => toggle(s, a.key))} /></td>
                        <td><button className="expander" aria-expanded={open} aria-label="Show VMs" onClick={() => setExpanded((s) => toggle(s, a.key))}>{open ? '▼' : '▶'}</button></td>
                        <td style={{ minWidth: 220 }}>
                          <div className="app-name">{a.name}</div>
                          <div className="app-svc">{a.service}{a.owner ? ` · ${a.owner}` : ''}</div>
                        </td>
                        <td>{a.domain}</td>
                        <td className="muted">{a.tier}</td>
                        <td className="r num">{a.vmCount}</td>
                        <td className="r num"><b>{fmt(a.vcpu)}</b></td>
                        <td><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{a.environments.map((e) => <span className="chip" key={e}>{e}</span>)}</div></td>
                        <td>
                          <div className="disp-cell">
                            <i className="dot" style={{ background: meta.color }} />
                            <select className="select select-sm" value={p.disposition} title={meta.help}
                              onChange={(e) => setPlan(a.key, { disposition: e.target.value as Disposition })}>
                              {DISPOSITIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                            </select>
                          </div>
                        </td>
                        <td>
                          <TargetPicker plan={p} fyOptions={fyOptions} onChange={(patch) => setPlan(a.key, patch)} />
                        </td>
                        <td><NotesInput value={p.notes ?? ''} onCommit={(notes) => setPlan(a.key, { notes })} /></td>
                      </tr>
                      {open && subVms.map((v) => (
                        <tr className="sub" key={v.name}>
                          <td /><td />
                          <td colSpan={2}>{v.name} <span className="muted">· {v.os || 'OS n/a'}</span></td>
                          <td className="muted">{v.site}</td>
                          <td className="muted" colSpan={1}>{v.poweredOn ? 'On' : 'Off'}</td>
                          <td className="r num">{v.vcpu}</td>
                          <td><span className="chip">{v.environment}</span></td>
                          <td className="muted" colSpan={3}>{v.location} · {fmt(v.memGB)} GB RAM · {fmt(v.storageProvGB)} GB disk</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {apps.length === 0 && <tr><td colSpan={11} className="empty">No applications match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table className="t">
              <thead>
                <tr>
                  <VmTh k="name">VM</VmTh>
                  <VmTh k="app">Application</VmTh>
                  <VmTh k="domain">Domain</VmTh>
                  <VmTh k="tier">Tier</VmTh>
                  <VmTh k="environment">Env</VmTh>
                  <VmTh k="location">Location</VmTh>
                  <VmTh k="vcpu" r>vCPU</VmTh>
                  <VmTh k="memGB" r>RAM GB</VmTh>
                  <VmTh k="disposition">Disposition (app)</VmTh>
                  <th>Leaves</th>
                </tr>
              </thead>
              <tbody>
                {vmRows.slice(0, 1500).map((v) => {
                  const a = parseApp(v.appKey);
                  const p = planFor(plans, v.appKey);
                  const meta = DISP[p.disposition];
                  return (
                    <tr key={v.name + v.vcenter}>
                      <td>{v.name}{!v.poweredOn && <span className="chip" style={{ marginLeft: 6 }}>Off</span>}</td>
                      <td><div className="app-name">{a.name}</div></td>
                      <td>{a.domain}</td>
                      <td className="muted">{a.tier}</td>
                      <td><span className="chip">{v.environment}</span></td>
                      <td className="muted">{v.site} · {v.location}</td>
                      <td className="r num">{v.vcpu}</td>
                      <td className="r num">{fmt(v.memGB)}</td>
                      <td><span className="chip"><i className="dot" style={{ background: meta.color }} />{meta.short}</span></td>
                      <td className="muted">{p.targetFY && meta.leavesOnPrem ? `${fyLabel(p.targetFY)} Q${p.targetQ ?? 4}` : '—'}</td>
                    </tr>
                  );
                })}
                {vmRows.length === 0 && <tr><td colSpan={10} className="empty">No VMs match these filters.</td></tr>}
              </tbody>
            </table>
            {vmRows.length > 1500 && <p className="note card-pad">Showing first 1,500 of {fmt(vmRows.length)} VMs – narrow the filters to see more.</p>}
            <p className="note" style={{ padding: '8px 12px' }}>Dispositions are set per application – switch to "By application" to edit.</p>
          </div>
        )}
      </div>

      {view === 'apps' && selected.size > 0 && (
        <BulkBar count={selected.size} fyOptions={fyOptions}
          onApply={(patch) => { setPlans([...selected], patch); }}
          onClear={() => setSelected(new Set())} />
      )}
    </div>
  );
}

function TargetPicker({ plan, fyOptions, onChange }: { plan: AppPlan; fyOptions: number[]; onChange: (p: Partial<AppPlan>) => void }) {
  const leaves = DISP[plan.disposition].leavesOnPrem;
  if (!leaves) return <span className="muted">{plan.disposition === 'tbd' ? '—' : 'Stays'}</span>;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <select className="select select-sm" value={plan.targetFY ?? ''} aria-label="Target FY"
        style={!plan.targetFY ? { borderColor: 'var(--warn-ink)' } : undefined}
        onChange={(e) => onChange({ targetFY: e.target.value ? Number(e.target.value) : undefined })}>
        <option value="">FY…</option>
        {fyOptions.map((fy) => <option key={fy} value={fy}>{fyLabel(fy)}</option>)}
      </select>
      <select className="select select-sm" value={plan.targetQ ?? 4} aria-label="Target quarter" disabled={!plan.targetFY}
        onChange={(e) => onChange({ targetQ: Number(e.target.value) as Quarter })}>
        <option value={1}>Q1 (Jul–Sep)</option>
        <option value={2}>Q2 (Oct–Dec)</option>
        <option value={3}>Q3 (Jan–Mar)</option>
        <option value={4}>Q4 (Apr–Jun)</option>
      </select>
    </div>
  );
}

function NotesInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setV(value);
  }
  return (
    <input className="input select-sm" style={{ width: '100%' }} value={v} placeholder="Add note…"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

function BulkBar({ count, fyOptions, onApply, onClear }: { count: number; fyOptions: number[]; onApply: (p: Partial<AppPlan>) => void; onClear: () => void }) {
  const [d, setD] = useState<Disposition | ''>('');
  const [fy, setFy] = useState<string>('');
  const [qtr, setQtr] = useState<string>('');
  return (
    <div className="bulkbar">
      <b>{count} selected</b>
      <select className="select select-sm" value={d} onChange={(e) => setD(e.target.value as Disposition)} aria-label="Bulk disposition">
        <option value="">Disposition (unchanged)</option>
        {DISPOSITIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <select className="select select-sm" value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Bulk FY">
        <option value="">Target FY (unchanged)</option>
        {fyOptions.map((f) => <option key={f} value={f}>{fyLabel(f)}</option>)}
      </select>
      <select className="select select-sm" value={qtr} onChange={(e) => setQtr(e.target.value)} aria-label="Bulk quarter">
        <option value="">Quarter (unchanged)</option>
        {[1, 2, 3, 4].map((x) => <option key={x} value={x}>Q{x}</option>)}
      </select>
      <button className="btn btn-sm" disabled={!d && !fy && !qtr}
        onClick={() => {
          const patch: Partial<AppPlan> = {};
          if (d) patch.disposition = d;
          if (fy) patch.targetFY = Number(fy);
          if (qtr) patch.targetQ = Number(qtr) as Quarter;
          onApply(patch);
        }}>Apply</button>
      <button className="btn btn-sm" onClick={onClear} style={{ marginLeft: 'auto' }}>Clear selection</button>
    </div>
  );
}
