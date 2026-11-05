import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { HistoryRow } from '../components/common';
import type { HistoryEntry } from '../lib/types';

export default function Activity() {
  const { rev } = useStore();
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');

  useEffect(() => {
    api<HistoryEntry[]>('/history?limit=1000').then(setItems).catch(() => setItems([]));
  }, [rev]);

  const people = useMemo(() => [...new Set((items ?? []).map((h) => h.changedBy))].sort(), [items]);
  const shown = (items ?? []).filter((h) => (!who || h.changedBy === who) && (!q || h.appKey.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>Every change to an application's treatment: who made it, when, and what it was before.</p>
        </div>
        <a className="btn" href="api/export/treatment-plan.xlsx">Export to Excel (with charts)</a>
      </div>
      <div className="card card-pad">
        <div className="filters" style={{ marginBottom: 12 }}>
          <input className="input" placeholder="Filter by application…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p}>{p}</option>)}
          </select>
          <span className="note" style={{ marginLeft: 'auto' }}>{shown.length} changes</span>
        </div>
        {items === null ? <div className="empty">Loading…</div> : shown.length === 0 ? <div className="empty">No changes recorded yet.</div> : shown.map((h) => <HistoryRow key={h.id} h={h} showApp />)}
      </div>
    </div>
  );
}
