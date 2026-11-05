import { Fragment, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { DISPOSITIONS, dispMeta } from '../lib/dispositions';
import { fyLabel, fyOf, fyQuarterOf, quarterLabel, quarterRange } from '../lib/fy';
import { groupApps, heldBySovereignty, planFor, scopeVMs, type AppRow } from '../lib/projection';
import { parseApp, TIER_ORDER } from '../lib/parse';
import { fmt } from '../lib/useColors';
import type { AppPlan, Confidence, ConfidenceWeights, Disposition, Quarter, VM } from '../lib/types';
import { CONFIDENCE, CONFIDENCE_LABEL } from '../lib/defaults';
import { downloadCSV } from '../lib/exporter';
import { api } from '../lib/api';
import { HistoryRow, timeAgo, fmtDateTime } from '../components/common';
import type { HistoryEntry } from '../lib/types';

type View = 'apps' | 'vms';
type SortDir = 1 | -1;
type AppSortKey = 'name' | 'domain' | 'tier' | 'vmCount' | 'vcpu' | 'disposition' | 'target' | 'confidence';
type VmSortKey = 'name' | 'app' | 'domain' | 'tier' | 'environment' | 'location' | 'vcpu' | 'memGB' | 'disposition';

const tierRank = (t: string) => {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 99 : i;
};
const dispRank = (d: Disposition) => DISPOSITIONS.findIndex((x) => x.id === d);
const confRank = (p: AppPlan) => (dispMeta(p.disposition).leavesOnPrem ? (p.confidence ? ['high', 'medium', 'low', 'unknown'].indexOf(p.confidence) : 4) : 5);
const targetRank = (p: AppPlan) => (p.targetFY ? p.targetFY * 10 + (p.targetQ ?? 4) : p.reviewFY ? 5000 + p.reviewFY * 10 + (p.reviewQ ?? 4) : 9999);

export default function Planner() {
  const { inventory, plans, settings, setPlan, setPlans } = useStore();
  const [view, setView] = useState<View>('apps');
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [tier, setTier] = useState('');
  const [disp, setDisp] = useState('');
  const [conf, setConf] = useState('');
  const [site, setSite] = useState('');
  const [env, setEnv] = useState('');
  const [loc, setLoc] = useState('');
  const [sortApp, setSortApp] = useState<{ k: AppSortKey; d: SortDir }>({ k: 'vcpu', d: -1 });
  const [sortVm, setSortVm] = useState<{ k: VmSortKey; d: SortDir }>({ k: 'app', d: 1 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const vms = useMemo(() => scopeVMs(inventory.vms, settings), [inventory, settings]);
  const allApps = useMemo(() => groupApps(vms), [vms]);

  const domains = useMemo(() => [...new Set(allApps.map((a) => a.domain))].sort(), [allApps]);
  const tiers = useMemo(() => [...new Set(allApps.map((a) => a.tier))].sort((a, b) => tierRank(a) - tierRank(b)), [allApps]);
  const sites = useMemo(() => [...new Set(vms.map((v) => v.site))].sort(), [vms]);
  const locs = useMemo(() => [...new Set(vms.map((v) => v.location))].sort(), [vms]);
  const sov = settings.sovereignClusters ?? {};
  const envs = useMemo(() => [...new Set(vms.map((v) => v.environment))].sort(), [vms]);

  const targetOptions = useMemo(() => {
    const out: { fy: number; q: number }[] = [];
    const now = new Date();
    for (let fy = settings.currentFY; fy <= settings.horizonFY + 2; fy++) {
      for (let q = 1; q <= 4; q++) {
        if (fy === fyOf(now) && q < fyQuarterOf(now)) continue;
        out.push({ fy, q });
      }
    }
    return out;
  }, [settings.currentFY, settings.horizonFY]);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const confMatches = (p: AppPlan) =>
    !conf || (dispMeta(p.disposition).leavesOnPrem && (conf === 'unrated' ? !p.confidence : p.confidence === conf));
  const ql = q.trim().toLowerCase();
  const vmMatches = (v: VM) =>
    (!site || v.site === site) &&
    (!env || v.environment === env) &&
    (!loc || v.location === loc);
  const appMatches = (a: AppRow) =>
    (!domain || a.domain === domain) &&
    (!tier || a.tier === tier) &&
    (!disp || planFor(plans, a.key).disposition === disp) &&
    confMatches(planFor(plans, a.key));

  const apps = useMemo(() => {
    const out = allApps
      .filter(appMatches)
      .filter((a) => (!site && !env && !loc) || a.vms.some(vmMatches))
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
        case 'confidence': return confRank(p);
      }
    };
    return out.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : b.vcpu - a.vcpu) * d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allApps, plans, domain, tier, disp, conf, site, env, loc, ql, sortApp]);

  const vmRows = useMemo(() => {
    if (view !== 'vms') return [];
    const out = vms.filter((v) => {
      const a = parseApp(v.appKey);
      return (
        vmMatches(v) &&
        (!domain || a.domain === domain) &&
        (!tier || a.tier === tier) &&
        (!disp || planFor(plans, v.appKey).disposition === disp) &&
        confMatches(planFor(plans, v.appKey)) &&
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
  }, [view, vms, plans, domain, tier, disp, conf, site, env, loc, ql, sortVm]);

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
    const rows = (view === 'apps' ? apps.flatMap((a) => a.vms.filter((v) => (!site && !env && !loc) || vmMatches(v))) : vmRows).map((v) => {
      const a = parseApp(v.appKey);
      const p = planFor(plans, v.appKey);
      return {
        VMName: v.name, Application_Primary: v.appKey, Application: a.name, Domain: a.domain, Tier: a.tier,
        Environment: v.environment, VCenter: v.vcenter, VMLocation: v.location, PowerState: v.poweredOn ? 'PoweredOn' : 'PoweredOff',
        vCPU: v.vcpu, MemoryGB: v.memGB, Disposition: dispMeta(p.disposition).label,
        Confidence: dispMeta(p.disposition).leavesOnPrem ? (p.confidence ? CONFIDENCE_LABEL[p.confidence] : 'Not rated') : '',
        TargetFY: p.targetFY ? fyLabel(p.targetFY) : '', TargetQuarter: p.targetFY ? `Q${p.targetQ ?? 4}` : '', ReviewBy: p.reviewFY ? quarterLabel(p.reviewFY, p.reviewQ ?? 4) : '', Notes: p.notes ?? '',
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
            Capture a treatment and the FY quarter it leaves on-prem for each application (from <code>Application_Primary</code>). {decided} of{' '}
            {allApps.length} applications decided. Changes are saved to the shared database and appear for everyone within seconds.
          </p>
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={view === 'apps'} onClick={() => setView('apps')}>By application</button>
            <button aria-pressed={view === 'vms'} onClick={() => setView('vms')}>By VM</button>
          </div>
          <a className="btn btn-primary" href="api/export/treatment-plan.xlsx">Export to Excel (with charts)</a>
          <button className="btn" onClick={exportView}>Export view (CSV)</button>
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
            <select className="select" value={conf} onChange={(e) => setConf(e.target.value)} aria-label="Filter by confidence">
              <option value="">All confidence</option>
              {CONFIDENCE.map((c) => <option key={c.id} value={c.id}>{c.label} confidence</option>)}
              <option value="unrated">Not rated (moves only)</option>
            </select>
            <select className="select" value={site} onChange={(e) => setSite(e.target.value)} aria-label="vCenter">
              <option value="">All vCenters</option>
              {sites.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select className="select" value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Cluster">
              <option value="">All clusters</option>
              {locs.map((d) => <option key={d} value={d}>{d in sov ? `🔒 ${d}` : d}</option>)}
            </select>
            <select className="select" value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
              <option value="">All environments</option>
              {envs.map((d) => <option key={d}>{d}</option>)}
            </select>
            {(q || domain || tier || disp || conf || site || env || loc) && (
              <button className="btn btn-sm" onClick={() => { setQ(''); setDomain(''); setTier(''); setDisp(''); setConf(''); setSite(''); setEnv(''); setLoc(''); }}>Clear</button>
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
                  <AppTh k="target">Off on-prem by · or review by (FY · quarter)</AppTh>
                  <AppTh k="confidence">Confidence</AppTh>
                  <th style={{ minWidth: 150 }}>Notes</th>
                  <th>Last change</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => {
                  const p = planFor(plans, a.key);
                  const meta = dispMeta(p.disposition);
                  const open = expanded.has(a.key);
                  const subVms = (!site && !env && !loc) ? a.vms : a.vms.filter(vmMatches);
                  const pinnedVms = a.vms.filter((v) => v.pinned);
                  const heldVcpu = a.vms.filter((v) => heldBySovereignty(v, p)).reduce((x, v) => x + v.vcpu, 0);
                  const fullyPinned = pinnedVms.length > 0 && pinnedVms.length === a.vms.length;
                  return (
                    <Fragment key={a.key}>
                      <tr className={selected.has(a.key) ? 'sel' : undefined}>
                        <td><input type="checkbox" aria-label={`Select ${a.name}`} checked={selected.has(a.key)} onChange={() => setSelected((s) => toggle(s, a.key))} /></td>
                        <td><button className="expander" aria-expanded={open} aria-label="Show VMs" onClick={() => setExpanded((s) => toggle(s, a.key))}>{open ? '▼' : '▶'}</button></td>
                        <td style={{ minWidth: 200 }}>
                          <div className="app-name">{a.name}</div>
                          <div className="app-svc">{a.service}{a.owner ? ` · ${a.owner}` : ''}</div>
                          {pinnedVms.length > 0 && (
                            <div className="pin-badge" title={[...new Set(pinnedVms.map((v) => `${v.location}${sov[v.location] ? ` – ${sov[v.location]}` : ''}`))].join('\n')}>
                              🔒 {fullyPinned ? 'All' : `${pinnedVms.length} of ${a.vmCount}`} VMs pinned – data sovereignty ({[...new Set(pinnedVms.map((v) => v.location))].join(', ')})
                              {fullyPinned && p.disposition !== 'retain_sovereignty' && (
                                <button className="btn btn-sm" style={{ marginLeft: 6, padding: '0 6px', fontSize: 11 }} onClick={() => setPlan(a.key, { disposition: 'retain_sovereignty' })}>Set to Stay – Sovereignty</button>
                              )}
                            </div>
                          )}
                          {a.vms.some((v) => v.origAppKey) && <div className="muted" style={{ fontSize: 11 }} title={[...new Set(a.vms.filter((v) => v.origAppKey).map((v) => v.origAppKey))].join('\n')}>↪ includes {a.vms.filter((v) => v.origAppKey).length} VMs merged by mapping rules</div>}
                        </td>
                        <td>{a.domain}</td>
                        <td className="muted">{a.tier}</td>
                        <td className="r num">{a.vmCount}</td>
                        <td className="r num"><b>{fmt(a.vcpu)}</b>{heldVcpu > 0 && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }} title="vCPU that can actually leave on-prem">{fmt(a.vcpu - heldVcpu)} can move</div>}</td>
                        <td className="muted" style={{ fontSize: 12, maxWidth: 110 }} title={a.environments.join(', ')}>{a.environments.slice(0, 2).join(', ')}{a.environments.length > 2 ? ` +${a.environments.length - 2}` : ''}</td>
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
                          <TargetPicker plan={p} options={targetOptions} onChange={(patch) => setPlan(a.key, patch)} />
                        </td>
                        <td>
                          <ConfidencePicker plan={p} weights={settings.confidenceWeights} onChange={(c) => setPlan(a.key, { confidence: c })} />
                        </td>
                        <td><NotesInput value={p.notes ?? ''} onCommit={(notes) => setPlan(a.key, { notes })} /></td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {p.updatedBy ? (
                            <button className="expander" style={{ width: 'auto', textAlign: 'left', fontSize: 12 }} title={`${fmtDateTime(p.updatedAt!)} – click for history`} onClick={() => setHistoryFor(a.key)}>
                              {p.updatedBy}<br /><span className="muted">{timeAgo(p.updatedAt)}</span>
                            </button>
                          ) : <span className="muted">—</span>}
                        </td>
                      </tr>
                      {open && subVms.map((v) => (
                        <tr className={`sub${v.pinned && p.disposition !== 'retire' ? ' pinned' : ''}`} key={v.name}>
                          <td /><td />
                          <td colSpan={2}>{v.name} <span className="muted">· {v.os || 'OS n/a'}</span>{v.origAppKey && <div className="muted" style={{ fontSize: 11 }}>↪ mapped from “{v.origAppKey}”</div>}
                            {v.pinned && <PinFlag reason={sov[v.location]} cluster={v.location} retire={p.disposition === 'retire'} />}</td>
                          <td className="muted">{v.site}</td>
                          <td className="muted" colSpan={1}>{v.poweredOn ? 'On' : 'Off'}</td>
                          <td className="r num">{v.vcpu}</td>
                          <td><span className="chip">{v.environment}</span></td>
                          <td className="muted" colSpan={5}>{v.location} · {fmt(v.memGB)} GB RAM · {fmt(v.storageProvGB)} GB disk</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {apps.length === 0 && <tr><td colSpan={13} className="empty">No applications match these filters.</td></tr>}
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
                  const meta = dispMeta(p.disposition);
                  return (
                    <tr key={v.name + v.vcenter} className={v.pinned && p.disposition !== 'retire' ? 'pinned' : undefined}>
                      <td>{v.name}{!v.poweredOn && <span className="chip" style={{ marginLeft: 6 }}>Off</span>}{v.origAppKey && <div className="muted" style={{ fontSize: 11 }} title={`VMInfo: ${v.origAppKey}`}>↪ mapped by rule</div>}
                        {v.pinned && <PinFlag reason={sov[v.location]} cluster={v.location} retire={p.disposition === 'retire'} />}</td>
                      <td><div className="app-name">{a.name}</div></td>
                      <td>{a.domain}</td>
                      <td className="muted">{a.tier}</td>
                      <td><span className="chip">{v.environment}</span></td>
                      <td className="muted">{v.site} · {v.location}</td>
                      <td className="r num">{v.vcpu}</td>
                      <td className="r num">{fmt(v.memGB)}</td>
                      <td><span className="chip"><i className="dot" style={{ background: meta.color }} />{meta.short}</span></td>
                      <td className="muted">{p.targetFY && meta.leavesOnPrem ? quarterLabel(p.targetFY, p.targetQ ?? 4) : '—'}</td>
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
        <BulkBar count={selected.size} options={targetOptions}
          onApply={(patch) => { setPlans([...selected], patch); }}
          onClear={() => setSelected(new Set())} />
      )}
      {historyFor && <HistoryModal appKey={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function HistoryModal({ appKey, onClose }: { appKey: string; onClose: () => void }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    api<HistoryEntry[]>(`/history?app=${encodeURIComponent(appKey)}`).then(setItems).catch(() => setItems([]));
  }, [appKey]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card card-pad drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Change history">
        <div className="card-head">
          <div><h2>Change history</h2><p className="sub">{appKey}</p></div>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        {items === null ? <div className="note">Loading…</div> : items.length === 0 ? <div className="note">No changes recorded.</div> : items.map((h) => <HistoryRow key={h.id} h={h} />)}
      </div>
    </div>
  );
}

const tKey = (fy?: number, q?: number) => (fy ? `${fy}-${q ?? 4}` : '');

function TargetSelect({ value, options, onChange, placeholder, small = true, ariaLabel = 'Target FY and quarter' }: { value: string; options: { fy: number; q: number }[]; onChange: (v: string) => void; placeholder: string; small?: boolean; ariaLabel?: string }) {
  const hasValue = !value || options.some((o) => tKey(o.fy, o.q) === value);
  const fys = [...new Set(options.map((o) => o.fy))];
  return (
    <select className={`select${small ? ' select-sm' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      <option value="">{placeholder}</option>
      {!hasValue && <option value={value}>{quarterLabel(Number(value.split('-')[0]), Number(value.split('-')[1]))} (past)</option>}
      {fys.map((fy) => (
        <optgroup key={fy} label={fyLabel(fy)}>
          {options.filter((o) => o.fy === fy).map((o) => (
            <option key={o.q} value={tKey(o.fy, o.q)}>{quarterLabel(o.fy, o.q)} · {quarterRange(o.fy, o.q)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function TargetPicker({ plan, options, onChange }: { plan: AppPlan; options: { fy: number; q: number }[]; onChange: (p: Partial<AppPlan>) => void }) {
  const meta = dispMeta(plan.disposition);
  if (meta.group === 'Retain') {
    return (
      <div title="Optional – when this stay-on-prem decision should be re-assessed. Does not change the forecast.">
        <TargetSelect value={tKey(plan.reviewFY, plan.reviewQ)} options={options} placeholder="Stays · review by… (optional)" ariaLabel="Review by"
          onChange={(val) => {
            if (!val) onChange({ reviewFY: null, reviewQ: null } as unknown as Partial<AppPlan>);
            else {
              const [fy, q] = val.split('-').map(Number);
              onChange({ reviewFY: fy, reviewQ: q as Quarter });
            }
          }} />
        {plan.reviewFY ? <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Stays on-prem · review due</div> : null}
      </div>
    );
  }
  if (!meta.leavesOnPrem) return <span className="muted">—</span>;
  const v = tKey(plan.targetFY, plan.targetQ);
  return (
    <div style={!plan.targetFY ? { outline: '1px solid var(--warn-ink)', borderRadius: 6, display: 'inline-block' } : undefined}>
      <TargetSelect value={v} options={options} placeholder="Choose quarter…"
        onChange={(val) => {
          if (!val) onChange({ targetFY: undefined, targetQ: undefined });
          else {
            const [fy, q] = val.split('-').map(Number);
            onChange({ targetFY: fy, targetQ: q as Quarter });
          }
        }} />
    </div>
  );
}

function ConfidencePicker({ plan, weights, onChange }: { plan: AppPlan; weights: ConfidenceWeights; onChange: (c: Confidence | undefined) => void }) {
  if (!dispMeta(plan.disposition).leavesOnPrem) return <span className="muted">—</span>;
  const c = plan.confidence;
  const meta = CONFIDENCE.find((x) => x.id === c);
  return (
    <div className="disp-cell" title={c ? `${weights[c]}% of this workload counted as moved in the risk-adjusted forecast` : `Not rated – counted at ${weights.unrated}% in the risk-adjusted forecast`}>
      <i className="dot" style={{ background: meta ? meta.color : 'transparent', border: meta ? 0 : '1px dashed var(--border-strong)' }} />
      <select className="select select-sm" value={c ?? ''} aria-label="Confidence" onChange={(e) => onChange((e.target.value || null) as Confidence | undefined)}>
        <option value="">Not rated</option>
        {CONFIDENCE.map((x) => <option key={x.id} value={x.id}>{x.label} · {weights[x.id]}%</option>)}
      </select>
    </div>
  );
}

function PinFlag({ reason, cluster, retire }: { reason?: string; cluster: string; retire: boolean }) {
  return (
    <div className="pin-flag">
      🔒 {retire ? 'On a data-sovereignty cluster – Retire still applies' : 'Pinned on-prem – data sovereignty'}
      {reason ? ` (${reason})` : ''} · cluster {cluster} · <a href="#/settings">set in Settings</a>
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

function BulkBar({ count, options, onApply, onClear }: { count: number; options: { fy: number; q: number }[]; onApply: (p: Partial<AppPlan>) => void; onClear: () => void }) {
  const [d, setD] = useState<Disposition | ''>('');
  const [t, setT] = useState('');
  const [c, setC] = useState('');
  const [rv, setRv] = useState('');
  return (
    <div className="bulkbar">
      <b>{count} selected</b>
      <select className="select select-sm" value={d} onChange={(e) => setD(e.target.value as Disposition)} aria-label="Bulk disposition">
        <option value="">Treatment (unchanged)</option>
        {DISPOSITIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <TargetSelect value={t} options={options} onChange={setT} placeholder="Target quarter (unchanged)" />
      <select className="select select-sm" value={c} onChange={(e) => setC(e.target.value)} aria-label="Bulk confidence">
        <option value="">Confidence (unchanged)</option>
        {CONFIDENCE.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        <option value="clear">Clear (not rated)</option>
      </select>
      <TargetSelect value={rv} options={options} onChange={setRv} placeholder="Review by (stay-on-prem apps)" ariaLabel="Bulk review by" />
      <button className="btn btn-sm" disabled={!d && !t && !c && !rv}
        onClick={() => {
          const patch: Partial<AppPlan> = {};
          if (d) patch.disposition = d;
          if (t) {
            const [fy, q] = t.split('-').map(Number);
            patch.targetFY = fy;
            patch.targetQ = q as Quarter;
          }
          if (c) patch.confidence = (c === 'clear' ? null : c) as Confidence;
          if (rv) {
            const [fy, q] = rv.split('-').map(Number);
            patch.reviewFY = fy;
            patch.reviewQ = q as Quarter;
          }
          onApply(patch);
        }}>Apply to {count}</button>
      <button className="btn btn-sm" onClick={onClear} style={{ marginLeft: 'auto' }}>Clear selection</button>
    </div>
  );
}
