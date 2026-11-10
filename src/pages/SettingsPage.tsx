import { useRef, useState } from 'react';
import { defaultVendor, useStore, vendorOf } from '../lib/store';
import { fyLabel } from '../lib/fy';
import type { ConfidenceWeights, Deadline, HwVendor, PlanMap } from '../lib/types';
import { DEADLINE_KINDS, DEFAULT_WEIGHTS, isOnExec, milestoneColor, milestoneMarker } from '../lib/defaults';
import { newId } from '../lib/api';

export default function SettingsPage() {
  const { inventory, settings, updateSettings, importPlans, toast } = useStore();
  const [draft, setDraft] = useState<Deadline[] | null>(null);
  const planRef = useRef<HTMLInputElement>(null);
  const deadlines = draft ?? settings.deadlines;
  const dirty = draft !== null;

  const editDl = (id: string, patch: Partial<Deadline>) => setDraft(deadlines.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const localPlans = (() => {
    try {
      const s = localStorage.getItem('fp.plan.v1');
      const p = s ? (JSON.parse(s) as PlanMap) : null;
      return p && Object.keys(p).length ? p : null;
    } catch {
      return null;
    }
  })();

  const doImport = async (p: PlanMap, source: string) => {
    if (!confirm(`Import ${Object.keys(p).length} decisions from ${source}? Existing decisions for the same applications will be overwritten (the change log keeps the previous values).`)) return;
    try {
      const n = await importPlans(p);
      toast(`Imported ${n} decisions`);
    } catch (e) {
      toast(`Import failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  const fys: number[] = [];
  for (let fy = settings.currentFY + 1; fy <= settings.currentFY + 10; fy++) fys.push(fy);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Shared by everyone using this server. Changes are recorded and visible to others within a few seconds.</p>
        </div>
      </div>

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad">
          <div className="card-head"><div><h2>Planning horizon</h2><p className="sub">FY starts 1 July · current year {fyLabel(settings.currentFY)} (from today's date)</p></div></div>
          <div className="filters">
            <label className="check">Project to end of
              <select className="select" value={settings.horizonFY} onChange={(e) => updateSettings({ horizonFY: Number(e.target.value) })}>
                {fys.map((f) => <option key={f} value={f}>{fyLabel(f)}</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.includePoweredOff} onChange={(e) => updateSettings({ includePoweredOff: e.target.checked })} />
              Count powered-off VMs in the footprint
            </label>
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-head"><div><h2>Backup &amp; import</h2><p className="sub">The database file is <code>data/footprint.db</code> on the server – back it up like any file.</p></div></div>
          <div className="filters">
            <a className="btn" href="api/export/treatment-plan.xlsx">Export to Excel (with charts)</a>
            <a className="btn" href="api/backup">Download decisions backup (JSON)</a>
            <button className="btn" onClick={() => planRef.current?.click()}>Import decisions (JSON)…</button>
            <input ref={planRef} type="file" accept=".json" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                await doImport((data.plans ?? data) as PlanMap, f.name);
              } catch (err) {
                toast(`Not a valid decisions file: ${err instanceof Error ? err.message : err}`, 'error');
              }
            }} />
            {localPlans && (
              <button className="btn" onClick={() => doImport(localPlans, 'the earlier browser-only version on this computer')}>
                Import {Object.keys(localPlans).length} decisions saved in this browser
              </button>
            )}
          </div>
        </div>
      </div>

      <WeightsCard />

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div><h2>Deadlines</h2><p className="sub">Milestones ticked “Show on Exec Summary” appear in Key deadlines and on the chart as a numbered dot in their colour (or a dotted line for enterprise-wide milestones). Tick “confirmed” once the date is verified.</p></div>
          <div className="filters">
            <button className="btn btn-sm" onClick={() => setDraft([...deadlines, { id: newId(), label: 'New deadline', date: new Date().toISOString().slice(0, 10), kind: 'Other', confirmed: false }])}>+ Add deadline</button>
            {dirty && <button className="btn btn-sm" onClick={() => setDraft(null)}>Discard</button>}
            <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={async () => { await updateSettings({ deadlines }); setDraft(null); toast('Deadlines saved'); }}>Save deadlines</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Label</th><th>Date</th><th>Type</th><th>Confirmed</th><th title="Show this milestone to leadership on the Executive Summary (and in the Excel export)">On Exec<br />Summary</th><th>Colour</th><th title="Dot = numbered dot just above the time axis; Dotted line = enterprise-wide milestone">Shown as</th><th>Note</th><th /></tr></thead>
            <tbody>
              {deadlines.map((d) => (
                <tr key={d.id}>
                  <td><input className="input select-sm" style={{ width: '100%', minWidth: 200 }} value={d.label} onChange={(e) => editDl(d.id, { label: e.target.value })} /></td>
                  <td><input className="input select-sm" type="date" value={d.date} onChange={(e) => e.target.value && editDl(d.id, { date: e.target.value })} /></td>
                  <td>
                    <select className="select select-sm" value={d.kind} onChange={(e) => editDl(d.id, { kind: e.target.value as Deadline['kind'] })} aria-label="Deadline type">
                      {DEADLINE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={d.confirmed} onChange={(e) => editDl(d.id, { confirmed: e.target.checked })} aria-label="Confirmed" /></td>
                  <td><input type="checkbox" checked={isOnExec(d)} onChange={(e) => editDl(d.id, { showOnExec: e.target.checked })} aria-label={`Show ${d.label} on the Executive Summary`} /></td>
                  <td><input type="color" className="color-pick" value={milestoneColor(d, deadlines)} onChange={(e) => editDl(d.id, { color: e.target.value })} aria-label={`Colour for ${d.label}`} /></td>
                  <td>
                    <select className="select select-sm" value={milestoneMarker(d)} onChange={(e) => editDl(d.id, { marker: e.target.value as 'dot' | 'line' })} aria-label={`Chart marker for ${d.label}`}>
                      <option value="dot">Dot</option>
                      <option value="line">Dotted line</option>
                    </select>
                  </td>
                  <td><input className="input select-sm" style={{ width: '100%', minWidth: 140 }} value={d.note ?? ''} onChange={(e) => editDl(d.id, { note: e.target.value })} /></td>
                  <td><button className="btn btn-sm btn-danger" onClick={() => setDraft(deadlines.filter((x) => x.id !== d.id))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head">
          <div><h2>Clusters: hardware vendor &amp; data sovereignty</h2><p className="sub"><b>Data sovereignty:</b> switch a cluster on to pin all its VMs on-prem – they are greyed out in the Application Planner and never counted as moving to SaaS or the cloud (Retire still applies). Planning stays per application. Changes are logged in Activity. <b>Vendor defaults:</b> Equinix-Linux, Equinix-Windows, MacPark-CCTV, MacPark-Linux and MacPark-Windows are Cisco FlashStack; clusters named “-HX-” are Cisco HyperFlex; the rest Lenovo. Change any cluster here – used for the HW deadlines and hardware estate.</p></div>
        </div>
        {inventory.clusters.length === 0 ? (
          <div className="note">No Clusters sheet in the current inventory.</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Cluster</th><th>Class</th><th>vCenter</th><th className="r">Hosts</th><th className="r">Cores</th><th className="r">Running VMs</th><th className="r">Running vCPU</th><th>Vendor</th><th>Data sovereignty</th></tr></thead>
              <tbody>
                {inventory.clusters.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td><td className="muted">{c.classification}</td><td className="muted">{c.vcenter}</td>
                    <td className="r num">{c.hosts}</td><td className="r num">{c.cores}</td>
                    <td className="r num">{c.runningVMs}</td><td className="r num">{c.runningVcpu}</td>
                    <td>
                      <select className="select select-sm" value={vendorOf(settings, c.name)}
                        onChange={(e) => {
                          const v = e.target.value as HwVendor;
                          const next = { ...settings.clusterVendor };
                          if (v === defaultVendor(c.name)) delete next[c.name];
                          else next[c.name] = v;
                          updateSettings({ clusterVendor: next });
                        }}>
                        <option value="Cisco">Cisco HyperFlex</option>
                        <option value="FlashStack">Cisco FlashStack</option>
                        <option value="Lenovo">Lenovo</option>
                        <option value="Other">Other</option>
                      </select>
                    </td>
                    <td><SovereigntyCell cluster={c.name} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function WeightsCard() {
  const { settings, updateSettings, toast } = useStore();
  const [draft, setDraft] = useState<ConfidenceWeights | null>(null);
  const w = draft ?? settings.confidenceWeights;
  const rows: { k: keyof ConfidenceWeights; label: string; help: string }[] = [
    { k: 'high', label: 'High', help: 'Committed – funded, owner agreed, path clear' },
    { k: 'medium', label: 'Medium', help: 'Likely – plan agreed, some dependencies open' },
    { k: 'low', label: 'Low', help: 'Possible – significant blockers or no funding yet' },
    { k: 'unknown', label: 'Unknown', help: 'Assessed, but too early to say' },
    { k: 'unrated', label: 'Not rated', help: 'No confidence chosen yet (blank)' },
  ];
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div><h2>Confidence weights</h2><p className="sub">Share of each scheduled workload counted as moved in the risk-adjusted forecast. “Committed” counts High only; “full plan” counts every scheduled move.</p></div>
        <div className="filters">
          {draft && <button className="btn btn-sm" onClick={() => setDraft(null)}>Discard</button>}
          <button className="btn btn-sm" onClick={() => setDraft({ ...DEFAULT_WEIGHTS })}>Reset to 100 / 75 / 50 / 25</button>
          <button className="btn btn-sm btn-primary" disabled={!draft} onClick={async () => { await updateSettings({ confidenceWeights: w }); setDraft(null); toast('Confidence weights saved'); }}>Save weights</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Confidence</th><th>Counted as moved</th><th>Meaning (suggested)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td><b>{r.label}</b></td>
                <td>
                  <input className="input select-sm" type="number" min={0} max={100} step={5} style={{ width: 80 }} value={w[r.k]}
                    onChange={(e) => setDraft({ ...w, [r.k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} /> %
                </td>
                <td className="muted">{r.help}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SovereigntyCell({ cluster }: { cluster: string }) {
  const { settings, updateSettings } = useStore();
  const sov = settings.sovereignClusters ?? {};
  const on = cluster in sov;
  const [reason, setReason] = useState(sov[cluster] ?? '');
  const [prev, setPrev] = useState(sov[cluster] ?? '');
  if ((sov[cluster] ?? '') !== prev) {
    setPrev(sov[cluster] ?? '');
    setReason(sov[cluster] ?? '');
  }
  const save = (next: Record<string, string>) => updateSettings({ sovereignClusters: next });
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 260 }}>
      <label className="check" title="Pin every VM on this cluster on-prem for data sovereignty">
        <input type="checkbox" checked={on} aria-label={`Data sovereignty for ${cluster}`}
          onChange={(e) => {
            const next = { ...sov };
            if (e.target.checked) next[cluster] = reason;
            else delete next[cluster];
            save(next);
          }} />
        {on ? '🔒 Pinned' : 'Off'}
      </label>
      {on && (
        <input className="input select-sm" style={{ flex: 1 }} placeholder="Reason, e.g. China data residency" value={reason} maxLength={300}
          aria-label={`Sovereignty reason for ${cluster}`}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => reason !== (sov[cluster] ?? '') && save({ ...sov, [cluster]: reason })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </div>
  );
}
