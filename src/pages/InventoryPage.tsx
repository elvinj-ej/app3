import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { groupApps } from '../lib/projection';
import { fmt } from '../lib/useColors';
import { fmtDateTime, PlanChip } from '../components/common';
import type { AppPlan, AppRule, RuleEffect, UploadMeta } from '../lib/types';
import type { ChangeReport as Report } from '../lib/changes';
import ChangeReport from '../components/ChangeReport';
import { NO_APP } from '../lib/parse';

export default function InventoryPage() {
  const { inventory, hasInventory, plans, rev, uploadInventory, renamePlan, refresh, toast, staged } = useStore();
  const [uploads, setUploads] = useState<UploadMeta[] | null>(null);
  const [rules, setRules] = useState<AppRule[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<UploadMeta[]>('/uploads').then(setUploads).catch(() => setUploads([]));
    api<AppRule[]>('/rules').then(setRules).catch(() => setRules([]));
  }, [rev]);

  const apps = useMemo(() => groupApps(inventory.vms), [inventory]);
  const appKeys = useMemo(() => new Set(apps.map((a) => a.key)), [apps]);
  const orphans = hasInventory ? Object.entries(plans).filter(([k]) => !appKeys.has(k)) : [];
  const mergeTarget = (k: string) => rules.find((r) => r.kind === 'merge' && r.source === k)?.target;
  const parkedByMerge = orphans.filter(([k]) => mergeTarget(k));
  const gone = orphans.filter(([k]) => !mergeTarget(k));
  const undecided = apps.filter((a) => !plans[a.key]).map((a) => a.key).sort();
  const pending = staged[0];

  const submit = async (force = false) => {
    if (!file) return;
    setBusy(true);
    setDup(null);
    try {
      const u = await uploadInventory(file, note, force);
      setFile(null);
      setNote('');
      toast(`Upload #${u.id} is ready for review – check the changes, then make it current`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setDup(e.message);
      else toast(`Upload failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string, body: unknown, msg: string) => {
    try {
      await api(path, { json: body });
      await refresh();
      toast(msg);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Inventory updates</h1>
          <p>Upload each new VMInfo export here. It is compared with the current data and <b>reviewed before it becomes current</b>. Every upload is kept with who uploaded and who confirmed it, the original file and a change report; any earlier upload can be made current again.</p>
        </div>
      </div>

      {pending && <ReviewPanel id={pending.id} uploadedBy={pending.uploadedBy} uploadedAt={pending.uploadedAt} filename={pending.filename}
        onConfirm={(n) => act(`/uploads/${pending.id}/confirm`, { note: n }, `Upload #${pending.id} is now the current inventory`)}
        onDiscard={() => act(`/uploads/${pending.id}/discard`, {}, `Upload #${pending.id} discarded`)} />}

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad">
          <div className="card-head"><div><h2>Upload latest VMInfo</h2><p className="sub">.xlsx with a <code>VMs</code> sheet (a <code>Clusters</code> sheet is optional). You review the changes before it becomes current.</p></div></div>
          {pending ? (
            <div className="banner" style={{ marginBottom: 0 }}>Upload #{pending.id} is awaiting review above – make it current or discard it before uploading another file.</div>
          ) : (
            <>
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
                <button className="btn btn-primary" disabled={!file || busy} onClick={() => submit(false)}>{busy ? 'Comparing…' : 'Upload & review changes'}</button>
              </div>
            </>
          )}
        </div>

        <div className="card card-pad">
          <div className="card-head"><div><h2>Decisions without a matching application</h2><p className="sub">Decisions are never deleted silently – resolve them here.</p></div></div>
          {!hasInventory ? <div className="note">Upload an inventory first.</div> : orphans.length === 0 ? (
            <div className="note">All {Object.keys(plans).length} decisions match an application in the current inventory. ✓</div>
          ) : (
            <>
              {parkedByMerge.length > 0 && (
                <>
                  <div className="cr-group" style={{ marginTop: 0 }}>Parked by a merge <span className="cr-count warn">{parkedByMerge.length}</span></div>
                  <p className="note" style={{ margin: '0 0 6px' }}>This application was merged into another that already had its own decision. Choose which decision the merged application keeps.</p>
                  {parkedByMerge.map(([k, p]) => (
                    <div className="hist-row" key={k}>
                      <div className="app-name">{k}</div>
                      <div className="muted" style={{ fontSize: 12, margin: '2px 0 4px' }}>merged into <b>{mergeTarget(k)}</b></div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', alignItems: 'center', fontSize: 12.5 }}>
                        <span className="muted">This decision</span><PlanChip p={p} />
                        <span className="muted">Merged application</span><PlanChip p={plans[mergeTarget(k)!]} />
                      </div>
                      <div className="filters" style={{ marginTop: 6 }}>
                        <button className="btn btn-sm" onClick={() => act('/plans/resolve-parked', { key: k, use: 'merged' }, 'Kept the merged application’s decision')}>Keep merged application’s decision</button>
                        <button className="btn btn-sm" onClick={() => act('/plans/resolve-parked', { key: k, use: 'this' }, 'Merged application now uses this decision')}>Use this one instead</button>
                      </div>
                    </div>
                  ))}
                </>
              )}
              {gone.length > 0 && (
                <>
                  <div className="cr-group">Application gone from the file <span className="cr-count warn">{gone.length}</span></div>
                  <p className="note" style={{ margin: '0 0 6px' }}>The name changed or it left the inventory. Re-link the decision to its new name, or remove it (kept in the change history).</p>
                  {gone.map(([k, p]) => <OrphanRow key={k} appKey={k} plan={<PlanChip p={p} />} options={undecided}
                    onRelink={async (to) => { try { await renamePlan(k, to); toast('Decision re-linked'); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); } }}
                    onRemove={async () => {
                      if (!confirm(`Remove the decision for “${k}”? It stays in the change history.`)) return;
                      try { await api(`/plans?key=${encodeURIComponent(k)}`, { method: 'DELETE' }); await refresh(); toast('Decision removed'); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
                    }} />)}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {hasInventory && <MappingRules />}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad" style={{ paddingBottom: 8 }}><h2>Upload history</h2><p className="sub">Open a change report, download the original file, or make an earlier upload current again.</p></div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>#</th><th>File</th><th>Status</th><th>Uploaded</th><th>Made current</th><th className="r">VMs</th><th className="r">vCPU</th><th className="r">Apps</th><th>Attention</th><th /></tr>
            </thead>
            <tbody>
              {(uploads ?? []).map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td className="num">{u.id}</td>
                    <td>{u.filename}{u.note && <div className="muted" style={{ fontSize: 12 }}>“{u.note}”</div>}</td>
                    <td>{u.isCurrent ? <span className="chip" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>current</span> : u.status === 'staged' ? <span className="chip badge-warn">awaiting review</span> : u.status === 'discarded' ? <span className="chip">discarded</span> : <span className="chip">earlier</span>}</td>
                    <td style={{ fontSize: 12.5 }}>{u.uploadedBy}<div className="muted">{fmtDateTime(u.uploadedAt)}</div></td>
                    <td style={{ fontSize: 12.5 }}>{u.confirmedBy ? <>{u.confirmedBy}<div className="muted">{fmtDateTime(u.confirmedAt!)}</div></> : <span className="muted">—</span>}</td>
                    <td className="r num">{fmt(u.vmCount)}</td>
                    <td className="r num">{fmt(u.vcpu)}</td>
                    <td className="r num">{u.appCount}</td>
                    <td>{u.attentionCount !== undefined ? <span className={`cr-count${u.attentionCount ? ' warn' : ''}`}>{u.attentionCount}</span> : <span className="muted">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => setOpenReport(openReport === u.id ? null : u.id)} aria-expanded={openReport === u.id}>{openReport === u.id ? 'Hide report' : 'Change report'}</button>{' '}
                      {u.status === 'confirmed' && !u.isCurrent && (
                        <button className="btn btn-sm" onClick={() => { if (confirm(`Make upload #${u.id} (${u.filename}) the current inventory again? Decisions are not changed; this is logged in Activity.`)) act(`/uploads/${u.id}/revert`, {}, `Upload #${u.id} is current again`); }}>Make current</button>
                      )}{' '}
                      <a className="btn btn-sm" href={`api/uploads/${u.id}/file`}>Download</a>
                    </td>
                  </tr>
                  {openReport === u.id && (
                    <tr className="sub"><td colSpan={10}><ReportLoader url={`/uploads/${u.id}/report`} title={`Change report – upload #${u.id}${u.baseUploadId ? ` compared with #${u.baseUploadId}` : ''}`} /></td></tr>
                  )}
                </Fragment>
              ))}
              {uploads && uploads.length === 0 && <tr><td colSpan={10} className="empty">No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <CompareCard uploads={(uploads ?? []).filter((u) => u.status === 'confirmed')} />
    </div>
  );
}

function ReportLoader({ url, title }: { url: string; title: string }) {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setR(null);
    api<Report>(url).then(setR).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, [url]);
  if (err) return <div className="note">{err}</div>;
  if (!r) return <div className="note">Comparing…</div>;
  return <ChangeReport r={r} title={title} />;
}

function ReviewPanel({ id, filename, uploadedBy, uploadedAt, onConfirm, onDiscard }: { id: number; filename: string; uploadedBy: string; uploadedAt: string; onConfirm: (note: string) => void; onDiscard: () => void }) {
  const [note, setNote] = useState('');
  return (
    <div className="card card-pad review-panel" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Review upload #{id} before it becomes current</h2>
          <p className="sub"><b>{filename}</b> · uploaded by {uploadedBy}, {fmtDateTime(uploadedAt)}. Nothing on the dashboards changes until it is made current.</p>
        </div>
      </div>
      <ReportLoader url={`/uploads/${id}/report`} title="" />
      <div className="filters" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <input className="input" style={{ flex: 1, minWidth: 240, width: 'auto' }} placeholder="Note for the record (optional) – e.g. 'Checked with Hosting team'" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <button className="btn btn-danger" onClick={() => { if (confirm(`Discard upload #${id}? The current inventory stays as it is.`)) onDiscard(); }}>Discard</button>
        <button className="btn btn-primary" onClick={() => onConfirm(note)}>Make current</button>
      </div>
    </div>
  );
}

function CompareCard({ uploads }: { uploads: UploadMeta[] }) {
  const [base, setBase] = useState('');
  const [target, setTarget] = useState('');
  const [go, setGo] = useState<string | null>(null);
  if (uploads.length < 2) return null;
  const opt = (u: UploadMeta) => <option key={u.id} value={u.id}>#{u.id} · {u.filename} · {fmtDateTime(u.uploadedAt)}{u.isCurrent ? ' (current)' : ''}</option>;
  return (
    <div className="card card-pad">
      <div className="card-head"><div><h2>Compare any two uploads</h2><p className="sub">Shows what changed between them and the effect on today’s plan.</p></div></div>
      <div className="filters">
        <select className="select" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Compare from"><option value="">From…</option>{uploads.map(opt)}</select>
        <span className="muted">→</span>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Compare to"><option value="">To…</option>{uploads.map(opt)}</select>
        <button className="btn btn-sm btn-primary" disabled={!base || !target || base === target} onClick={() => setGo(`/compare?base=${base}&target=${target}`)}>Compare</button>
      </div>
      {go && <div style={{ marginTop: 12 }}><ReportLoader url={go} title={`Upload #${base} → #${target}`} /></div>}
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
