import type { AppInfo, Cluster, Inventory, VM } from './types.ts';

export const NO_APP = '(No application recorded)';

const appCache = new Map<string, AppInfo>();
let domainOverrides: Record<string, string> = {};

/** Per-application domain corrections (Settings) – applied on top of the domain parsed from Application_Primary. */
export function setDomainOverrides(m: Record<string, string> | undefined) {
  const next = m ?? {};
  if (JSON.stringify(next) === JSON.stringify(domainOverrides)) return;
  domainOverrides = { ...next };
  appCache.clear();
}

/** The domain as written in Application_Primary, ignoring overrides. */
export function parsedDomain(key: string): string {
  const o = domainOverrides;
  domainOverrides = {};
  appCache.delete(key);
  const d = parseApp(key).domain;
  appCache.delete(key);
  domainOverrides = o;
  return d;
}
const TIER_RE = /^(tier\s*(?:\d+|x|n\/a|unknown|legacy))(?![a-z0-9])/i;

/**
 * Application_Primary follows "<Name> - <Tier> - <Domain> (<Service>)", e.g.
 *   "Windchill (CSV) - Tier1 - SCC (Product Lifecycle Management)"
 * but some rows omit parts or use en-dashes, so parse defensively.
 */
export function parseApp(key: string): AppInfo {
  const cached = appCache.get(key);
  if (cached) return cached;
  let info: AppInfo;
  if (!key || key === NO_APP) {
    info = { key, name: NO_APP, tier: 'Unknown', domain: 'Unclassified', service: '' };
  } else {
    const parts = key.replace(/\s*[–—]\s*/g, ' - ').split(/\s+-\s+/).map((s) => s.trim());
    const tierIdx = parts.findIndex((p) => TIER_RE.test(p));
    if (tierIdx < 0) {
      info = { key, name: key, tier: 'Unknown', domain: 'Unclassified', service: '' };
    } else {
      const name = parts.slice(0, tierIdx).join(' - ') || key;
      const tierSeg = parts[tierIdx];
      const tierMatch = tierSeg.match(TIER_RE);
      let tier = tierMatch ? tierMatch[1].replace(/\s+/g, ' ') : tierSeg;
      tier = normaliseTier(tier);
      const rest = [tierSeg.slice(tierMatch ? tierMatch[1].length : tierSeg.length), ...parts.slice(tierIdx + 1)]
        .join(' - ')
        .replace(/^\s*-?\s*/, '');
      const svcMatch = rest.match(/\(([^()]*)\)\s*$/);
      const service = svcMatch ? svcMatch[1].trim() : '';
      const domainRaw = (svcMatch ? rest.slice(0, svcMatch.index) : rest).trim();
      info = { key, name, tier, domain: domainRaw || 'Unclassified', service };
    }
  }
  if (domainOverrides[key]) info = { ...info, domain: domainOverrides[key] };
  appCache.set(key, info);
  return info;
}

function normaliseTier(t: string): string {
  const m = t.match(/^tier\s*(.*)$/i);
  if (!m) return t;
  const v = m[1].trim();
  if (/^\d+$/.test(v)) return `Tier ${v}`;
  if (/^x$/i.test(v)) return 'Tier X';
  if (/^(unknown|n\/a)$/i.test(v)) return 'Unknown';
  return `Tier ${v.charAt(0).toUpperCase()}${v.slice(1).toLowerCase()}`;
}

export const TIER_ORDER = ['Tier 0', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier X', 'Tier Legacy', 'Unknown'];

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(str(v));
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | undefined {
  const s = str(v);
  if (s === '') return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function siteOf(vcenter: string): string {
  const m = vcenter.match(/^([a-z]{3})-/i);
  return m ? m[1].toUpperCase() : vcenter || 'Unknown';
}

type Row = unknown[];
interface SheetData {
  sheet: string;
  data: Row[];
}

function indexer(header: Row) {
  const map = new Map<string, number>();
  header.forEach((h, i) => map.set(str(h).toLowerCase(), i));
  return (row: Row, ...names: string[]) => {
    for (const n of names) {
      const i = map.get(n.toLowerCase());
      if (i !== undefined) return row[i];
    }
    return undefined;
  };
}

export function inventoryFromSheets(sheets: SheetData[], sourceFile: string): Inventory {
  const vmSheet =
    sheets.find((s) => s.sheet.toLowerCase() === 'vms') ??
    sheets.find((s) => s.data[0]?.some((h) => str(h).toLowerCase() === 'vmname'));
  if (!vmSheet || vmSheet.data.length < 2) {
    throw new Error('Could not find a "VMs" sheet with a VMName column in this workbook.');
  }
  const header = vmSheet.data[0];
  if (!header.some((h) => str(h) === 'Application_Primary')) {
    throw new Error('The VMs sheet has no "Application_Primary" column.');
  }
  const get = indexer(header);
  const vms: VM[] = [];
  for (const row of vmSheet.data.slice(1)) {
    const name = str(get(row, 'VMName'));
    if (!name) continue;
    const vcenter = str(get(row, 'VCenter'));
    vms.push({
      name,
      poweredOn: str(get(row, 'PowerState')).toLowerCase() !== 'poweredoff',
      os: str(get(row, 'GuestOSDetected')),
      vcenter,
      site: siteOf(vcenter),
      location: str(get(row, 'VMLocation')) || 'Unknown',
      environment: str(get(row, 'Environment')) || 'Unspecified',
      appKey: str(get(row, 'Application_Primary')) || NO_APP,
      appDetailed: str(get(row, 'Application_Detailed')),
      owner: str(get(row, 'Application_Owner')),
      support: str(get(row, 'Application_Support')),
      vcpu: num(get(row, 'vCPU Assigned')),
      memGB: num(get(row, 'Memory Assigned (GB)')),
      storageProvGB: num(get(row, 'Storage Provisioned (GB)')),
      storageUsedGB: num(get(row, 'Storage Used (GB)')),
      createdDate: str(get(row, 'Creation Date')) || undefined,
      buildUser: (str(get(row, 'Notes')).match(/Build User:\s*([^\n\r]+)/i)?.[1] ?? '').trim() || undefined,
      cpuAvgPct: optNum(get(row, 'CPU Usage Average %')),
      memAvgPct: optNum(get(row, 'MEM Usage Average %')),
    });
  }

  const clusters: Cluster[] = [];
  const cs = sheets.find((s) => s.sheet.toLowerCase() === 'clusters');
  if (cs && cs.data.length > 1) {
    const g = indexer(cs.data[0]);
    for (const row of cs.data.slice(1)) {
      const name = str(g(row, 'Cluster'));
      if (!name) continue;
      clusters.push({
        name,
        classification: str(g(row, 'Cluster Classification')),
        vcenter: str(g(row, 'VCenter')),
        hosts: num(g(row, 'Number of ESXi')),
        sockets: num(g(row, 'Physical CPU Sockets')),
        cores: num(g(row, 'Physical Cores')),
        memGiB: num(g(row, 'Physical Memory (GiB)')),
        runningVMs: num(g(row, 'Running VMs')),
        runningVcpu: num(g(row, 'Running vCPU Assigned')),
      });
    }
  }

  return { sourceFile, loadedAt: new Date().toISOString(), isDemo: false, vms, clusters };
}
