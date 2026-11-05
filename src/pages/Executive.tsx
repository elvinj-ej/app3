import { useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useStore, vendorOf } from '../lib/store';
import { DISP, DISPOSITIONS } from '../lib/dispositions';
import { daysUntil, fmtDate, fyEnd, fyLabel, fyOf, fyQuarterOf, humanCountdown, parseISODate, quarterLabel, quarterRange } from '../lib/fy';
import { byDisposition, exitDate, exitsBy, footprintScenarios, groupApps, planFor, scopeVMs, totals, trend, type Granularity, type Scenarios, type TrendPoint } from '../lib/projection';
import { CONFIDENCE, VENDOR_LABEL, deadlineVendor } from '../lib/defaults';
import { parseApp } from '../lib/parse';
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

  const vms = useMemo(() => scopeVMs(inventory.vms, settings), [inventory, settings]);
  const base = useMemo(() => totals(vms), [vms]);
  const points = useMemo<ViewPoint[]>(() => trend(vms, plans, settings, gran).map((p) => toView(p, basis)), [vms, plans, settings, gran, basis]);
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
      if (!exitDate(p)) continue;
      total += v.vcpu;
      if (p.confidence) by[p.confidence] += v.vcpu;
      else unrated.add(v.appKey);
    }
    return { by, total, unratedApps: unrated.size };
  }, [vms, plans]);

  const deadlines = [...settings.deadlines].sort((a, b) => a.date.localeCompare(b.date));
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
  const xTick = gran === 'quarter' ? { tick: <QuarterTick fill={color('--text-2')} />, interval: 0, height: 40 } : {};
  const dotR = gran === 'quarter' ? 3 : 4;

  const refs = (fill: string, showLabel = true) =>
    refLines.map(([fy, ds]) => (
      <ReferenceLine
        key={fy}
        x={fy}
        stroke={color('--text-3')}
        strokeDasharray="4 4"
        label={showLabel ? { value: ds.map((d) => d.kind).join(' · '), position: 'top', fill, fontSize: 11, offset: 8 } : undefined}
      />
    ));

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
      <div className="grid g-kpi" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <div className="k-label">VMs on-prem today</div>
          <div className="k-value num">{fmt(base.vms)}</div>
          <div className="k-foot">{fmt(base.memGB / 1024)} TB vRAM assigned</div>
        </div>
        <div className="card kpi">
          <div className="k-label">vCPU on-prem today</div>
          <div className="k-value num">{fmt(base.vcpu)}</div>
          <div className="k-foot">Primary licensing driver</div>
        </div>
        <div className="card kpi">
          <div className="k-label">Projected at end of {fyLabel(settings.horizonFY)} · {bLabel}</div>
          <div className="k-value num">
            {fmt(endPt.vcpu)}<small>vCPU</small>
          </div>
          <div className="k-foot">
            {fmt(endPt.vms)} VMs ·{' '}
            <span className="delta-down">−{fmt(100 - endPt.vcpuPct)}% vCPU</span>
          </div>
          <div className="k-foot" title="Full plan = every scheduled move happens on its target quarter. Committed = only High-confidence moves happen.">
            {isRisk ? `Full plan ${fmt(endPt.vcpuPlan)}` : `Risk-adjusted ${fmt(endPt.vcpuRisk)}`} · committed {fmt(endPt.vcpuCommit)}
          </div>
        </div>
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
                  ? `${isRisk ? 'Risk-adjusted' : 'Full-plan'} VMs and vCPU remaining at the end of each ${gran === 'quarter' ? 'FY quarter' : 'FY'}, indexed to today = 100%. Hover for the other scenarios.`
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
            {mode === 'absolute' && <span><i className="dot" style={{ background: 'var(--line-vm)', opacity: 0.18, width: 16 }} /> Range: committed ↔ full plan</span>}
            {mode === 'absolute' && <span><i className="ln" style={{ background: 'none', borderTop: '2px dashed var(--text-3)' }} /> {isRisk ? 'Full plan' : 'Risk-adjusted'}</span>}
            {refLines.length > 0 && <span><i className="dl" /> Deadline ({gran === 'quarter' ? 'quarter' : 'FY'} it falls in)</span>}
          </div>
          {mode === 'indexed' ? (
            <ResponsiveContainer width="100%" height={330}>
              <LineChart data={points} margin={{ top: 28, right: 96, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={color('--grid')} />
                <XAxis dataKey="label" {...axisProps} {...xTick} />
                <YAxis domain={[0, 100]} unit="%" {...axisProps} axisLine={false} width={48} />
                <Tooltip content={<TrendTip />} cursor={{ stroke: color('--border-strong') }} />
                {refs(color('--text-2'))}
                <Line animationDuration={500} type="linear" dataKey="vmsPct" name="VMs" stroke={color('--line-vm')} strokeWidth={2}
                  dot={{ r: dotR, strokeWidth: 2, stroke: color('--surface'), fill: color('--line-vm') }} activeDot={{ r: 6, strokeWidth: 2, stroke: color('--surface') }}
                  label={<EndLabel n={points.length} field="vms" text="VMs" color={color('--text-2')} points={points} dy={-8} />} />
                <Line animationDuration={500} type="linear" dataKey="vcpuPct" name="vCPU" stroke={color('--line-vcpu')} strokeWidth={2}
                  dot={{ r: dotR, strokeWidth: 2, stroke: color('--surface'), fill: color('--line-vcpu') }} activeDot={{ r: 6, strokeWidth: 2, stroke: color('--surface') }}
                  label={<EndLabel n={points.length} field="vcpu" text="vCPU" color={color('--text-2')} points={points} dy={14} />} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {(['vms', 'vcpu'] as const).map((f) => (
                <div key={f}>
                  <div className="note" style={{ fontWeight: 600, color: 'var(--text-2)' }}>{f === 'vms' ? 'VMs' : 'vCPU'}</div>
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={points.map((p) => ({ ...p, band: f === 'vms' ? [p.vmsPlan, p.vmsCommit] : [p.vcpuPlan, p.vcpuCommit] }))} margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke={color('--grid')} />
                      <XAxis dataKey="label" {...axisProps} {...xTick} />
                      <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={(v) => fmt(v)} domain={[0, 'auto']} />
                      <Tooltip content={<TrendTip />} cursor={{ stroke: color('--border-strong') }} />
                      {refs(color('--text-2'), false)}
                      <Area animationDuration={500} type="linear" dataKey="band" stroke="none" fill={color(f === 'vms' ? '--line-vm' : '--line-vcpu')} fillOpacity={0.16} activeDot={false} />
                      <Line animationDuration={500} type="linear" dataKey={f === 'vms' ? 'altVms' : 'altVcpu'} stroke={color('--text-3')} strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />
                      <Line animationDuration={500} type="linear" dataKey={f} stroke={color(f === 'vms' ? '--line-vm' : '--line-vcpu')} strokeWidth={2}
                        dot={{ r: dotR, strokeWidth: 2, stroke: color('--surface'), fill: color(f === 'vms' ? '--line-vm' : '--line-vcpu') }} activeDot={{ r: 6 }} />
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
                <tr><th>Point</th><th className="r">VMs ({bLabel})</th><th className="r">% of today</th><th className="r">vCPU ({bLabel})</th><th className="r">% of today</th><th className="r">vCPU risk-adjusted</th><th className="r">vCPU full plan</th><th className="r">vCPU committed</th></tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.label}>
                    <td>{p.label === 'Now' ? 'Today' : `End of ${p.label}`}</td>
                    <td className="r num">{fmt(p.vms)}</td><td className="r num">{p.vmsPct}%</td>
                    <td className="r num">{fmt(p.vcpu)}</td><td className="r num">{p.vcpuPct}%</td>
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
                  {d.label}
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
            {DISPOSITIONS.map((d) => {
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

      <UpcomingMoves />

      <div className="grid g-2">
        <DomainTable basis={basis} />
        <HardwareTable />
      </div>
    </div>
  );
}

function EndLabel(props: { x?: number; y?: number; index?: number; n: number; text: string; color: string; points: { vms: number; vcpu: number }[]; field: 'vms' | 'vcpu'; dy: number }) {
  const { x, y, index, n, text, color, points, field, dy } = props;
  if (index !== n - 1 || x === undefined || y === undefined) return null;
  return (
    <text x={x + 10} y={y + dy / 2} fill={color} fontSize={12} dominantBaseline="middle">
      {text} {fmt(points[index][field])}
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
  const vms = scopeVMs(inventory.vms, settings);
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

function UpcomingMoves() {
  const { inventory, plans, settings } = useStore();
  const vms = scopeVMs(inventory.vms, settings);
  const rows = useMemo(() => {
    return groupApps(vms)
      .map((a) => ({ a, p: planFor(plans, a.key) }))
      .filter(({ p }) => DISP[p.disposition].leavesOnPrem && p.targetFY)
      .sort((x, y) => x.p.targetFY! * 10 + (x.p.targetQ ?? 4) - (y.p.targetFY! * 10 + (y.p.targetQ ?? 4)) || y.a.vcpu - x.a.vcpu);
  }, [vms, plans]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div><h2>Treatment timeline</h2><p className="sub">Scheduled applications in the order they leave on-prem ({rows.length} scheduled)</p></div>
        <a className="btn btn-sm" href="#/planner">Open planner</a>
      </div>
      {rows.length === 0 ? <div className="note">No applications scheduled yet.</div> : (
        <div className="table-wrap" style={{ borderTop: 0 }}>
          <table className="t">
            <thead><tr><th>Quarter</th><th>Application</th><th>Domain</th><th>Treatment</th><th>Confidence</th><th className="r">VMs</th><th className="r">vCPU</th><th>Notes</th></tr></thead>
            <tbody>
              {shown.map(({ a, p }) => (
                <tr key={a.key}>
                  <td style={{ whiteSpace: 'nowrap' }}><b>{quarterLabel(p.targetFY!, p.targetQ ?? 4)}</b> <span className="muted">· {quarterRange(p.targetFY!, p.targetQ ?? 4)}</span></td>
                  <td><span className="app-name">{a.name}</span></td>
                  <td>{a.domain}</td>
                  <td><span className="chip"><i className="dot" style={{ background: DISP[p.disposition].color }} />{DISP[p.disposition].short}</span></td>
                  <td><ConfChip c={p.confidence} /></td>
                  <td className="r num">{a.vmCount}</td>
                  <td className="r num">{fmt(a.vcpu)}</td>
                  <td className="muted">{p.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 && <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
        </div>
      )}
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

function ConfChip({ c }: { c?: string }) {
  const m = CONFIDENCE.find((x) => x.id === c);
  if (!m) return <span className="chip" style={{ borderStyle: 'dashed' }}>Not rated</span>;
  return <span className="chip"><i className="dot" style={{ background: m.color }} />{m.label}</span>;
}

type Basis = 'risk' | 'plan';
type ViewPoint = TrendPoint & { basis: Basis; vmsRisk: number; vcpuRisk: number; altVms: number; altVcpu: number };

/** Map a trend point onto the selected basis: vms/vcpu/pct become the headline series. */
function toView(p: TrendPoint, basis: Basis): ViewPoint {
  const risk = { vms: p.vms, vcpu: p.vcpu, vmsPct: p.vmsPct, vcpuPct: p.vcpuPct };
  if (basis === 'risk') return { ...p, basis, vmsRisk: p.vms, vcpuRisk: p.vcpu, altVms: p.vmsPlan, altVcpu: p.vcpuPlan };
  return { ...p, basis, vms: p.vmsPlan, vcpu: p.vcpuPlan, vmsPct: p.vmsPlanPct, vcpuPct: p.vcpuPlanPct, vmsRisk: risk.vms, vcpuRisk: risk.vcpu, altVms: risk.vms, altVcpu: risk.vcpu };
}
