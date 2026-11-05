import type { Cluster, Inventory, VM } from './types';

// Synthetic sample data so the app is explorable before a real VMInfo export is loaded.
// Nothing here is real inventory.

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const APPS: [string, string, string, string, number][] = [
  // name, tier, domain, service, vm count
  ['File Server', 'Tier0', 'ISD', 'Storage Services', 18],
  ['Database_SQL Server', 'Tier0', 'ISD', 'Database services', 14],
  ['Active Directory', 'Tier0', 'ISD', 'Directory Services', 8],
  ['Endpoint Management', 'Tier0', 'ISD', 'End Point Management', 9],
  ['Load Balancer', 'Tier0', 'ISD', 'Load balancer Services', 6],
  ['Print Services', 'Tier0', 'ISD', 'Print Services', 6],
  ['Backup', 'Tier0', 'ISD', 'Backup Services', 5],
  ['Remote Desktop', 'Tier0', 'ISD', 'RDS service', 7],
  ['PLM Platform', 'Tier1', 'SCC', 'Product Lifecycle Management', 8],
  ['MES', 'Tier1', 'SCC', 'Manufacturing Execution System', 7],
  ['ERP', 'Tier1', 'SCC', 'ERP', 5],
  ['CRM Connector', 'Tier1', 'SCC', 'Customer Relationship Management', 3],
  ['Quality Mgmt', 'Tier2', 'SCC', 'Quality & Complaint Management', 4],
  ['Label Printing', 'Tier2', 'SCC', 'Manu/Supply Label printing', 4],
  ['Service Portal', 'Tier2', 'ISD', 'IT Service Mgmt.', 5],
  ['Source Control', 'Tier3', 'SCC', 'Source Code Management', 4],
  ['BI Reporting', 'Tier1', 'SCC', 'BI reporting', 3],
  ['Data Quality', 'Tier3', 'Data', 'Data Quality Analytics', 2],
  ['Build Agents', 'TierX', 'R&D', 'Build agent', 6],
  ['Clinical Connectivity', 'Tier1', 'R&D', 'Clinical Connectivity Services', 3],
  ['Test Rigs', 'TierX', 'R&D', 'Test automation', 5],
  ['CCTV', 'TierX', 'Facility', 'CCTV Services', 3],
  ['Visitor Registration', 'TierX', 'Facility', 'Visitors registration Services', 3],
  ['Password Vault', 'Tier0', 'Security', 'Password Access Mgmt.', 3],
  ['Asset Management', 'Tier3', 'ISD', 'Asset Management Services', 3],
];

const SITES = [
  { vc: 'aum-vcsa-demo', loc: ['MacPark-Windows', 'MacPark-Linux', 'AUB-HX-PRD01'] },
  { vc: 'aus-vcsa-demo', loc: ['Equinix-Windows', 'Equinix-Linux'] },
  { vc: 'bem-vcsa-demo', loc: ['BEM-HX-PRD01', 'SEG-HX-PRD01'] },
  { vc: 'usd-vcsa-demo', loc: ['USD-HX-PRD01'] },
];
const ENVS = ['Prod', 'Prod', 'Prod', 'Prod', 'Test', 'Dev', 'UAT'];
const OS = ['Microsoft Windows Server 2019 (64-bit)', 'Microsoft Windows Server 2022 (64-bit)', 'Red Hat Enterprise Linux 9 (64-bit)', 'Ubuntu Linux (64-bit)'];
const CPU = [2, 2, 2, 4, 4, 4, 8, 8, 16];

export function makeDemoInventory(): Inventory {
  const r = rng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const vms: VM[] = [];
  APPS.forEach(([name, tier, domain, service, count], ai) => {
    const site = SITES[ai % SITES.length];
    for (let i = 0; i < count; i++) {
      const s = r() < 0.75 ? site : pick(SITES);
      const vcpu = pick(CPU);
      vms.push({
        name: `demo-${name.toLowerCase().replace(/[^a-z]+/g, '')}-${String(i + 1).padStart(2, '0')}`,
        poweredOn: r() > 0.08,
        os: pick(OS),
        vcenter: s.vc,
        site: s.vc.slice(0, 3).toUpperCase(),
        location: pick(s.loc),
        environment: pick(ENVS),
        appKey: `${name} - ${tier} - ${domain} (${service})`,
        appDetailed: name,
        owner: 'Demo Owner',
        support: `${domain} Support`,
        vcpu,
        memGB: vcpu * pick([2, 4, 4, 8]),
        storageProvGB: Math.round(80 + r() * 900),
        storageUsedGB: Math.round(40 + r() * 400),
      });
    }
  });
  const clusters: Cluster[] = [
    ['MacPark-Windows', 'Gold', 8, 320], ['MacPark-Linux', 'Gold', 4, 160], ['Equinix-Windows', 'Gold', 4, 256],
    ['Equinix-Linux', 'Gold', 3, 136], ['AUB-HX-PRD01', 'Silver', 3, 72], ['BEM-HX-PRD01', 'Silver', 6, 108],
    ['SEG-HX-PRD01', 'Silver', 3, 72], ['USD-HX-PRD01', 'Silver', 3, 48],
  ].map(([name, classification, hosts, cores]) => {
    const on = vms.filter((v) => v.location === name && v.poweredOn);
    return {
      name: name as string, classification: classification as string, vcenter: '', hosts: hosts as number,
      sockets: (hosts as number) * 2, cores: cores as number, memGiB: 0,
      runningVMs: on.length, runningVcpu: on.reduce((a, v) => a + v.vcpu, 0),
    };
  });
  return { sourceFile: 'Demo data (synthetic)', loadedAt: new Date().toISOString(), isDemo: true, vms, clusters };
}
