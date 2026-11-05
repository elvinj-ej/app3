import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { groupApps } from '../lib/projection';
import { fmt } from '../lib/useColors';
import { fmtDateTime, PlanChip } from '../components/common';
import type { AppPlan, AppRule, RuleEffect, UploadMeta } from '../lib/types';
import { NO_APP } from '../lib/parse';

export default function InventoryPage() {
  const { inventory, hasInventory, plans, rev, uploadInventory, renamePlan, refresh, toast } = useStore();
  const [uploads, setUploads] = useState<UploadMeta[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [result, setResult] = useState<UploadMeta | null>(null);
  const [dup, setDup] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<UploadMeta[]>('/uploads').then(setUploads).catch(() => setUploads([]));
  }, [rev]);

  const apps = useMemo(() => groupApps(inventory.vms), [inventory]);
  const appKeys = useMemo(() => new Set(apps.map((a) => a.key)), [apps]);
  const orphans = hasInventory ? Object.entries(plans).filter(([k]) => !appKeys.has(k)) : [];
  const undecided = apps.filter((a) => !plans[a.key]).map((a) => a.key).sort();

  const submit = async (force = false) => {
    if (!file) return;
    setBusy(true);
    setDup(null);
    try {
      const u = await uploadInventory(file, note, force);
      setResult(u);
      setOpen(u.id);
      setFile(null);
      setNote('');
      toast(`Upload #${u.id} is now the current inventory`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setDup(e.message);
      else toast(`Upload failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Inventory updates</h1>
          <p>Upload each new VMInfo export here. Every upload is kept (who, when, the original file and what changed). The newest upload drives the dashboards; treatment decisions stay linked by <code>Application_Primary</code>.</p>
        </div>
      </div>

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad">
          <div className="card-head"><div><h2>Upload latest VMInfo</h2><p className="sub">.xlsx with a <code>VMs</code> sheet (a <code>Clusters</code> sheet is optional)</p></div></div>
          <div className={`dropzone${over ? ' over' : ''}`} role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); setFile(e.dataTransfer.files[0] ?? null); setDup(null); }}>
            {file ? <><b>{file.name}</b> · {(file.size / 1024).toFixed(0)} KB</> : <><b>Drop the .xlsx here</b> or click to choose</>}
          </div>
          <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDup(null); e.target.value = ''; }} />
          <input className="input" style={{ width: '100%', marginTop: 10 }} placeholder="Note (optional) – e.g. 'Monthly export, Nov 2026'" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          {dup && (
            <div className="banner" style={{ marginTop: 10, marginBottom: 0 }}>
              {dup}
              <button className="btn btn-sm" onClick={() => submit(true)}>Upload anyway</button>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-primary" disabled={!file || busy} onClick={() => submit(false)}>{busy ? 'Uploading…' : 'Upload & make current'}</button>
          </div>
          {result && (
            <p className="note" style={{ marginTop: 10 }}>
              Upload #{result.id}: {fmt(result.vmCount)} VMs, {fmt(result.vcpu)} vCPU, {result.appCount} applications.
              {result.diff.previousUploadId && <> Compared with #{result.diff.previousUploadId}: {signed(result.diff.vmDelta)} VMs, {signed(result.diff.vcpuDelta)} vCPU, {result.diff.appsAdded.length} new and {result.diff.appsRemoved.length} removed applications.</>}
            </p>
          )}
        </div>

        <div className="card card-pad">
          <div className="card-head">
            <div><h2>Decisions without a matching application</h2>
              <p className="sub">An application's name changed or it left the inventory. Re-link the decision to its new name, or leave it (it is kept, but no longer counted).</p></div>
          </div>
          {!hasInventory ? <div className="note">Upload an inventory first.</div> : orphans.length === 0 ? (
            <div className="note">All {Object.keys(plans).length} decisions match an application in the current inventory. ✓</div>
          ) : (
            <div className="stack" style={{ gap: 0 }}>
              {orphans.map(([k, p]) => <OrphanRow key={k} appKey={k} plan={<PlanChip p={p} />} options={undecided}
                onRelink={async (to) => { try { await renamePlan(k, to); toast('Decision re-linked'); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); } }}
                onRemove={async () => {
                  if (!confirm(`Remove the decision for “${k}”? It stays in the change history.`)) return;
                  try { await api(`/plans?key=${encodeURIComponent(k)}`, { method: 'DELETE' }); await refresh(); toast('Decision removed'); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
                }} />)}
            </div>
          )}
        </div>
      </div>

      {hasInventory && <MappingRules />}

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}><h2>Upload history</h2></div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>#</th><th>File</th><th>Uploaded by</th><th>When</th><th className="r">VMs</th><th className="r">vCPU</th><th className="r">Apps</th><th>Change vs previous</th><th>Note</th><th /></tr>
            </thead>
            <tbody>
              {(uploads ?? []).map((u, i) => (
                <Fragment key={u.id}>
                  <tr>
                    <td className="num">{u.id}{i === 0 && <span className="chip" style={{ marginLeft: 6 }}>current</span>}</td>
                    <td>{u.filename}</td>
                    <td>{u.uploadedBy}</td>
                    <td className="muted">{fmtDateTime(u.uploadedAt)}</td>
                    <td className="r num">{fmt(u.vmCount)}</td>
                    <td className="r num">{fmt(u.vcpu)}</td>
                    <td className="r num">{u.appCount}</td>
                    <td>
                      {u.diff.previousUploadId == null ? <span className="muted">first upload</span> : (
                        <button className="btn btn-sm" onClick={() => setOpen(open === u.id ? null : u.id)} aria-expanded={open === u.id}>
                          {signed(u.diff.vmDelta)} VMs · {signed(u.diff.vcpuDelta)} vCPU · {u.diff.appsAdded.length}+ / {u.diff.appsRemoved.length}− apps {open === u.id ? '▲' : '▼'}
                        </button>
                      )}
                    </td>
                    <td className="muted">{u.note}</td>
                    <td><a className="btn btn-sm" href={`api/uploads/${u.id}/file`}>Download</a></td>
                  </tr>
                  {open === u.id && u.diff.previousUploadId != null && (
                    <tr className="sub">
                      <td />
                      <td colSpan={9}>
                        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, padding: '6px 0' }}>
                          <DiffList title="New applications" cls="pill-add" items={u.diff.appsAdded.map((a) => `${a.key} (${a.vms} VMs, ${a.vcpu} vCPU)`)} />
                          <DiffList title="Removed applications" cls="pill-rem" items={u.diff.appsRemoved.map((a) => `${a.key} (${a.vms} VMs, ${a.vcpu} vCPU)${a.hadDecision ? ' – had a decision' : ''}`)} />
                          <DiffList title="New VMs" cls="pill-add" items={u.diff.vmsAdded} />
                          <DiffList title="Removed VMs" cls="pill-rem" items={u.diff.vmsRemoved} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {uploads && uploads.length === 0 && <tr><td colSpan={10} className="empty">No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function signed(n: number) {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;
}

function DiffList({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  return (
    <div>
      <div><span className={cls}>{items.length}</span> {title}</div>
      {items.length > 0 && <ul className="diff-list">{items.slice(0, 300).map((x) => <li key={x}>{x}</li>)}{items.length > 300 && <li>… {items.length - 300} more</li>}</ul>}
    </div>
  );
}

function OrphanRow({ appKey, plan, options, onRelink, onRemove }: { appKey: string; plan: React.ReactNode; options: string[]; onRelink: (to: string) => void; onRemove: () => void }) {
  const [to, setTo] = useState('');
  const id = `opts-${appKey.replace(/\W+/g, '')}`;
  return (
    <div className="hist-row">
      <div className="app-name">{appKey}</div>
      <div style={{ margin: '4px 0 8px' }}>{plan}</div>
      <div className="filters">
        <input className="input select-sm" style={{ flex: 1, minWidth: 200 }} list={id} placeholder="New Application_Primary name…" value={to} onChange={(e) => setTo(e.target.value)} />
        <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
        <button className="btn btn-sm" disabled={!options.includes(to)} onClick={() => onRelink(to)}>Re-link</button>
        <button className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

type RuleRow = AppRule & { effect: RuleEffect; sourceFound: boolean };

function MappingRules() {
  const { inventory, plans, rev, refresh, toast } = useStore();
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [kind, setKind] = useState<'merge' | 'vm'>('merge');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [comps, setComps] = useState(true);
  const [choice, setChoice] = useState<{ source: AppPlan; target: AppPlan } | null>(null);

  const load = () => api<RuleRow[]>('/rules').then(setRules).catch(() => setRules([]));
  useEffect(() => {
    load();
  }, [rev]);

  const rawKeys = useMemo(() => [...new Set(inventory.vms.map((v) => v.origAppKey ?? v.appKey))].filter((k) => k !== NO_APP).sort(), [inventory]);
  const targets = useMemo(() => [...new Set(inventory.vms.map((v) => v.appKey))].filter((k) => k !== NO_APP).sort(), [inventory]);
  const vmNames = useMemo(() => inventory.vms.map((v) => v.name).sort(), [inventory]);
  const srcOk = kind === 'merge' ? rawKeys.includes(source) : vmNames.some((n) => n.toLowerCase() === source.toLowerCase());
  const tgtOk = targets.includes(target) && target !== source;

  const create = async (keep?: 'target' | 'source' | 'both') => {
    try {
      await api('/rules', { json: { kind, source, target, note, keep, components: kind === 'merge' && comps } });
      setChoice(null);
      setSource('');
      setTarget('');
      setNote('');
      await refresh();
      await load();
      toast(kind === 'merge' ? 'Applications merged' : 'VM reassigned');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body.needsChoice) setChoice({ source: e.body.source as AppPlan, target: e.body.target as AppPlan });
      else toast(String(e instanceof Error ? e.message : e), 'error');
    }
  };
  const remove = async (r: RuleRow) => {
    if (!confirm(`Remove this rule? The VMs go back to “${r.kind === 'merge' ? r.source : 'their VMInfo application'}”. Decisions are not changed.`)) return;
    try {
      await api(`/rules/${r.id}`, { method: 'DELETE' });
      await refresh();
      await load();
      toast('Rule removed');
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Application mapping rules</h2>
          <p className="sub">Corrections applied to every VMInfo upload: merge duplicate applications, or assign a VM to an application. The original value from the file is kept and shown in the VM view and the Excel export.</p>
        </div>
      </div>
      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table className="t">
          <thead><tr><th>Rule</th><th>From (VMInfo value)</th><th>Counted as</th><th className="r">VMs</th><th className="r">vCPU</th><th>Status</th><th>Created</th><th /></tr></thead>
          <tbody>
            {(rules ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.kind === 'merge' ? 'Merge application' : 'Assign VM'}{r.note && <div className="muted" style={{ fontSize: 12 }}>{r.note}</div>}
                  {r.kind === 'merge' && (
                    <label className="check" style={{ fontSize: 12, marginTop: 4 }} title="Show this merged label as an expandable component of the target application">
                      <input type="checkbox" checked={!!r.components} onChange={async (e) => { try { await api(`/rules/${r.id}`, { method: 'PATCH', json: { components: e.target.checked } }); await refresh(); await load(); } catch (err) { toast(String(err instanceof Error ? err.message : err), 'error'); } }} />
                      as component
                    </label>
                  )}</td>
                <td style={{ maxWidth: 320 }}>{r.source}</td>
                <td style={{ maxWidth: 320 }}><b>{r.target}</b></td>
                <td className="r num">{r.effect.vms}</td>
                <td className="r num">{fmt(r.effect.vcpu)}</td>
                <td>
                  {!r.sourceFound ? <span className="chip badge-warn" title="The source no longer appears in the latest VMInfo upload">No longer needed</span>
                    : r.effect.conflict ? <span className="chip badge-warn" title={`The VMInfo file now assigns this VM to “${r.effect.conflict}”`}>File now says: {r.effect.conflict}</span>
                    : <span className="chip">Active</span>}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{r.createdBy}<br />{fmtDateTime(r.createdAt)}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => remove(r)}>Remove</button></td>
              </tr>
            ))}
            {rules && rules.length === 0 && <tr><td colSpan={8} className="empty">No mapping rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Rule type">
          <button aria-pressed={kind === 'merge'} onClick={() => { setKind('merge'); setSource(''); }}>Merge application</button>
          <button aria-pressed={kind === 'vm'} onClick={() => { setKind('vm'); setSource(''); }}>Assign VM</button>
        </div>
        <input className="input" style={{ flex: '1 1 260px', width: 'auto' }} list="rule-src" value={source} onChange={(e) => setSource(e.target.value)}
          placeholder={kind === 'merge' ? 'Application to merge (as in VMInfo)…' : 'VM name…'} aria-label="Rule source" />
        <datalist id="rule-src">{(kind === 'merge' ? rawKeys : vmNames).map((o) => <option key={o} value={o} />)}</datalist>
        <span className="muted">→</span>
        <input className="input" style={{ flex: '1 1 260px', width: 'auto' }} list="rule-tgt" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Count it as application…" aria-label="Rule target" />
        <datalist id="rule-tgt">{targets.map((o) => <option key={o} value={o} />)}</datalist>
        <input className="input" style={{ flex: '0 1 200px', width: 'auto' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={500} />
        {kind === 'merge' && <label className="check" title="The merged label stays visible as an expandable component (e.g. Custom Sound ▸ Analytics)"><input type="checkbox" checked={comps} onChange={(e) => setComps(e.target.checked)} /> keep as component</label>}
        <button className="btn btn-primary btn-sm" disabled={!srcOk || !tgtOk} onClick={() => create()}>Add rule</button>
      </div>
      {kind === 'merge' && source && plans[source] && srcOk && (
        <p className="note" style={{ marginTop: 6 }}>“{source}” has a decision{plans[target] ? ' and so does the target – you will be asked which to keep.' : ' – it will move to the target application.'}</p>
      )}
      {choice && (
        <div className="modal-back" onClick={() => setChoice(null)}>
          <div className="card card-pad modal" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <h2>Both applications have a decision</h2>
            <p className="sub" style={{ margin: '6px 0 12px' }}>Choose which decision the merged application keeps.</p>
            <div className="hist-row"><div className="muted" style={{ fontSize: 12 }}>Target: {target}</div><PlanChip p={choice.target} /></div>
            <div className="hist-row"><div className="muted" style={{ fontSize: 12 }}>Being merged: {source}</div><PlanChip p={choice.source} /></div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn" onClick={() => setChoice(null)}>Cancel</button>
              <button className="btn" onClick={() => create('both')} title="The merged application's decision stays listed under 'Decisions without a matching application'">Keep target, park the other</button>
              <button className="btn" onClick={() => create('source')}>Use the merged one's decision</button>
              <button className="btn btn-primary" onClick={() => create('target')}>Keep target's decision</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
