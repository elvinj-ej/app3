// Cochlear financial year starts 1 July. FY27 = 1 Jul 2026 – 30 Jun 2027.

export function fyOf(d: Date): number {
  const y = d.getFullYear();
  const m = d.getMonth(); // 0 = Jan
  return (m >= 6 ? y + 1 : y) - 2000;
}

export function fyLabel(fy: number): string {
  return `FY${String(fy).padStart(2, '0')}`;
}

/** Quarter (1-4) within the FY: Q1 = Jul–Sep, Q2 = Oct–Dec, Q3 = Jan–Mar, Q4 = Apr–Jun. */
export function fyQuarterOf(d: Date): number {
  const m = d.getMonth();
  return Math.floor(((m + 6) % 12) / 3) + 1;
}

/** Last day of the given FY quarter (the date an app is treated as gone from on-prem). */
export function fyQuarterEnd(fy: number, q: number): Date {
  const calYear = 2000 + fy - (q <= 2 ? 1 : 0);
  const endMonth = [8, 11, 2, 5][q - 1]; // Sep, Dec, Mar, Jun (0-based)
  return new Date(calYear, endMonth + 1, 0, 23, 59, 59);
}

export function fyEnd(fy: number): Date {
  return fyQuarterEnd(fy, 4);
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function fmtDate(s: string): string {
  return parseISODate(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function daysUntil(s: string, from = new Date()): number {
  const ms = parseISODate(s).getTime() - new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  return Math.round(ms / 86400000);
}

export function humanCountdown(days: number): string {
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days === 0) return 'today';
  if (days < 60) return `in ${days} days`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `in ${months} months`;
  return `in ${(days / 365.25).toFixed(1)} years`;
}
