import { DISP } from '../lib/dispositions';
import { quarterLabel, quarterRange } from '../lib/fy';
import type { AppPlan, HistoryEntry } from '../lib/types';
import { CONFIDENCE } from '../lib/defaults';

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function targetText(p: Partial<AppPlan> | null | undefined): string {
  if (!p?.targetFY) return '';
  const q = p.targetQ ?? 4;
  return `${quarterLabel(p.targetFY, q)} (${quarterRange(p.targetFY, q)})`;
}

export function PlanChip({ p }: { p: Partial<AppPlan> | null | undefined }) {
  if (!p) return <span className="muted">—</span>;
  const m = p.disposition ? DISP[p.disposition] : null;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {m && <span className="chip"><i className="dot" style={{ background: m.color }} />{m.short}</span>}
      {p.targetFY ? <span className="chip">{quarterLabel(p.targetFY, p.targetQ ?? 4)}</span> : null}
      {p.confidence ? <span className="chip"><i className="dot" style={{ background: CONFIDENCE.find((c) => c.id === p.confidence)?.color }} />{CONFIDENCE.find((c) => c.id === p.confidence)?.label} confidence</span> : null}
      {p.notes ? <span className="muted" style={{ fontSize: 12 }}>“{p.notes}”</span> : null}
    </span>
  );
}

const ACTION_LABEL: Record<HistoryEntry['action'], string> = { update: 'Edited', bulk: 'Bulk edit', rename: 'Re-linked', import: 'Imported' };

export function HistoryRow({ h, showApp }: { h: HistoryEntry; showApp?: boolean }) {
  return (
    <div className="hist-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span><b>{h.changedBy}</b> <span className="muted">· {ACTION_LABEL[h.action] ?? h.action}</span></span>
        <span className="muted" title={fmtDateTime(h.changedAt)}>{fmtDateTime(h.changedAt)}</span>
      </div>
      {showApp && <div className="app-name" style={{ marginTop: 2 }}>{h.appKey}</div>}
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
        {h.action === 'rename' ? <span className="muted">{h.before?.notes}</span> : <PlanChip p={h.before} />}
        <span className="arrow">→</span>
        <PlanChip p={h.after} />
      </div>
    </div>
  );
}
