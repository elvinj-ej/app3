import { useMemo, useRef, useState } from 'react';
import { defaultVendor, useStore, vendorOf } from '../lib/store';
import { readInventoryFile } from '../lib/parse';
import { fyLabel } from '../lib/fy';
import { groupApps } from '../lib/projection';
import { download } from '../lib/exporter';
import { fmt } from '../lib/useColors';
import type { Deadline, HwVendor, PlanMap, Settings } from '../lib/types';

export default function DataSettings() {
  const { inventory, plans, settings, setInventory, replacePlans, updateSettings, resetAll } = useStore();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const planRef = useRef<HTMLInputElement>(null);

  const apps = useMemo(() => groupApps(inventory.vms), [inventory]);
  const orphanPlans = Object.keys(plans).filter((k) => !apps.some((a) => a.key === k));

  const onExcel = async (file?: File) => {
    if (!file) return;
    setMsg(null);
    try {
      const inv = await readInventoryFile(file);
      const appKeys = new Set(inv.vms.map((v) => v.appKey));
      const planned = [...appKeys].filter((k) => plans[k]).length;
      setInventory(inv);
      setMsg({
        kind: 'ok',
        text: `Loaded ${fmt(inv.vms.length)} VMs, ${appKeys.size} applications and ${inv.clusters.length} clusters from ${file.name}. ${planned} applications matched existing plan entries.`,
      });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const onPlanImport = async (file?: File) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const p: PlanMap = data.plans ?? data;
      if (typeof p !== 'object' || Array.isArray(p)) throw new Error('Unexpected file format');
      replacePlans(p);
      if (data.settings) updateSettings(data.settings as Partial<Settings>);
      setMsg({ kind: 'ok', text: `Imported ${Object.keys(p).length} application plan entries.` });
    } catch (e) {
      setMsg({ kind: 'err', text: `Could not import plan: ${e instanceof Error ? e.message : e}` });
    }
  };

  const setDeadline = (id: string, patch: Partial<Deadline>) =>
    updateSettings({ deadlines: settings.deadlines.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

  const fys: number[] = [];
  for (let fy = settings.currentFY + 1; fy <= settings.currentFY + 10; fy++) fys.push(fy);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Data &amp; settings</h1>
          <p>Inventory source, planning horizon, deadlines and hardware vendor mapping. Everything is stored locally in this browser.</p>
        </div>
      </div>

      {msg && (
        <div className="banner" style={msg.kind === 'ok' ? { background: 'var(--accent-soft)', color: 'var(--text)' } : { background: 'var(--warn-bg)', color: 'var(--crit)' }}>
          {msg.text}
        </div>
      )}

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad">
          <div className="card-head">
            <div><h2>Inventory (VMInfo Excel export)</h2><p className="sub">Needs a <code>VMs</code> sheet; the <code>Clusters</code> sheet is optional.</p></div>
          </div>
          <div className={`dropzone${over ? ' over' : ''}`} role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onExcel(e.dataTransfer.files[0]); }}>
            <b>Drop the .xlsx here</b> or click to choose a file
            <div className="note" style={{ marginTop: 6 }}>Parsed in the browser – the file is not uploaded anywhere. Re-loading a newer export keeps your plan (matched on Application_Primary).</div>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { onExcel(e.target.files?.[0]); e.target.value = ''; }} />
          <table className="t" style={{ marginTop: 14 }}>
            <tbody>
              <tr><td className="muted">Source</td><td>{inventory.sourceFile}</td></tr>
              <tr><td className="muted">Loaded</td><td>{new Date(inventory.loadedAt).toLocaleString('en-AU')}</td></tr>
              <tr><td className="muted">VMs</td><td className="num">{fmt(inventory.vms.length)} ({fmt(inventory.vms.filter((v) => v.poweredOn).length)} powered on)</td></tr>
              <tr><td className="muted">vCPU</td><td className="num">{fmt(inventory.vms.reduce((s, v) => s + v.vcpu, 0))}</td></tr>
              <tr><td className="muted">Applications</td><td className="num">{apps.length} ({Object.keys(plans).length - orphanPlans.length} with a plan entry)</td></tr>
              {orphanPlans.length > 0 && <tr><td className="muted">Orphaned plans</td><td>{orphanPlans.length} plan entries refer to applications not in this inventory (kept)</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card card-pad">
          <div className="card-head"><div><h2>Planning horizon</h2><p className="sub">FY starts 1 July · current year is derived from today's date</p></div></div>
          <div className="filters" style={{ marginBottom: 16 }}>
            <label className="check">Current FY
              <select className="select" value={settings.currentFY} onChange={(e) => updateSettings({ currentFY: Number(e.target.value) })}>
                {[settings.currentFY - 1, settings.currentFY, settings.currentFY + 1].map((f) => <option key={f} value={f}>{fyLabel(f)}</option>)}
              </select>
            </label>
            <label className="check">Project to end of
              <select className="select" value={settings.horizonFY} onChange={(e) => updateSettings({ horizonFY: Number(e.target.value) })}>
                {fys.map((f) => <option key={f} value={f}>{fyLabel(f)}</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.includePoweredOff} onChange={(e) => updateSettings({ includePoweredOff: e.target.checked })} />
              Include powered-off VMs
            </label>
          </div>
          <div className="card-head" style={{ marginTop: 8 }}><div><h2>Plan backup</h2><p className="sub">Export your decisions to share or keep a copy</p></div></div>
          <div className="filters">
            <button className="btn" onClick={() => download(`footprint-plan-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), plans, settings }, null, 2), 'application/json')}>
              Export plan (JSON)
            </button>
            <button className="btn" onClick={() => planRef.current?.click()}>Import plan…</button>
            <input ref={planRef} type="file" accept=".json" hidden onChange={(e) => { onPlanImport(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn btn-danger" onClick={() => { if (confirm('Clear the loaded inventory, all application decisions and settings?')) resetAll(); }}>
              Reset everything
            </button>
          </div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div><h2>Deadlines</h2><p className="sub">Shown on the executive summary and marked on the FY chart. Tick “confirmed” once the contract date is verified.</p></div>
          <button className="btn btn-sm" onClick={() => updateSettings({ deadlines: [...settings.deadlines, { id: crypto.randomUUID(), label: 'New deadline', date: new Date().toISOString().slice(0, 10), kind: 'Other', confirmed: false }] })}>
            + Add deadline
          </button>
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Label</th><th>Date</th><th>Type</th><th>Confirmed</th><th>Note</th><th /></tr></thead>
            <tbody>
              {settings.deadlines.map((d) => (
                <tr key={d.id}>
                  <td><input className="input select-sm" style={{ width: '100%', minWidth: 200 }} value={d.label} onChange={(e) => setDeadline(d.id, { label: e.target.value })} /></td>
                  <td><input className="input select-sm" type="date" value={d.date} onChange={(e) => e.target.value && setDeadline(d.id, { date: e.target.value })} /></td>
                  <td>
                    <select className="select select-sm" value={d.kind} onChange={(e) => setDeadline(d.id, { kind: e.target.value as Deadline['kind'] })}>
                      <option value="VMware">VMware licence</option>
                      <option value="Cisco">Cisco HW</option>
                      <option value="Lenovo">Lenovo HW</option>
                      <option value="Other">Other</option>
                    </select>
                  </td>
                  <td><input type="checkbox" checked={d.confirmed} onChange={(e) => setDeadline(d.id, { confirmed: e.target.checked })} aria-label="Confirmed" /></td>
                  <td><input className="input select-sm" style={{ width: '100%', minWidth: 200 }} value={d.note ?? ''} onChange={(e) => setDeadline(d.id, { note: e.target.value })} /></td>
                  <td><button className="btn btn-sm btn-danger" onClick={() => updateSettings({ deadlines: settings.deadlines.filter((x) => x.id !== d.id) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head">
          <div><h2>Cluster hardware vendor</h2><p className="sub">Default guess: clusters named “-HX-” are Cisco HyperFlex, the rest Lenovo. Used for the HW deadlines and hardware estate.</p></div>
        </div>
        {inventory.clusters.length === 0 ? (
          <div className="note">No Clusters sheet in the loaded workbook.</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Cluster</th><th>Class</th><th>vCenter</th><th className="r">Hosts</th><th className="r">Cores</th><th className="r">Running VMs</th><th className="r">Running vCPU</th><th>Vendor</th></tr></thead>
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
                        <option value="Lenovo">Lenovo</option>
                        <option value="Other">Other</option>
                      </select>
                    </td>
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
