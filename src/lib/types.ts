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
  /** Set when a mapping rule moved this VM to a different application (the value from the VMInfo file). */
  origAppKey?: string;
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
  uploadId?: number;
  uploadedBy?: string;
  vms: VM[];
  clusters: Cluster[];
}

export interface UploadDiff {
  previousUploadId: number | null;
  vmDelta: number;
  vcpuDelta: number;
  vmsAdded: string[];
  vmsRemoved: string[];
  appsAdded: { key: string; vms: number; vcpu: number }[];
  appsRemoved: { key: string; vms: number; vcpu: number; hadDecision: boolean }[];
}

export interface UploadMeta {
  id: number;
  filename: string;
  uploadedBy: string;
  uploadedAt: string;
  note: string;
  vmCount: number;
  poweredOn: number;
  vcpu: number;
  appCount: number;
  clusterCount: number;
  diff: UploadDiff;
}

export interface HistoryEntry {
  id: number;
  appKey: string;
  action: 'update' | 'bulk' | 'rename' | 'import' | 'rule' | 'delete';
  before: Partial<AppPlan> | null;
  after: Partial<AppPlan> | null;
  changedBy: string;
  changedAt: string;
}

export type Disposition =
  | 'tbd'
  | 'retire'
  | 'saas'
  | 'modernize_aws'
  | 'modernize_azure'
  | 'rehost_aws'
  | 'retain_sovereignty'
  | 'retain_latency'
  | 'retain_maintain';

export type Quarter = 1 | 2 | 3 | 4;

/** How confident we are the application is off on-prem by its target quarter. Undefined = not rated. */
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

/** Percent weights used for the risk-adjusted forecast (0-100). */
export type ConfidenceWeights = Record<Confidence | 'unrated', number>;

export interface AppPlan {
  disposition: Disposition;
  targetFY?: number; // e.g. 28 => FY28
  targetQ?: Quarter; // quarter of the FY in which it leaves on-prem (default Q4)
  notes?: string;
  confidence?: Confidence;
  /** Optional re-assessment quarter for applications that stay on-prem. */
  reviewFY?: number;
  reviewQ?: Quarter;
  // server-maintained
  version?: number;
  updatedBy?: string;
  updatedAt?: string;
}

export type PlanMap = Record<string, AppPlan>;

/** 'Cisco' = Cisco HyperFlex (kept as 'Cisco' for compatibility with saved data). */
export type HwVendor = 'Cisco' | 'FlashStack' | 'Lenovo' | 'Other';

export interface Deadline {
  id: string;
  label: string;
  date: string; // yyyy-mm-dd
  kind: 'VMware' | 'Cisco' | 'FlashStack' | 'Lenovo' | 'GoLive' | 'DressRehearsal' | 'Other';
  confirmed: boolean;
  note?: string;
}

export interface Settings {
  currentFY: number;
  horizonFY: number;
  includePoweredOff: boolean;
  deadlines: Deadline[];
  clusterVendor: Record<string, HwVendor>;
  confidenceWeights: ConfidenceWeights;
}

export interface AppInfo {
  key: string;
  name: string;
  tier: string;
  domain: string;
  service: string;
}

/** A correction applied to every VMInfo upload: merge one Application_Primary into another, or move one VM. */
export interface AppRule {
  id: number;
  kind: 'merge' | 'vm';
  /** merge: source Application_Primary · vm: VM name */
  source: string;
  /** Application_Primary the VMs are counted under */
  target: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface RuleEffect {
  vms: number;
  vcpu: number;
  /** vm rule: the VMInfo file now gives this VM its own (different) application */
  conflict?: string;
}
