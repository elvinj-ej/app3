import type { Deadline, HwVendor, Settings } from './types.ts';
import { fyOf } from './fy.ts';

export const DEFAULT_DEADLINES: Deadline[] = [
  { id: 'vmware', label: 'VMware (Broadcom VCF) renewal', date: '2027-12-31', kind: 'VMware', confirmed: false, note: 'Subscription term end – set the contract date' },
  { id: 'cisco', label: 'Cisco HyperFlex HW renewal', date: '2028-06-30', kind: 'Cisco', confirmed: false, note: 'HX support / refresh – set the contract date' },
  { id: 'lenovo', label: 'Lenovo HW renewal', date: '2029-03-31', kind: 'Lenovo', confirmed: false, note: 'Server warranty / refresh – set the contract date' },
];

export function defaultVendor(clusterName: string): HwVendor {
  return /-HX-/i.test(clusterName) ? 'Cisco' : 'Lenovo';
}

export function vendorOf(settings: Pick<Settings, 'clusterVendor'>, cluster: string): HwVendor {
  return settings.clusterVendor[cluster] ?? defaultVendor(cluster);
}

export function defaultSettings(today = new Date()): Settings {
  const fy = fyOf(today);
  return { currentFY: fy, horizonFY: fy + 5, includePoweredOff: false, deadlines: DEFAULT_DEADLINES, clusterVendor: {} };
}
