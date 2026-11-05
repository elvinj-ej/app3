import { useEffect, useState } from 'react';
import { useStore } from './lib/store';
import { fyLabel } from './lib/fy';
import Executive from './pages/Executive';
import Planner from './pages/Planner';
import DataSettings from './pages/DataSettings';

type Route = 'summary' | 'planner' | 'data';
const ROUTES: { id: Route; label: string }[] = [
  { id: 'summary', label: 'Executive Summary' },
  { id: 'planner', label: 'Application Planner' },
  { id: 'data', label: 'Data & Settings' },
];

function readRoute(): Route {
  const h = location.hash.replace('#/', '') as Route;
  return ROUTES.some((r) => r.id === h) ? h : 'summary';
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const { inventory, settings } = useStore();
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('fp.theme') ?? 'auto';
    } catch {
      return 'auto';
    }
  });

  useEffect(() => {
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

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▤</span>
          On-Prem Footprint
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button key={r.id} aria-current={route === r.id ? 'page' : undefined} onClick={() => go(r.id)}>
              {r.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span>
            {inventory.isDemo ? 'Demo data' : inventory.sourceFile} · Current {fyLabel(settings.currentFY)}
          </span>
          <select className="select select-sm" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
            <option value="auto">Auto theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>
      {inventory.isDemo && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="banner" style={{ marginBottom: 0 }}>
            <b>Showing synthetic demo data.</b> Load your VMInfo Excel export on the Data &amp; Settings page – it is parsed
            in your browser and never leaves this machine.
            <button className="btn btn-sm" onClick={() => go('data')}>Load Excel</button>
          </div>
        </div>
      )}
      {route === 'summary' && <Executive onPlan={() => go('planner')} />}
      {route === 'planner' && <Planner />}
      {route === 'data' && <DataSettings />}
    </>
  );
}
