import type { Confidence, ConfidenceWeights, Deadline, HwVendor, Settings } from './types.ts';
import { fyOf } from './fy.ts';

export const DEFAULT_DEADLINES: Deadline[] = [
  { id: 'vmware', label: 'VMware (Broadcom VCF) renewal', date: '2027-12-31', kind: 'VMware', confirmed: false, note: 'Subscription term end – set the contract date' },
  { id: 'cisco', label: 'Cisco HyperFlex HW renewal', date: '2028-06-30', kind: 'Cisco', confirmed: false, note: 'HX support / refresh – set the contract date' },
  { id: 'lenovo', label: 'Lenovo HW renewal', date: '2029-03-31', kind: 'Lenovo', confirmed: false, note: 'Server warranty / refresh – set the contract date' },
];

/** Clusters running on Cisco FlashStack (Cisco UCS + Pure Storage). */
export const FLASHSTACK_CLUSTERS = ['Equinix-Linux', 'Equinix-Windows', 'MacPark-CCTV', 'MacPark-Linux', 'MacPark-Windows'];

export function defaultVendor(clusterName: string): HwVendor {
  if (FLASHSTACK_CLUSTERS.some((c) => c.toLowerCase() === clusterName.toLowerCase())) return 'FlashStack';
  return /-HX-/i.test(clusterName) ? 'Cisco' : 'Lenovo';
}

export const VENDOR_LABEL: Record<HwVendor, string> = { Cisco: 'Cisco HyperFlex', FlashStack: 'Cisco FlashStack', Lenovo: 'Lenovo', Other: 'Other' };

/** Deadline kinds that relate to a hardware vendor's clusters. */
export function deadlineVendor(kind: Deadline['kind']): HwVendor | null {
  return kind === 'Cisco' || kind === 'FlashStack' || kind === 'Lenovo' ? kind : null;
}

export const DEFAULT_WEIGHTS: ConfidenceWeights = { high: 100, medium: 75, low: 50, unknown: 25, unrated: 25 };

export const CONFIDENCE: { id: Confidence; label: string; color: string }[] = [
  { id: 'high', label: 'High', color: 'var(--c-high)' },
  { id: 'medium', label: 'Medium', color: 'var(--c-med)' },
  { id: 'low', label: 'Low', color: 'var(--c-low)' },
  { id: 'unknown', label: 'Unknown', color: 'var(--c-unk)' },
];
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' };

/** Probability (0-1) that a scheduled move happens by its target quarter. */
export function moveWeight(c: Confidence | undefined, w: ConfidenceWeights): number {
  const v = c ? w[c] : w.unrated;
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)) / 100;
}

export function vendorOf(settings: Pick<Settings, 'clusterVendor'>, cluster: string): HwVendor {
  return settings.clusterVendor[cluster] ?? defaultVendor(cluster);
}

export function defaultSettings(today = new Date()): Settings {
  const fy = fyOf(today);
  return { currentFY: fy, horizonFY: fy + 5, includePoweredOff: false, deadlines: DEFAULT_DEADLINES, clusterVendor: {}, confidenceWeights: { ...DEFAULT_WEIGHTS } };
}
