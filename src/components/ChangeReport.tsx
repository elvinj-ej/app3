import { useState, type ReactNode } from 'react';
import type { ChangeReport as Report } from '../lib/changes';
import { fyLabel, fmtDate } from '../lib/fy';
import { fmt } from '../lib/useColors';

const tb = (gb: number) => (gb >= 1024 ? `${(gb / 1024).toLocaleString('en-AU', { maximumFractionDigits: 1 })} TB` : `${fmt(gb)} GB`);
const signed = (n: number, f: (x: number) => string = fmt) => (n === 0 ? '±0' : `${n > 0 ? '+' : '−'}${f(Math.abs(n))}`);

function Section({ title, count, tone, children, defaultOpen = false }: { title: string; count: number; tone?: 'warn' | 'ok'; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="cr-sec">
      <button className="cr-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={count === 0}>
        <span className={`cr-count${tone === 'warn' && count ? ' warn' : ''}`}>{count}</span>
        <span className="cr-title">{title}</span>
        {count > 0 && <span className="muted">{open ? '▲' : '▼'}</span>}
      </button>
      {open && count > 0 && <div className="cr-body">{children}</div>}
    </div>
  );
}

function Rows({ rows, max = 200 }: { rows: ReactNode[]; max?: number }) {
  return (
    <ul className="cr-list">
      {rows.slice(0, max).map((r, i) => <li key={i}>{r}</li>)}
      {rows.length > max && <li className="muted">… {rows.length - max} more</li>}
    </ul>
  );
}

