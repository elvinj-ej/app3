import { useEffect, useState } from 'react';
import { useStore } from './lib/store';
import { fyLabel } from './lib/fy';
import { APP_NAME } from './lib/brand';
import Executive from './pages/Executive';
import Planner from './pages/Planner';
import InventoryPage from './pages/InventoryPage';
import Activity from './pages/Activity';
import SettingsPage from './pages/SettingsPage';

type Route = 'summary' | 'planner' | 'inventory' | 'activity' | 'settings';
const ROUTES: { id: Route; label: string }[] = [
  { id: 'summary', label: 'Executive Summary' },
  { id: 'planner', label: 'Application Planner' },
  { id: 'inventory', label: 'Inventory Updates' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

function readRoute(): Route {
  const h = location.hash.replace('#/', '') as Route;
  return ROUTES.some((r) => r.id === h) ? h : 'summary';
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const { ready, connError, user, setUser, hasInventory, latestUpload, settings, toasts } = useStore();
  const [editingName, setEditingName] = useState(false);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('fp.theme') ?? 'auto';
    } catch {
      return 'auto';
    }
  });

  useEffect(() => {
    document.title = APP_NAME;
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('fp.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const go = (r: Route) => {
    location.hash = `#/${r}`;
    window.scrollTo(0, 0);
  };
  const needsInventory = route === 'summary' || route === 'planner';

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▤</span>
          {APP_NAME}
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button key={r.id} aria-current={route === r.id ? 'page' : undefined} onClick={() => go(r.id)}>
              {r.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span title={latestUpload ? `Upload #${latestUpload.id} by ${latestUpload.uploadedBy}` : ''}>
            {latestUpload ? latestUpload.filename : 'No inventory'} · {fyLabel(settings.currentFY)}
          </span>
          <button className="btn btn-sm" onClick={() => setEditingName(true)} title="Your name is recorded against changes you make">
            👤 {user || 'Set name'}
          </button>
          <select className="select select-sm" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
            <option value="auto">Auto theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>

      {connError && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="banner" style={{ marginBottom: 0, color: 'var(--crit)' }}>
            Cannot reach the server ({connError}). Changes will not be saved until the connection is back.
          </div>
        </div>
      )}

      {!ready && !connError && <div className="page"><div className="empty">Loading…</div></div>}

      {ready && needsInventory && !hasInventory && (
        <div className="page">
          <div className="card card-pad empty">
            <h2 style={{ marginBottom: 8 }}>No inventory loaded yet</h2>
            <p>Upload the latest VMInfo Excel export to get started. Treatment decisions are stored separately and carry over to every future upload.</p>
            <button className="btn btn-primary" onClick={() => go('inventory')}>Upload VMInfo file</button>
          </div>
        </div>
      )}

      {ready && route === 'summary' && hasInventory && <Executive onPlan={() => go('planner')} />}
      {ready && route === 'planner' && hasInventory && <Planner />}
      {ready && route === 'inventory' && <InventoryPage />}
      {ready && route === 'activity' && <Activity />}
      {ready && route === 'settings' && <SettingsPage />}

      {(ready && (!user || editingName)) && (
        <NameDialog initial={user} onSave={(n) => { setUser(n); setEditingName(false); }} onCancel={user ? () => setEditingName(false) : undefined} />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'error' ? ' toast-err' : ''}`}>{t.text}</div>
        ))}
      </div>
    </>
  );
}

function NameDialog({ initial, onSave, onCancel }: { initial: string; onSave: (n: string) => void; onCancel?: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="modal-back">
      <form className="card card-pad modal" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSave(v); }}>
        <h2>Who's making changes?</h2>
        <p className="sub" style={{ margin: '6px 0 14px' }}>Your name is recorded against every decision and upload so the team can see who changed what.</p>
        <input className="input" style={{ width: '100%' }} autoFocus placeholder="e.g. Jane Smith" value={v} onChange={(e) => setV(e.target.value)} maxLength={80} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
          <button className="btn btn-primary" disabled={!v.trim()}>Continue</button>
        </div>
      </form>
    </div>
  );
}
