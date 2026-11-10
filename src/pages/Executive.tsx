import { useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useStore, vendorOf } from '../lib/store';
import { DISP, DISPOSITIONS } from '../lib/dispositions';
import { daysUntil, fmtDate, fyEnd, fyLabel, fyOf, fyQuarterOf, humanCountdown, parseISODate, quarterLabel } from '../lib/fy';
import { byDisposition, vmExitDate, exitsBy, footprintScenarios, groupApps, planFor, scopeVMs, totals, trend, whatStays, type Granularity, type Scenarios, type TrendPoint } from '../lib/projection';
import { CONFIDENCE, VENDOR_LABEL, deadlineVendor, isOnExec, milestoneColor, milestoneMarker } from '../lib/defaults';
import { parseApp } from '../lib/parse';
import { buildTimeline, type TimelineEntry } from '../lib/timeline';
import { fmt, useColors } from '../lib/useColors';
import type { Deadline } from '../lib/types';

export default function Executive({ onPlan }: { onPlan: () => void }) {
  const { inventory, plans, settings, updateSettings } = useStore();
  const color = useColors();
  const [mode, setMode] = useState<'indexed' | 'absolute'>('indexed');
  const [exitMetric, setExitMetric] = useState<'vcpu' | 'vms'>('vcpu');
  const [gran, setGran] = useState<Granularity>('quarter');
  const [basis, setBasisState] = useState<Basis>(() => {
    try {
      return localStorage.getItem('fp.basis') === 'plan' ? 'plan' : 'risk';
    } catch {
      return 'risk';
    }
  });
  const setBasis = (b: Basis) => {
    setBasisState(b);
    try {
      localStorage.setItem('fp.basis', b);
    } catch {
      /* ignore */
    }
  };
  const isRisk = basis === 'risk';
  const bLabel = isRisk ? 'risk-adjusted' : 'full plan';

  const vms = useMemo(() => scopeVMs(inventory.vms, settings, plans), [inventory, settings, plans]);
  const base = useMemo(() => totals(vms), [vms]);
  // Storage counts every VM incl. powered-off (they still occupy disk); VMs / vCPU / vRAM use the footprint scope.
  const storVms = useMemo(() => scopeVMs(inventory.vms, { ...settings, includePoweredOff: true }, plans), [inventory, settings, plans]);
  const points = useMemo<ViewPoint[]>(() => trend(vms, plans, settings, gran, storVms).map((p) => toView(p, basis)), [vms, plans, settings, gran, basis, storVms]);
  const exits = useMemo(() => exitsBy(vms, plans, settings, exitMetric, gran, isRisk), [vms, plans, settings, exitMetric, gran, isRisk]);
  const disp = useMemo(() => byDisposition(vms, plans), [vms, plans]);
  const apps = useMemo(() => groupApps(vms), [vms]);
  const endPt = points[points.length - 1];

  const decidedApps = apps.filter((a) => planFor(plans, a.key).disposition !== 'tbd').length;
  const decidedVcpu = vms.filter((v) => planFor(plans, v.appKey).disposition !== 'tbd').reduce((s, v) => s + v.vcpu, 0);
  const unscheduled = disp.reduce((s, d) => s + d.unscheduledVms, 0);
  const confStats = useMemo(() => {
    const by = { high: 0, medium: 0, low: 0, unknown: 0 };
    let total = 0;
    const unrated = new Set<string>();
    for (const v of vms) {
      const p = planFor(plans, v.appKey);
      if (!vmExitDate(p, v)) continue;
      total += v.vcpu;
      if (p.confidence) by[p.confidence] += v.vcpu;
      else unrated.add(v.appKey);
    }
    return { by, total, unratedApps: unrated.size };
  }, [vms, plans]);

  // Only milestones marked 'Show on Executive Summary', numbered by date.
  const deadlines = settings.deadlines.filter(isOnExec).sort((a, b) => a.date.localeCompare(b.date));
  const dlNum = new Map(deadlines.map((d, i) => [d.id, i + 1]));
  const dlColor = (d: Deadline) => milestoneColor(d, settings.deadlines);
  const nextDl = deadlines.find((d) => daysUntil(d.date) >= 0);

  // Group deadlines by the period (quarter or FY) they fall in – the chart axis is categorical.
  const refLines = useMemo(() => {
    const labels = new Set(points.map((p) => p.label));
    const m = new Map<string, Deadline[]>();
    for (const d of deadlines) {
      const dt = parseISODate(d.date);
      const k = gran === 'quarter' ? quarterLabel(fyOf(dt), fyQuarterOf(dt)) : fyLabel(fyOf(dt));
      if (!labels.has(k)) continue;
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.entries()];
  }, [deadlines, points, gran]);
  const absMax = Object.fromEntries(METRICS.map((m) => [m.id, Math.max(1, ...points.map((p) => Math.max(p[m.val], p[m.plan], p[m.commit])))])) as Record<MetricId, number>;
  // End labels on the indexed chart: spread so they never overlap (min ~6 percentage points apart).
  const endOffsets = (() => {
    const last = points[points.length - 1];
    const order = METRICS.map((m) => ({ id: m.id, v: last ? last[m.pct] : 0 })).sort((a, b) => b.v - a.v);
    const out: Record<string, number> = {};
    let prev = Infinity;
    for (const o of order) {
      const adj = Math.min(o.v, prev - 6);
      out[o.id] = o.v - adj;
      prev = adj;
    }
    return out;
  })();
  const pxPerPct = (330 - 28 - (gran === 'quarter' ? 40 : 30) - 5) / 100;
  const xTick = gran === 'quarter' ? { tick: <QuarterTick fill={color('--text-2')} />, interval: 0, height: 40 } : {};
  const dotR = gran === 'quarter' ? 3 : 4;

  // Milestones on the chart: numbered coloured dots just above the time axis (stacked when several share a period),
  // or a dotted vertical line for enterprise-wide milestones. Same number + colour as the Key deadlines list.
  const refs = (yFor: (k: number) => number) =>
    refLines.flatMap(([period, ds]) => {
      const lines = ds.filter((d) => milestoneMarker(d) === 'line');
      const dots = ds.filter((d) => milestoneMarker(d) === 'dot');
      return [
        ...lines.map((d) => (
          <ReferenceLine key={`l:${d.id}`} x={period} stroke={dlColor(d)} strokeWidth={2} strokeDasharray="2 4"
            label={<LineBadge n={dlNum.get(d.id)!} fill={dlColor(d)} title={`${d.label} – ${fmtDate(d.date)}`} surface={color('--surface')} />} />
        )),
        ...dots.map((d, k) => (
          <ReferenceDot key={`d:${d.id}`} x={period} y={yFor(k)} r={9} ifOverflow="visible"
            shape={(p: { cx?: number; cy?: number }) => <Badge cx={p.cx ?? 0} cy={p.cy ?? 0} n={dlNum.get(d.id)!} fill={dlColor(d)} title={`${d.label} – ${fmtDate(d.date)}`} surface={color('--surface')} />} />
        )),
      ];
    });

  const axisProps = {
    tick: { fill: color('--text-2'), fontSize: 12 },
    axisLine: { stroke: color('--border-strong') },
    tickLine: false,
  } as const;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Executive summary</h1>
          <p>
            On-prem virtualisation footprint and its projected run-down by financial year (FY starts 1 July). Current
            year: <b>{fyLabel(settings.currentFY)}</b>.
          </p>
        </div>
        <div className="filters no-print">
          <div className="seg" role="group" aria-label="Forecast basis" title="Risk-adjusted weights each move by its confidence. Full plan assumes every move happens on its target quarter.">
            <button aria-pressed={isRisk} onClick={() => setBasis('risk')}>Risk-adjusted</button>
            <button aria-pressed={!isRisk} onClick={() => setBasis('plan')}>Full plan</button>
          </div>
          <div className="seg" role="group" aria-label="Timeline granularity">
            <button aria-pressed={gran === 'quarter'} onClick={() => setGran('quarter')}>By quarter</button>
            <button aria-pressed={gran === 'fy'} onClick={() => setGran('fy')}>By FY</button>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.includePoweredOff}
              onChange={(e) => updateSettings({ includePoweredOff: e.target.checked })}
            />
            Include powered-off VMs ({inventory.vms.filter((v) => !v.poweredOn).length})
          </label>
          <button className="btn" onClick={printSummary}>Print / Save as PDF</button>
          <a className="btn btn-primary" href={`api/export/treatment-plan.xlsx?basis=${basis}`} title="Executive summary with charts (follows the Risk-adjusted / Full plan toggle), treatment plan, quarterly roadmap, VMs and change log">Export to Excel (with charts)</a>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid g-kpi kpi-2rows" style={{ marginBottom: 16 }}>
        <VmCountCard />
        <ResourcesCard vms={vms} />
        <div className="card kpi">
          <div className="k-label">Applications with a decision</div>
          <div className="k-value num">
            {decidedApps}<small>/ {apps.length}</small>
          </div>
          <div className="meter" title={`${Math.round((decidedVcpu / (base.vcpu || 1)) * 100)}% of vCPU decided`}>
            {DISPOSITIONS.filter((d) => d.id !== 'tbd').map((d) => {
              const s = disp.find((x) => x.id === d.id)!;
              return s.vcpu ? <span key={d.id} style={{ width: `${(s.vcpu / base.vcpu) * 100}%`, background: d.color }} /> : null;
            })}
          </div>
          <div className="k-foot">{Math.round((decidedVcpu / (base.vcpu || 1)) * 100)}% of vCPU has a disposition</div>
        </div>
        <div className="card kpi kpi-span2">
          <div className="k-label">Projected at end of {fyLabel(settings.horizonFY)} · {bLabel}</div>
          <div className="proj-grid" title="Full plan = every scheduled move happens on its target quarter. Committed = only High-confidence moves happen.">
            {METRICS.filter((m) => m.id !== 'vms').map((m) => (
              <div key={m.id}>
                <div className="proj-k">{m.id === 'vcpu' ? 'vCPU' : m.id === 'mem' ? 'vRAM assigned' : 'Storage provisioned'}</div>
                <div className="k-value num proj-v">{m.format(endPt[m.val])}</div>
                <div className="k-foot"><span className="delta-down">−{fmt(100 - endPt[m.pct])}%</span> vs today ({m.format(points[0][m.val])})</div>
                <div className="k-foot">{isRisk ? 'Full plan' : 'Risk-adj.'} {m.format(isRisk ? endPt[m.plan] : endPt[m.risk])}</div>
                <div className="k-foot">Committed {m.format(endPt[m.commit])}</div>
              </div>
            ))}
          </div>
          <div className="k-foot">{fmt(endPt.vms)} VMs remaining · <span className="delta-down">−{fmt(100 - endPt.vmsPct)}% VMs</span></div>
        </div>
        <div className="card kpi">
          <div className="k-label">Confidence of scheduled moves</div>
          <div className="k-value num">{confStats.total ? Math.round(((confStats.by.high + confStats.by.medium) / confStats.total) * 100) : 0}%<small>High / Medium</small></div>
          <div className="meter" title="Share of scheduled vCPU by confidence">
            {CONFIDENCE.map((c) => (confStats.by[c.id] ? <span key={c.id} style={{ width: `${(confStats.by[c.id] / confStats.total) * 100}%`, background: c.color }} /> : null))}
          </div>
          <div className="k-foot">{confStats.unratedApps ? `${confStats.unratedApps} scheduled apps not rated yet` : 'All scheduled apps rated'}</div>
        </div>
        <div className="card kpi">
          <div className="k-label">Next deadline</div>
          {nextDl ? (
            <>
              <div className="k-value" style={{ fontSize: 20, marginTop: 8 }}>{humanCountdown(daysUntil(nextDl.date))}</div>
              <div className="k-foot">
                {nextDl.label} · {fmtDate(nextDl.date)}
              </div>
            </>
          ) : (
            <div className="k-foot">No upcoming deadlines set</div>
          )}
        </div>
      </div>

      {unscheduled > 0 && (
        <div className="banner">
          {fmt(unscheduled)} VMs belong to applications marked to leave on-prem but have no target FY – they are still
          counted as on-prem in the projection.
          <button className="btn btn-sm" onClick={onPlan}>Set target FY</button>
        </div>
      )}

      <div className="grid g-main" style={{ marginBottom: 16 }}>
        {/* Trend */}
        <div className="card card-pad">
          <div className="card-head">
            <div>
              <h2>On-prem footprint by {gran === 'quarter' ? 'quarter' : 'financial year'}</h2>
              <p className="sub">
                {mode === 'indexed'
                  ? `${isRisk ? 'Risk-adjusted' : 'Full-plan'} VMs, vCPU, vRAM and storage remaining at the end of each ${gran === 'quarter' ? 'FY quarter' : 'FY'}, indexed to today = 100%. Hover for the other scenarios.`
                  : `${isRisk ? 'Risk-adjusted forecast' : 'Full plan'} (solid line) within the range from committed (High confidence only) to full plan (every move on its target quarter).`}
              </p>
            </div>
            <div className="seg" role="group" aria-label="Chart scale">
              <button aria-pressed={mode === 'indexed'} onClick={() => setMode('indexed')}>Indexed %</button>
              <button aria-pressed={mode === 'absolute'} onClick={() => setMode('absolute')}>Absolute</button>
            </div>
          </div>
          <div className="legend" style={{ marginBottom: 8 }}>
            <span><i className="ln" style={{ background: 'var(--line-vm)' }} /> VMs</span>
            <span><i className="ln" style={{ background: 'var(--line-vcpu)' }} /> vCPU</span>
            <span><i className="ln" style={{ background: 'var(--line-mem)' }} /> vRAM</span>
            <span><i className="ln" style={{ background: 'var(--line-stor)' }} /> Storage</span>
            {mode === 'absolute' && <span><i className="dot" style={{ background: 'var(--text-3)', opacity: 0.25, width: 16 }} /> Range: committed ↔ full plan</span>}
            {mode === 'absolute' && <span><i className="ln" style={{ background: 'none', borderTop: '2px dashed var(--text-3)' }} /> {isRisk ? 'Full plan' : 'Risk-adjusted'}</span>}
            {refLines.length > 0 && <span><i className="ms-dot">1</i> Milestone – see Key deadlines (placed in the {gran === 'quarter' ? 'quarter' : 'FY'} it falls in)</span>}
            {refLines.some(([, ds]) => ds.some((d) => milestoneMarker(d) === 'line')) && <span><i className="ln" style={{ background: 'none', borderTop: '2px dotted var(--text-2)' }} /> Enterprise-wide milestone</span>}
          </div>
          {mode === 'indexed' ? (
            <ResponsiveContainer width="100%" height={330}>
              <LineChart data={points} margin={{ top: 28, right: 128, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={color('--grid')} />
                <XAxis dataKey="label" {...axisProps} {...xTick} />
                <YAxis domain={[0, 100]} unit="%" {...axisProps} axisLine={false} width={48} />
                <Tooltip content={<TrendTip />} cursor={{ stroke: color('--border-strong') }} />
                {refs((k) => 6 + k * 9)}
                {METRICS.map((m) => (
                  <Line key={m.id} animationDuration={500} type="linear" dataKey={m.pct} name={m.label} stroke={color(m.cssVar)} strokeWidth={2}
                    dot={{ r: dotR, strokeWidth: 2, stroke: color('--surface'), fill: color(m.cssVar) }} activeDot={{ r: 6, strokeWidth: 2, stroke: color('--surface') }}
                    label={<EndLabel n={points.length} text={`${m.label} ${m.format(points[points.length - 1]?.[m.val] ?? 0)}`} color={color('--text-2')} dyPx={endOffsets[m.id] * pxPerPct} />} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="grid abs-grid">
              {METRICS.map((m) => (
                <div key={m.id}>
                  <div className="note" style={{ fontWeight: 600, color: 'var(--text-2)' }}>{m.id === 'mem' ? 'vRAM assigned' : m.id === 'stor' ? 'Storage provisioned' : m.label}</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={points.map((p) => ({ ...p, _v: p[m.val] / m.div, _alt: p[m.alt] / m.div, band: [p[m.plan] / m.div, p[m.commit] / m.div] }))} margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke={color('--grid')} />
                      <XAxis dataKey="label" {...axisProps} {...xTick} />
                      <YAxis {...axisProps} axisLine={false} width={56} tickFormatter={(v) => m.tick(v)} domain={[0, 'auto']} />
                      <Tooltip content={<TrendTip />} cursor={{ stroke: color('--border-strong') }} />
                      {refs((k) => (absMax[m.id] / m.div) * (0.07 + k * 0.11))}
                      <Area animationDuration={500} type="linear" dataKey="band" stroke="none" fill={color(m.cssVar)} fillOpacity={0.16} activeDot={false} />
                      <Line animationDuration={500} type="linear" dataKey="_alt" stroke={color('--text-3')} strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />
                      <Line animationDuration={500} type="linear" dataKey="_v" stroke={color(m.cssVar)} strokeWidth={2}
                        dot={{ r: dotR, strokeWidth: 2, stroke: color('--surface'), fill: color(m.cssVar) }} activeDot={{ r: 6 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="note" style={{ cursor: 'pointer' }}>Table view</summary>
            <table className="t" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Point ({bLabel})</th>{METRICS.map((m) => <th key={m.id} className="r">{m.label}</th>)}{METRICS.map((m) => <th key={`p${m.id}`} className="r">{m.label} %</th>)}<th className="r">vCPU risk-adj.</th><th className="r">vCPU full plan</th><th className="r">vCPU committed</th></tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.label}>
                    <td>{p.label === 'Now' ? 'Today' : `End of ${p.label}`}</td>
                    {METRICS.map((m) => <td key={m.id} className="r num">{m.format(p[m.val])}</td>)}
                    {METRICS.map((m) => <td key={`p${m.id}`} className="r num">{p[m.pct]}%</td>)}
                    <td className="r num">{fmt(p.vcpuRisk)}</td><td className="r num">{fmt(p.vcpuPlan)}</td><td className="r num">{fmt(p.vcpuCommit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>

        {/* Deadlines */}
        <div className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Key deadlines</h2>
              <p className="sub">Projected on-prem vCPU on each date: risk-adjusted · full plan · committed</p>
            </div>
            <a className="btn btn-sm" href="#/settings">Edit</a>
          </div>
          {deadlines.length === 0 && <div className="note">No deadlines set.</div>}
          {deadlines.map((d) => {
            const at = parseISODate(d.date);
            const vendor = deadlineVendor(d.kind);
            const vf = vendor ? (v: { location: string }) => vendorOf(settings, v.location) === vendor : undefined;
            const sc = footprintScenarios(vms, plans, at, settings.confidenceWeights, vf);
            const today = totals(vf ? vms.filter(vf) : vms);
            const days = daysUntil(d.date);
            return (
              <div className="deadline" key={d.id}>
                <div className="dl-date">
                  <div className="m">{at.toLocaleDateString('en-AU', { month: 'short' })}</div>
                  <div className="y">{at.getFullYear()}</div>
                </div>
                <div className="dl-title">
                  <i className="ms-dot" style={{ background: dlColor(d) }} title={milestoneMarker(d) === 'line' ? 'Dotted line on the chart' : 'Dot on the chart'}>{dlNum.get(d.id)}</i>
                  {d.label}{milestoneMarker(d) === 'line' && <span className="chip">enterprise-wide</span>}
                  {!d.confirmed && <span className="chip badge-warn">Date to confirm</span>}
                </div>
                <div className="dl-meta">
                  {fmtDate(d.date)} · {fyLabel(fyOf(at))} · {humanCountdown(days)}
                </div>
                <div className="dl-proj">
                  <DeadlineNumbers sc={sc} today={today} basis={basis} scope={vendor ? `On ${VENDOR_LABEL[vendor]} clusters` : 'Remaining'} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        {/* Exits per FY */}
        <div className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Leaving on-prem each {gran === 'quarter' ? 'quarter' : 'FY'}</h2>
              <p className="sub">By treatment – {isRisk ? 'each move weighted by its confidence' : 'every scheduled move at full value'}</p>
            </div>
            <div className="seg" role="group" aria-label="Metric">
              <button aria-pressed={exitMetric === 'vcpu'} onClick={() => setExitMetric('vcpu')}>vCPU</button>
              <button aria-pressed={exitMetric === 'vms'} onClick={() => setExitMetric('vms')}>VMs</button>
            </div>
          </div>
          <div className="legend" style={{ marginBottom: 8 }}>
            {DISPOSITIONS.filter((d) => d.leavesOnPrem).map((d) => (
              <span key={d.id}><i className="dot" style={{ background: d.color }} />{d.short}</span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={exits} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
              <CartesianGrid vertical={false} stroke={color('--grid')} />
              <XAxis dataKey="label" {...axisProps} {...xTick} />
              <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={(v) => fmt(v)} allowDecimals={false} />
              <Tooltip content={<ExitTip metric={exitMetric} />} cursor={{ fill: color('--grid'), opacity: 0.5 }} />
              {DISPOSITIONS.filter((d) => d.leavesOnPrem).map((d, i, arr) => (
                <Bar animationDuration={500} key={d.id} dataKey={d.id} stackId="x" fill={color(d.color)} stroke={color('--surface')} strokeWidth={1}
                  radius={i === arr.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={56} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          {exits.every((e: { total: number }) => e.total === 0) && (
            <div className="note" style={{ textAlign: 'center' }}>
              Nothing scheduled yet – set dispositions and target FYs in the <a href="#/planner">Application Planner</a>.
            </div>
          )}
        </div>

        {/* Disposition mix */}
        <div className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Disposition mix</h2>
              <p className="sub">Share of today's vCPU by target disposition</p>
            </div>
          </div>
          <div className="bar-list">
            {DISPOSITIONS.filter((d) => d.group !== 'Excluded').map((d) => {
              const s = disp.find((x) => x.id === d.id)!;
              const max = Math.max(...disp.map((x) => x.vcpu), 1);
              return (
                <div className="bar-row" key={d.id} title={`${s.apps} apps · ${fmt(s.vms)} VMs · ${fmt(s.vcpu)} vCPU`}>
                  <div className="lbl"><i className="dot" style={{ background: d.color }} /><span>{d.short}</span></div>
                  <div className="track"><div className="fill" style={{ width: `${(s.vcpu / max) * 100}%`, background: d.color }} /></div>
                  <div className="val num">{fmt(s.vcpu)} · {base.vcpu ? Math.round((s.vcpu / base.vcpu) * 100) : 0}%</div>
                </div>
              );
            })}
          </div>
          <table className="t" style={{ marginTop: 16, tableLayout: 'fixed' }}>
            <thead><tr><th style={{ width: '46%' }}>Group</th><th className="r">Apps</th><th className="r">VMs</th><th className="r">vCPU</th></tr></thead>
            <tbody>
              {(['Exit', 'Cloud', 'Retain', 'Undecided'] as const).map((g) => {
                const rows = disp.filter((s) => DISP[s.id].group === g);
                const label = { Exit: 'Retire / SaaS', Cloud: 'Hyperscaler (AWS / Azure)', Retain: 'Stays on-prem', Undecided: 'Undecided' }[g];
                return (
                  <tr key={g}>
                    <td>{label}</td>
                    <td className="r num">{rows.reduce((a, r) => a + r.apps, 0)}</td>
                    <td className="r num">{fmt(rows.reduce((a, r) => a + r.vms, 0))}</td>
                    <td className="r num">{fmt(rows.reduce((a, r) => a + r.vcpu, 0))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <WhatStaysCard basis={basis} />

      <TreatmentMatrix />

      <div className="grid g-2">
        <DomainTable basis={basis} />
        <HardwareTable />
      </div>
    </div>
  );
}

function EndLabel(props: { x?: number; y?: number; index?: number; n: number; text: string; color: string; dyPx: number }) {
  const { x, y, index, n, text, color, dyPx } = props;
  if (index !== n - 1 || x === undefined || y === undefined) return null;
  return (
    <text x={x + 10} y={y + dyPx} fill={color} fontSize={12} dominantBaseline="middle">
      {text}
    </text>
  );
}

function TrendTip({ active, payload, label }: { active?: boolean; payload?: { payload: ViewPoint }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="h">{label === 'Now' ? 'Today' : `End of ${label}`}</div>
      <div className="r"><span><i className="dot" style={{ background: 'var(--line-vm)' }} /> VMs ({p.basis === 'risk' ? 'risk-adj.' : 'full plan'})</span><b className="num">{fmt(p.vms)} · {p.vmsPct}%</b></div>
      <div className="r"><span><i className="dot" style={{ background: 'var(--line-vcpu)' }} /> vCPU ({p.basis === 'risk' ? 'risk-adj.' : 'full plan'})</span><b className="num">{fmt(p.vcpu)} · {p.vcpuPct}%</b></div>
      <div className="r"><span><i className="dot" style={{ background: 'var(--line-mem)' }} /> vRAM</span><b className="num">{fmtTB(p.memGB)} · {p.memPct}%</b></div>
      <div className="r"><span><i className="dot" style={{ background: 'var(--line-stor)' }} /> Storage</span><b className="num">{fmtTB(p.storGB)} · {p.storPct}%</b></div>
      <div className="r" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>{p.basis === 'risk' ? 'vCPU full plan' : 'vCPU risk-adjusted'}</span><b className="num">{fmt(p.basis === 'risk' ? p.vcpuPlan : p.vcpuRisk)}</b></div>
      <div className="r"><span>vCPU committed</span><b className="num">{fmt(p.vcpuCommit)}</b></div>
    </div>
  );
}

function ExitTip({ active, payload, label, metric }: { active?: boolean; payload?: { payload: Record<string, number> }[]; label?: string; metric: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="h">{label} – leaving on-prem</div>
      {DISPOSITIONS.filter((d) => d.leavesOnPrem && row[d.id]).map((d) => (
        <div className="r" key={d.id}><span><i className="dot" style={{ background: d.color }} /> {d.short}</span><b className="num">{fmt(row[d.id])}</b></div>
      ))}
      <div className="r" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
        <span>Total</span><b className="num">{fmt(row.total)} {metric === 'vcpu' ? 'vCPU' : 'VMs'}</b>
      </div>
    </div>
  );
}

function DomainTable({ basis }: { basis: Basis }) {
  const { inventory, plans, settings } = useStore();
  const vms = scopeVMs(inventory.vms, settings, plans);
  const end = fyEnd(settings.horizonFY);
  const rows = useMemo(() => {
    const m = new Map<string, { domain: string; apps: Set<string>; vms: number; vcpu: number; decided: number; endVcpu: number }>();
    for (const v of vms) {
      const d = parseApp(v.appKey).domain;
      let r = m.get(d);
      if (!r) m.set(d, (r = { domain: d, apps: new Set(), vms: 0, vcpu: 0, decided: 0, endVcpu: 0 }));
      r.apps.add(v.appKey);
      r.vms++;
      r.vcpu += v.vcpu;
      if (planFor(plans, v.appKey).disposition !== 'tbd') r.decided += v.vcpu;
    }
    for (const r of m.values()) r.endVcpu = footprintScenarios(vms, plans, end, settings.confidenceWeights, (v) => parseApp(v.appKey).domain === r.domain)[basis === 'risk' ? 'risk' : 'plan'].vcpu;
    return [...m.values()].sort((a, b) => b.vcpu - a.vcpu);
  }, [vms, plans, end, settings.confidenceWeights, basis]);
  return (
    <div className="card card-pad">
      <div className="card-head"><div><h2>Footprint by domain</h2><p className="sub">Domain parsed from Application_Primary</p></div></div>
      <div className="table-wrap" style={{ borderTop: 0 }}>
        <table className="t">
          <thead><tr><th>Domain</th><th className="r">Apps</th><th className="r">VMs</th><th className="r">vCPU</th><th className="r">Decided</th><th className="r">vCPU end {fyLabel(settings.horizonFY)} ({basis === 'risk' ? 'risk-adj.' : 'full plan'})</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.domain}>
                <td>{r.domain}</td>
                <td className="r num">{r.apps.size}</td>
                <td className="r num">{fmt(r.vms)}</td>
                <td className="r num">{fmt(r.vcpu)}</td>
                <td className="r num">{r.vcpu ? Math.round((r.decided / r.vcpu) * 100) : 0}%</td>
                <td className="r num">{fmt(r.endVcpu)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HardwareTable() {
  const { inventory, settings } = useStore();
  const rows = useMemo(() => {
    const m = new Map<string, { vendor: string; clusters: number; hosts: number; cores: number; vcpu: number; vms: number }>();
    for (const c of inventory.clusters) {
      const vendor = vendorOf(settings, c.name);
      let r = m.get(vendor);
      if (!r) m.set(vendor, (r = { vendor, clusters: 0, hosts: 0, cores: 0, vcpu: 0, vms: 0 }));
      r.clusters++;
      r.hosts += c.hosts;
      r.cores += c.cores;
      r.vcpu += c.runningVcpu;
      r.vms += c.runningVMs;
    }
    return [...m.values()].sort((a, b) => b.cores - a.cores);
  }, [inventory, settings]);
  const t = rows.reduce((a, r) => ({ hosts: a.hosts + r.hosts, cores: a.cores + r.cores, vcpu: a.vcpu + r.vcpu, vms: a.vms + r.vms, clusters: a.clusters + r.clusters }), { hosts: 0, cores: 0, vcpu: 0, vms: 0, clusters: 0 });
  return (
    <div className="card card-pad">
      <div className="card-head">
        <div><h2>Hardware estate</h2><p className="sub">From the Clusters sheet · vendor mapping editable in Settings</p></div>
      </div>
      {rows.length === 0 ? (
        <div className="note">No Clusters sheet in the loaded workbook.</div>
      ) : (
        <div className="table-wrap" style={{ borderTop: 0 }}>
        <table className="t">
          <thead><tr><th>Vendor</th><th className="r">Clusters</th><th className="r">ESXi hosts</th><th className="r">Physical cores</th><th className="r">Running VMs</th><th className="r">Running vCPU</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vendor}>
                <td>{VENDOR_LABEL[r.vendor as keyof typeof VENDOR_LABEL] ?? r.vendor}</td>
                <td className="r num">{r.clusters}</td><td className="r num">{r.hosts}</td><td className="r num">{fmt(r.cores)}</td>
                <td className="r num">{fmt(r.vms)}</td><td className="r num">{fmt(r.vcpu)}</td>
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td>
              <td className="r num"><b>{t.clusters}</b></td><td className="r num"><b>{t.hosts}</b></td><td className="r num"><b>{fmt(t.cores)}</b></td>
              <td className="r num"><b>{fmt(t.vms)}</b></td><td className="r num"><b>{fmt(t.vcpu)}</b></td>
            </tr>
          </tbody>
        </table>
        </div>
      )}
      {t.cores > 0 && <p className="note" style={{ marginTop: 10 }}>vCPU : physical core ratio {(t.vcpu / t.cores).toFixed(2)} : 1. VMware VCF subscriptions are metered on physical cores (16-core minimum per CPU), so retiring hosts — not only vCPU — is what reduces that bill.</p>}
    </div>
  );
}

function QuarterTick(props: { x?: number; y?: number; payload?: { value: string; index: number }; fill: string }) {
  const { x = 0, y = 0, payload, fill } = props;
  if (!payload) return null;
  const v = payload.value;
  if (v === 'Now') return <text x={x} y={y + 14} textAnchor="middle" fill={fill} fontSize={11}>Now</text>;
  const [fy, q] = v.split(' ');
  const showFy = q === 'Q1' || payload.index === 1;
  return (
    <g>
      <text x={x} y={y + 14} textAnchor="middle" fill={fill} fontSize={10.5}>{q}</text>
      {showFy && <text x={x} y={y + 30} textAnchor="middle" fill={fill} fontSize={11} fontWeight={600}>{fy}</text>}
    </g>
  );
}

function DeadlineNumbers({ sc, today, scope, basis }: { sc: Scenarios; today: { vcpu: number; vms: number }; scope: string; basis: Basis }) {
  const head = basis === 'risk' ? sc.risk : sc.plan;
  return (
    <>
      {scope}: <b className="num">{fmt(head.vcpu)}</b> vCPU / <b className="num">{fmt(head.vms)}</b> VMs {basis === 'risk' ? 'risk-adjusted' : 'full plan'}
      <div className="note" style={{ marginTop: 2 }}>
        {basis === 'risk' ? `Full plan ${fmt(sc.plan.vcpu)}` : `Risk-adjusted ${fmt(sc.risk.vcpu)}`} · committed {fmt(sc.committed.vcpu)} vCPU · today {fmt(today.vcpu)}
      </div>
    </>
  );
}


type Basis = 'risk' | 'plan';
type ViewPoint = TrendPoint & { basis: Basis; vmsRisk: number; vcpuRisk: number; memRisk: number; storRisk: number; altVms: number; altVcpu: number; altMem: number; altStor: number };

/** Map a trend point onto the selected basis: the headline fields become that scenario's values. */
function toView(p: TrendPoint, basis: Basis): ViewPoint {
  const risk = { vms: p.vms, vcpu: p.vcpu, memGB: p.memGB, storGB: p.storGB };
  if (basis === 'risk') return { ...p, basis, vmsRisk: p.vms, vcpuRisk: p.vcpu, memRisk: p.memGB, storRisk: p.storGB, altVms: p.vmsPlan, altVcpu: p.vcpuPlan, altMem: p.memPlan, altStor: p.storPlan };
  return {
    ...p, basis,
    vms: p.vmsPlan, vcpu: p.vcpuPlan, memGB: p.memPlan, storGB: p.storPlan,
    vmsPct: p.vmsPlanPct, vcpuPct: p.vcpuPlanPct, memPct: p.memPlanPct, storPct: p.storPlanPct,
    vmsRisk: risk.vms, vcpuRisk: risk.vcpu, memRisk: risk.memGB, storRisk: risk.storGB,
    altVms: risk.vms, altVcpu: risk.vcpu, altMem: risk.memGB, altStor: risk.storGB,
  };
}

/** GB shown as TB above 1,024 GB. */
function fmtTB(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toLocaleString('en-AU', { maximumFractionDigits: 1 })} TB` : `${fmt(gb)} GB`;
}

type MetricId = 'vms' | 'vcpu' | 'mem' | 'stor';
type NumKey = { [K in keyof ViewPoint]: ViewPoint[K] extends number ? K : never }[keyof ViewPoint];
const METRICS: { id: MetricId; label: string; cssVar: string; val: NumKey; pct: NumKey; plan: NumKey; commit: NumKey; risk: NumKey; alt: NumKey; format: (n: number) => string; tick: (n: number) => string; div: number }[] = [
  { id: 'vms', label: 'VMs', cssVar: '--line-vm', val: 'vms', pct: 'vmsPct', plan: 'vmsPlan', commit: 'vmsCommit', risk: 'vmsRisk', alt: 'altVms', format: fmt, tick: fmt, div: 1 },
  { id: 'vcpu', label: 'vCPU', cssVar: '--line-vcpu', val: 'vcpu', pct: 'vcpuPct', plan: 'vcpuPlan', commit: 'vcpuCommit', risk: 'vcpuRisk', alt: 'altVcpu', format: fmt, tick: fmt, div: 1 },
  { id: 'mem', label: 'vRAM', cssVar: '--line-mem', val: 'memGB', pct: 'memPct', plan: 'memPlan', commit: 'memCommit', risk: 'memRisk', alt: 'altMem', format: fmtTB, tick: (n) => `${fmt(n)} TB`, div: 1024 },
  { id: 'stor', label: 'Storage', cssVar: '--line-stor', val: 'storGB', pct: 'storPct', plan: 'storPlan', commit: 'storCommit', risk: 'storRisk', alt: 'altStor', format: fmtTB, tick: (n) => `${fmt(n)} TB`, div: 1024 },
];

function WhatStaysCard({ basis }: { basis: Basis }) {
  const { inventory, plans, settings } = useStore();
  const vms = scopeVMs(inventory.vms, settings, plans);
  const rows = useMemo(() => whatStays(vms, plans, settings, basis).filter((r) => (basis === 'risk' || r.id !== 'risk') && (r.id !== 'pinned' || Object.keys(settings.sovereignClusters ?? {}).length > 0)), [vms, plans, settings, basis]);
  const total = rows.reduce((a, r) => a + r.vcpu, 0);
  const totalVms = rows.reduce((a, r) => a + r.vms, 0);
  const max = Math.max(...rows.map((r) => r.vcpu), 1);
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>What stays on-prem at the end of {fyLabel(settings.horizonFY)}</h2>
          <p className="sub">Why the remaining <b className="num">{fmt(total)}</b> vCPU / <b className="num">{fmt(totalVms)}</b> VMs ({basis === 'risk' ? 'risk-adjusted' : 'full plan'}) is still on-prem – sizes the next hardware refresh and VMware renewal</p>
        </div>
      </div>
      <div className="meter" style={{ height: 10, marginTop: 0, marginBottom: 14 }} title="Share of remaining vCPU">
        {rows.map((r) => (r.vcpu > 0 ? <span key={r.id} style={{ width: `${(r.vcpu / (total || 1)) * 100}%`, background: r.color, opacity: r.muted ? 0.5 : 1 }} /> : null))}
      </div>
      <div className="bar-list">
        {rows.map((r) => (
          <div className="bar-row bar-row-wide" key={r.id} title={`${r.apps} apps · ${fmt(r.vms)} VMs`}>
            <div className="lbl"><i className="dot" style={{ background: r.color, opacity: r.muted ? 0.5 : 1 }} /><span>{r.label}</span></div>
            <div className="track"><div className="fill" style={{ width: `${(r.vcpu / max) * 100}%`, background: r.color, opacity: r.muted ? 0.5 : 1 }} /></div>
            <div className="val num">{fmt(r.vcpu)} vCPU · {total ? Math.round((r.vcpu / total) * 100) : 0}% · {r.apps} apps</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VmCountCard() {
  const { inventory, plans, settings } = useStore();
  const all = inventory.vms;
  const on = all.filter((v) => v.poweredOn).length;
  const virt = scopeVMs(all, settings).filter((v) => planFor(plans, v.appKey).disposition === 'virt_resource').length;
  const planned = scopeVMs(all, settings, plans).length;
  return (
    <div className="card kpi">
      <div className="k-label">VMs on-prem today</div>
      <div className="k-value num">{fmt(on)}<small>powered-on VMs</small></div>
      <div className="k-foot">{fmt(all.length)} total · {fmt(all.length - on)} powered off</div>
      <div className="k-foot">{fmt(planned)} in the plan{virt ? ` · ${fmt(virt)} virtualization resources excluded` : ''}</div>
    </div>
  );
}

function ResourcesCard({ vms }: { vms: { vcpu: number; memGB: number; storageProvGB: number; storageUsedGB: number; cpuAvgPct?: number; memAvgPct?: number }[] }) {
  const { inventory, plans } = useStore();
  let vcpu = 0, vcpuUsed = 0, mem = 0, memUsed = 0, sp = 0, su = 0, haveUse = 0;
  // Storage: every VM incl. powered-off (they still occupy disk); virtualization resources excluded.
  for (const v of inventory.vms) {
    if (planFor(plans, v.appKey).disposition === 'virt_resource') continue;
    sp += v.storageProvGB; su += v.storageUsedGB;
  }
  // vCPU / vRAM: VMs in the footprint (powered-on unless the setting includes powered-off).
  for (const v of vms) {
    vcpu += v.vcpu; mem += v.memGB;
    if (v.cpuAvgPct !== undefined || v.memAvgPct !== undefined) haveUse++;
    vcpuUsed += (v.vcpu * (v.cpuAvgPct ?? 0)) / 100;
    memUsed += (v.memGB * (v.memAvgPct ?? 0)) / 100;
  }
  const tb = (gb: number) => (gb >= 1024 ? `${(gb / 1024).toLocaleString('en-AU', { maximumFractionDigits: 1 })} TB` : `${fmt(gb)} GB`);
  const rows = [
    { k: 'vCPU', a: fmt(vcpu), u: fmt(vcpuUsed), pct: vcpu ? vcpuUsed / vcpu : 0, help: '24-hour average CPU usage % (RVTools) × vCPU assigned – powered-on VMs' },
    { k: 'vRAM', a: tb(mem), u: tb(memUsed), pct: mem ? memUsed / mem : 0, help: '24-hour average memory usage % (RVTools) × vRAM assigned – powered-on VMs' },
    { k: 'Storage', a: tb(sp), u: tb(su), pct: sp ? su / sp : 0, help: 'Storage Provisioned vs. Storage Used from RVTools – all VMs incl. powered-off' },
  ];
  return (
    <div className="card kpi kpi-wide">
      <div className="k-label">Resources assigned vs. used</div>
      <div className="res-rows">
        {rows.map((r) => (
          <div className="res-row" key={r.k} title={r.help}>
            <span className="res-k">{r.k}</span>
            <span className="res-v num"><b>{r.a}</b> assigned</span>
            <span className="res-bar"><span style={{ width: `${Math.min(100, r.pct * 100)}%` }} /></span>
            <span className="res-u num">{r.u} used · {Math.round(r.pct * 100)}%</span>
          </div>
        ))}
      </div>
      <div className="k-foot">{haveUse ? 'Used = 24-hour average utilisation % from the RVTools report × assigned (vCPU, vRAM; powered-on VMs). Storage used as reported, all VMs.' : 'Utilisation not available in this upload'}</div>
    </div>
  );
}

type MEntry = TimelineEntry;

function TreatmentMatrix() {
  const { inventory, plans, settings } = useStore();
  const [open, setOpen] = useState<Set<string>>(new Set());

  const model = useMemo(() => buildTimeline(inventory.vms, plans, settings), [inventory, plans, settings]);
  const cols = model.cols;

  const sum = (es: MEntry[]) => es.reduce((x, e) => x + e.vms, 0);
  const List = ({ id, es, max = 8, showQ = true }: { id: string; es: MEntry[]; max?: number; showQ?: boolean }) => {
    const sorted = [...es].sort((a, b) => b.vms - a.vms || a.name.localeCompare(b.name));
    const isOpen = open.has(id);
    const shown = isOpen ? sorted : sorted.slice(0, max);
    if (!es.length) return <span className="muted">–</span>;
    return (
      <>
        <ul className="mx-list">
          {shown.map((e) => {
            const c = CONFIDENCE.find((x) => x.id === e.conf);
            return (
              <li key={e.key} title={`${e.name} – ${e.vms} VMs, ${fmt(e.vcpu)} vCPU${c ? ` · ${c.label} confidence` : ''}`}>
                {showQ && e.q ? <span className="mx-q">Q{e.q}</span> : null}
                <span className="mx-name">{e.name} – {e.vms} VM{e.vms === 1 ? '' : 's'}</span>
                {showQ && <i className="dot mx-conf" style={c ? { background: c.color } : { border: '1px dashed var(--border-strong)' }} />}
              </li>
            );
          })}
        </ul>
        {sorted.length > max && (
          <button className="btn btn-sm mx-more" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}>
            {isOpen ? 'Show fewer' : `+ ${sorted.length - max} more (${sum(sorted.slice(max))} VMs)`}
          </button>
        )}
        <div className="mx-total">TOTAL = {fmt(sum(es))} VMs · {fmt(es.reduce((x, e) => x + e.vcpu, 0))} vCPU</div>
      </>
    );
  };

  const moveRows = DISPOSITIONS.filter((d) => d.leavesOnPrem);
  const stayRows = DISPOSITIONS.filter((d) => d.group === 'Retain');
  const colTotals = cols.map((_, i) => moveRows.reduce((x, d) => x + sum(model.move[d.id][i]), 0));

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Treatment timeline by financial year</h2>
          <p className="sub">Applications by treatment and the FY they leave on-prem (Q = target quarter, dot = confidence). VM counts exclude VMs pinned by data sovereignty, which are listed under Sovereignty-bound.</p>
        </div>
        <a className="btn btn-sm" href="#/planner">Open planner</a>
      </div>
      <div className="table-wrap" style={{ borderTop: 0 }}>
        <table className="mx">
          <thead>
            <tr><th className="mx-rowh">Treatment</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {moveRows.map((d) => (
              <tr key={d.id}>
                <th className="mx-rowh" style={{ borderLeftColor: d.color }}>{d.label}<div className="mx-rowsum">{fmt(model.move[d.id].reduce((x, es) => x + sum(es), 0))} VMs</div></th>
                {model.move[d.id].map((es, i) => <td key={i}><List id={`${d.id}:${i}`} es={es} /></td>)}
              </tr>
            ))}
            <tr className="mx-foot">
              <th className="mx-rowh">Leaving on-prem</th>
              {colTotals.map((t, i) => <td key={i}><b className="num">{fmt(t)}</b> VMs</td>)}
            </tr>
            {stayRows.map((d) => (
              <tr key={d.id}>
                <th className="mx-rowh" style={{ borderLeftColor: d.color }}>{d.id === 'retain_latency' ? 'Latency-bound' : d.id === 'retain_sovereignty' ? 'Sovereignty-bound' : 'Stay – Maintain'}<div className="mx-rowsum">stays on-prem</div></th>
                <td colSpan={cols.length}><div className="mx-span"><List id={d.id} es={model.stay[d.id] ?? []} max={12} showQ={false} /></div></td>
              </tr>
            ))}
            {model.virt.length > 0 && (
              <tr className="mx-excluded">
                <th className="mx-rowh">Virtualization resources<div className="mx-rowsum">excluded from the footprint</div></th>
                <td colSpan={cols.length}><div className="mx-span"><List id="virt" es={model.virt} max={12} showQ={false} /></div></td>
              </tr>
            )}
            <tr>
              <th className="mx-rowh" style={{ borderLeftColor: 'var(--s-tbd)' }}>Not yet decided</th>
              <td colSpan={cols.length}><div className="mx-span"><List id="tbd" es={model.undecided} max={10} showQ={false} /></div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Lay the page out at A4-landscape width, let the charts re-measure, then open the print dialog. */
export function printSummary() {
  const html = document.documentElement;
  const prevTheme = html.getAttribute('data-theme');
  html.setAttribute('data-theme', 'light');
  html.classList.add('printing');
  const done = () => {
    html.classList.remove('printing');
    if (prevTheme) html.setAttribute('data-theme', prevTheme);
    else html.removeAttribute('data-theme');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 900);
}


function Badge({ cx, cy, n, fill, title, surface }: { cx: number; cy: number; n: number; fill: string; title: string; surface: string }) {
  return (
    <g style={{ cursor: 'default' }}>
      <title>{`${n}. ${title}`}</title>
      <circle cx={cx} cy={cy} r={9} fill={fill} stroke={surface} strokeWidth={2} />
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={10.5} fontWeight={700}>{n}</text>
    </g>
  );
}

function LineBadge(props: { viewBox?: { x?: number; y?: number }; n: number; fill: string; title: string; surface: string }) {
  const x = props.viewBox?.x ?? 0;
  const y = (props.viewBox?.y ?? 0) - 12;
  return <Badge cx={x} cy={y} n={props.n} fill={props.fill} title={props.title} surface={props.surface} />;
}