export default function ChangeReport({ r, title }: { r: Report; title?: string }) {
  const b = r.totals.before, a = r.totals.after;
  const at = r.effects.attention;
  const f = r.effects.forecast;
  return (
    <div className="cr">
      {title && <h3 className="cr-h">{title}</h3>}
      <div className="cr-kpis">
        {([
          ['VMs', b.vms, a.vms, fmt],
          ['vCPU', b.vcpu, a.vcpu, fmt],
          ['vRAM', b.memGB, a.memGB, tb],
          ['Storage', b.storGB, a.storGB, tb],
        ] as [string, number, number, (x: number) => string][]).map(([k, x, y, fm]) => (
          <div key={k} className="cr-kpi">
            <div className="k-label">{k}</div>
            <div className="num"><b>{fm(y)}</b> <span className={y - x > 0 ? 'cr-up' : y - x < 0 ? 'cr-down' : 'muted'}>{signed(y - x, fm)}</span></div>
            <div className="muted" style={{ fontSize: 11.5 }}>was {fm(x)}</div>
          </div>
        ))}
        <div className="cr-kpi">
          <div className="k-label">vCPU end of {fyLabel(f.horizonFY)} (risk-adj.)</div>
          <div className="num"><b>{fmt(f.endAfter.risk)}</b> <span className={f.endAfter.risk - f.endBefore.risk > 0 ? 'cr-up' : f.endAfter.risk - f.endBefore.risk < 0 ? 'cr-down' : 'muted'}>{signed(f.endAfter.risk - f.endBefore.risk)}</span></div>
          <div className="muted" style={{ fontSize: 11.5 }}>full plan {fmt(f.endBefore.plan)} → {fmt(f.endAfter.plan)}</div>
        </div>
      </div>
      <p className="note" style={{ margin: '4px 0 10px' }}>Footprint figures are for powered-on VMs (virtualization resources excluded), after mapping rules.</p>

      <div className="cr-group">Needs attention <span className={`cr-count${r.attentionCount ? ' warn' : ''}`}>{r.attentionCount}</span></div>
      <Section title="New applications without a decision" count={at.newApps.length} tone="warn" defaultOpen>
        <Rows rows={at.newApps.map((x) => <><b>{x.key}</b> <span className="muted">· {x.vms} VMs, {fmt(x.vcpu)} vCPU</span></>)} />
      </Section>
      <Section title="Decisions whose application left the file (parked)" count={at.parked.length} tone="warn">
        <Rows rows={at.parked.map((x) => <><b>{x.key}</b> <span className="muted">· {x.treatment}</span></>)} />
      </Section>
      <Section title="Decided applications whose footprint moved (≥10% and ≥5 vCPU / 10 GB vRAM / 1 TB storage)" count={at.shifted.length} tone="warn">
        <Rows rows={at.shifted.map((x) => <><b>{x.key}</b> <span className="muted">· {x.treatment}</span> – {x.reasons.join(' · ')}{x.grewWhileRetiring && <span className="chip badge-warn" style={{ marginLeft: 6 }}>grew while set to Retire</span>}</>)} />
      </Section>
      <Section title="New VMs in applications scheduled to leave on-prem" count={at.newVmsInMovingApps.length} tone="warn">
        <Rows rows={at.newVmsInMovingApps.map((x) => <><b>{x.vm}</b> <span className="muted">→ {x.app} · {x.treatment}</span></>)} />
      </Section>
      <Section title="Mapping-rule conflicts (file now assigns the VM elsewhere)" count={r.effects.rules.conflicts.length} tone="warn">
        <Rows rows={r.effects.rules.conflicts} />
      </Section>
      <Section title="VMs moved onto a data-sovereignty cluster" count={r.effects.sovereignty.onto.length} tone="warn">
        <Rows rows={r.effects.sovereignty.onto.map((x) => <><b>{x.vm}</b> <span className="muted">→ {x.cluster}</span></>)} />
      </Section>

      <div className="cr-group">What changed in the file</div>
      <Section title="New applications" count={r.apps.added.length}>
        <Rows rows={r.apps.added.map((x) => <><b>{x.key}</b> <span className="muted">· {x.vms} VMs, {fmt(x.vcpu)} vCPU</span></>)} />
      </Section>
      <Section title="Applications no longer in the file" count={r.apps.removed.length}>
        <Rows rows={r.apps.removed.map((x) => <><b>{x.key}</b> <span className="muted">· {x.vms} VMs{x.hadDecision ? ' · had a decision' : ''}</span></>)} />
      </Section>
      <Section title="Probably renamed (same VMs, new Application_Primary)" count={r.apps.renamed.length} defaultOpen>
        <Rows rows={r.apps.renamed.map((x) => <><span className="muted">{x.from}</span> → <b>{x.to}</b> <span className="muted">· {x.sharedVms} VMs</span></>)} />
        <p className="note">Re-link the decision or add a merge rule under “Application mapping rules” below.</p>
      </Section>
      <Section title="New VMs" count={r.vms.added.length}>
        <Rows rows={r.vms.added.map((x) => <><b>{x.name}</b> <span className="muted">· {x.app} · {x.cluster} · {x.vcpu} vCPU{x.created ? ` · created ${x.created}` : ''}{x.buildUser ? ` by ${x.buildUser}` : ''}</span></>)} />
      </Section>
      <Section title="Removed VMs" count={r.vms.removed.length}>
        <Rows rows={r.vms.removed.map((x) => <><b>{x.name}</b> <span className="muted">· {x.app} · {x.cluster} · {x.vcpu} vCPU</span></>)} />
      </Section>
      <Section title="Changed VMs" count={r.vms.changed.length}>
        <table className="t cr-table">
          <thead><tr><th>VM</th><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {r.vms.changed.slice(0, 400).flatMap((c) => c.changes.map((x, i) => (
              <tr key={`${c.name}-${x.field}`}>
                <td>{i === 0 ? <b>{c.name}</b> : ''}</td><td className="muted">{x.field}</td><td className="muted">{x.from}</td><td>{x.to}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </Section>

      <div className="cr-group">Other effects</div>
      <Section title="Key deadlines – projected vCPU before → after" count={r.effects.deadlines.filter((d) => d.before !== d.after).length}>
        <Rows rows={r.effects.deadlines.map((d) => <><b>{d.label}</b> <span className="muted">({fmtDate(d.date)})</span>: {fmt(d.before)} → <b>{fmt(d.after)}</b> vCPU</>)} />
      </Section>
      <Section title="Mapping rules no longer needed" count={r.effects.rules.noLongerNeeded.length}>
        <Rows rows={r.effects.rules.noLongerNeeded} />
      </Section>
      <Section title="VMs moved off a data-sovereignty cluster" count={r.effects.sovereignty.off.length}>
        <Rows rows={r.effects.sovereignty.off.map((x) => <><b>{x.vm}</b> <span className="muted">← {x.cluster}</span></>)} />
      </Section>
      <Section title="VMs moved to a cluster of another hardware vendor" count={r.effects.hardware.length}>
        <Rows rows={r.effects.hardware.map((x) => <><b>{x.vm}</b> <span className="muted">{x.from} → {x.to}</span></>)} />
      </Section>
    </div>
  );
}
