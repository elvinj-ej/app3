import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { groupApps } from '../lib/projection';
import { fmt } from '../lib/useColors';
import { fmtDateTime, PlanChip } from '../components/common';
import type { UploadMeta } from '../lib/types';

export default function InventoryPage() {
  const { inventory, hasInventory, plans, rev, uploadInventory, renamePlan, toast } = useStore();
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
                onRelink={async (to) => { try { await renamePlan(k, to); toast('Decision re-linked'); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); } }} />)}
            </div>
          )}
        </div>
      </div>

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

function OrphanRow({ appKey, plan, options, onRelink }: { appKey: string; plan: React.ReactNode; options: string[]; onRelink: (to: string) => void }) {
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
      </div>
    </div>
  );
}
