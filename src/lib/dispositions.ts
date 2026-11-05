import type { Disposition } from './types';

export interface DispositionMeta {
  id: Disposition;
  label: string;
  short: string;
  group: 'Exit' | 'Cloud' | 'Retain' | 'Undecided';
  leavesOnPrem: boolean;
  /** CSS variable holding the series colour (fixed per disposition, never by rank). */
  color: string;
  help: string;
}

// Order matters: it is the fixed categorical slot order used in every chart.
export const DISPOSITIONS: DispositionMeta[] = [
  { id: 'retire', label: 'Retire', short: 'Retire', group: 'Exit', leavesOnPrem: true, color: 'var(--s1)', help: 'Decommission – no replacement needed' },
  { id: 'saas', label: 'Move to SaaS', short: 'SaaS', group: 'Exit', leavesOnPrem: true, color: 'var(--s2)', help: 'Replace with a SaaS offering' },
  { id: 'modernize_aws', label: 'Modernise → AWS', short: 'Modernise AWS', group: 'Cloud', leavesOnPrem: true, color: 'var(--s3)', help: 'Re-platform / re-architect onto AWS native services' },
  { id: 'modernize_azure', label: 'Modernise → Azure', short: 'Modernise Azure', group: 'Cloud', leavesOnPrem: true, color: 'var(--s4)', help: 'Re-platform / re-architect onto Azure native services' },
  { id: 'rehost_aws', label: 'Lift & Shift → AWS', short: 'Lift & Shift AWS', group: 'Cloud', leavesOnPrem: true, color: 'var(--s5)', help: 'Rehost VMs as-is onto AWS (EC2 / EVS)' },
  { id: 'retain_sovereignty', label: 'Stay On-Prem – Data Sovereignty', short: 'On-Prem (Sovereignty)', group: 'Retain', leavesOnPrem: false, color: 'var(--s6)', help: 'Must remain on-prem: data residency / sovereignty' },
  { id: 'retain_latency', label: 'Stay On-Prem – Latency', short: 'On-Prem (Latency)', group: 'Retain', leavesOnPrem: false, color: 'var(--s7)', help: 'Must remain on-prem: latency-bound (e.g. manufacturing, OT)' },
  { id: 'tbd', label: 'Not yet decided', short: 'Undecided', group: 'Undecided', leavesOnPrem: false, color: 'var(--s-tbd)', help: 'No disposition captured yet' },
];

export const DISP: Record<Disposition, DispositionMeta> = Object.fromEntries(
  DISPOSITIONS.map((d) => [d.id, d]),
) as Record<Disposition, DispositionMeta>;
