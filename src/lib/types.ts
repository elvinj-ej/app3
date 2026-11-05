export interface VM {
  name: string;
  poweredOn: boolean;
  os: string;
  vcenter: string;
  site: string; // vCenter short code, e.g. AUM / AUS / BEM / USD
  location: string; // VMLocation (cluster)
  environment: string;
  appKey: string; // raw Application_Primary value (the planning unit)
  appDetailed: string;
  owner: string;
  support: string;
  vcpu: number;
  memGB: number;
  storageProvGB: number;
  storageUsedGB: number;
}

export interface Cluster {
  name: string;
  classification: string;
  vcenter: string;
  hosts: number;
  sockets: number;
  cores: number;
  memGiB: number;
  runningVMs: number;
  runningVcpu: number;
}

export interface Inventory {
  sourceFile: string;
  loadedAt: string; // ISO
  isDemo: boolean;
  vms: VM[];
  clusters: Cluster[];
}

export type Disposition =
  | 'tbd'
  | 'retire'
  | 'saas'
  | 'modernize_aws'
  | 'modernize_azure'
  | 'rehost_aws'
  | 'retain_sovereignty'
  | 'retain_latency';

export type Quarter = 1 | 2 | 3 | 4;

export interface AppPlan {
  disposition: Disposition;
  targetFY?: number; // e.g. 28 => FY28
  targetQ?: Quarter; // quarter of the FY in which it leaves on-prem (default Q4)
  notes?: string;
}

export type PlanMap = Record<string, AppPlan>;

export type HwVendor = 'Cisco' | 'Lenovo' | 'Other';

export interface Deadline {
  id: string;
  label: string;
  date: string; // yyyy-mm-dd
  kind: 'VMware' | 'Cisco' | 'Lenovo' | 'Other';
  confirmed: boolean;
  note?: string;
}

export interface Settings {
  currentFY: number;
  horizonFY: number;
  includePoweredOff: boolean;
  deadlines: Deadline[];
  clusterVendor: Record<string, HwVendor>;
}

export interface AppInfo {
  key: string;
  name: string;
  tier: string;
  domain: string;
  service: string;
}
