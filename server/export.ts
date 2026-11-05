import writeExcelFile from 'write-excel-file/node';
import { DISP, DISPOSITIONS } from '../src/lib/dispositions.ts';
import { fyLabel, fyQuarterEnd, quarterLabel, quarterRange } from '../src/lib/fy.ts';
import { exitDate, exitsBy, footprintAt, groupApps, periods, planFor, scopeVMs } from '../src/lib/projection.ts';
import { parseApp } from '../src/lib/parse.ts';
import type { HistoryEntry, Inventory, PlanMap, Settings, UploadMeta } from '../src/lib/types.ts';

type Cell = { value?: unknown; type?: unknown; format?: string; fontWeight?: 'bold'; backgroundColor?: string; color?: string; wrap?: boolean } | null;
type Row = Cell[];

const H = (v: string): Cell => ({ value: v, fontWeight: 'bold', backgroundColor: '#1F4E79', color: '#FFFFFF' });
const S = (v: unknown): Cell => (v === undefined || v === null || v === '' ? null : { value: String(v), type: String });
const N = (v: number | undefined | null): Cell => (v === undefined || v === null ? null : { value: v, type: Number, format: '#,##0' });
const D = (v: Date | string | undefined | null): Cell => {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : { value: d, type: Date, format: 'dd-mmm-yyyy' };
};
const DT = (v: string | undefined): Cell => (v ? { value: new Date(v), type: Date, format: 'dd-mmm-yyyy hh:mm' } : null);

function sheet(name: string, header: string[], rows: Row[], widths: number[]) {
  return {
    sheet: name,
    data: [header.map(H), ...rows],
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: 1,
  };
}

export async function buildTreatmentWorkbook(input: {
  inventory: Inventory | null;
  plans: PlanMap;
  settings: Settings;
  history: HistoryEntry[];
  uploads: UploadMeta[];
}): Promise<Buffer> {
  const { inventory, plans, settings, history, uploads } = input;
  const allVms = inventory?.vms ?? [];
  const vms = scopeVMs(allVms, settings);
  const apps = groupApps(allVms);
  const scopeNote = settings.includePoweredOff ? 'all VMs' : 'powered-on VMs only';

  // 1. Treatment plan – one row per application
  const appRows = apps
    .map((a) => ({ a, p: planFor(plans, a.key), exit: exitDate(planFor(plans, a.key)) }))
    .sort((x, y) => (x.exit?.getTime() ?? Infinity) - (y.exit?.getTime() ?? Infinity) || y.a.vcpu - x.a.vcpu);
  const treatment = sheet(
    'Treatment plan',
    ['Application_Primary', 'Application', 'Domain', 'Tier', 'Service', 'Owner', 'VMs', 'Powered-on VMs', 'vCPU', 'vRAM (GB)', 'Storage (GB)',
      'Environments', 'vCenters', 'Treatment', 'Treatment group', 'Target FY', 'Target quarter', 'Target period', 'Off on-prem by', 'Notes', 'Last updated by', 'Last updated'],
    appRows.map(({ a, p, exit }) => {
      const m = DISP[p.disposition];
      const scheduled = m.leavesOnPrem && p.targetFY;
      return [
        S(a.key), S(a.name), S(a.domain), S(a.tier), S(a.service), S(a.owner), N(a.vmCount), N(a.vms.filter((v) => v.poweredOn).length),
        N(a.vcpu), N(Math.round(a.memGB)), N(Math.round(a.storageGB)), S(a.environments.join(', ')), S(a.sites.join(', ')),
        S(m.label), S(m.group === 'Exit' ? 'Retire / SaaS' : m.group === 'Cloud' ? 'Hyperscaler' : m.group === 'Retain' ? 'Stays on-prem' : 'Undecided'),
        S(scheduled ? fyLabel(p.targetFY!) : m.leavesOnPrem ? 'Not scheduled' : ''),
        S(scheduled ? `Q${p.targetQ ?? 4}` : ''),
        S(scheduled ? `${quarterLabel(p.targetFY!, p.targetQ ?? 4)} (${quarterRange(p.targetFY!, p.targetQ ?? 4)})` : ''),
        D(exit), S(p.notes), S(p.updatedBy), DT(p.updatedAt),
      ];
    }),
    [48, 28, 10, 9, 28, 22, 7, 9, 7, 9, 10, 18, 12, 28, 14, 12, 9, 26, 13, 40, 18, 17],
  );

  // 2. Quarterly roadmap
  const ps = periods(settings, 'quarter');
  const exitsV = exitsBy(vms, plans, settings, 'vcpu', 'quarter');
  const exitsN = exitsBy(vms, plans, settings, 'vms', 'quarter');
  const leaving = DISPOSITIONS.filter((d) => d.leavesOnPrem);
  const roadmap = sheet(
    'Quarterly roadmap',
    ['Quarter', 'Period', 'Quarter end', 'Apps leaving', 'VMs leaving', 'vCPU leaving', ...leaving.map((d) => `vCPU – ${d.short}`), 'VMs remaining', 'vCPU remaining'],
    ps.map((p, i) => {
      const rem = footprintAt(vms, plans, p.end);
      return [
        S(p.label), S(quarterRange(p.fy, p.q)), D(fyQuarterEnd(p.fy, p.q)), N(exitsV[i].apps), N(exitsN[i].total), N(exitsV[i].total),
        ...leaving.map((d) => N(exitsV[i][d.id] ?? 0)), N(rem.vms), N(rem.vcpu),
      ];
    }),
    [12, 16, 13, 12, 11, 12, ...leaving.map(() => 14), 13, 14],
  );

  // 3. Apps by quarter (the "what leaves when" list)
  const byQuarter = sheet(
    'Apps by quarter',
    ['Quarter', 'Period', 'Application', 'Domain', 'Treatment', 'VMs', 'vCPU', 'Notes'],
    appRows
      .filter(({ exit }) => exit)
      .map(({ a, p }) => [
        S(quarterLabel(p.targetFY!, p.targetQ ?? 4)), S(quarterRange(p.targetFY!, p.targetQ ?? 4)), S(a.name), S(a.domain),
        S(DISP[p.disposition].label), N(a.vmCount), N(a.vcpu), S(p.notes),
      ]),
    [12, 16, 32, 10, 28, 7, 7, 40],
  );

  // 4. VMs with their application's treatment
  const vmSheet = sheet(
    'VMs',
    ['VMName', 'PowerState', 'Application_Primary', 'Domain', 'Tier', 'Environment', 'vCenter', 'VMLocation', 'GuestOS', 'vCPU', 'Memory (GB)', 'Storage (GB)', 'Treatment', 'Target period', 'Off on-prem by'],
    [...allVms]
      .sort((x, y) => x.appKey.localeCompare(y.appKey) || x.name.localeCompare(y.name))
      .map((v) => {
        const a = parseApp(v.appKey);
        const p = planFor(plans, v.appKey);
        const ex = exitDate(p);
        return [
          S(v.name), S(v.poweredOn ? 'PoweredOn' : 'PoweredOff'), S(v.appKey), S(a.domain), S(a.tier), S(v.environment), S(v.vcenter),
          S(v.location), S(v.os), N(v.vcpu), N(v.memGB), N(Math.round(v.storageProvGB)), S(DISP[p.disposition].label),
          S(ex ? quarterLabel(p.targetFY!, p.targetQ ?? 4) : ''), D(ex),
        ];
      }),
    [28, 11, 48, 10, 9, 11, 26, 18, 32, 6, 10, 10, 26, 12, 13],
  );

  // 5. Decisions that no longer match an application in the latest inventory
  const keys = new Set(apps.map((a) => a.key));
  const orphans = Object.entries(plans).filter(([k]) => !keys.has(k));

  // 6. Change log
  const fmtPlan = (p: HistoryEntry['before']) => {
    if (!p) return '';
    const m = p.disposition ? DISP[p.disposition]?.label ?? p.disposition : '';
    const t = p.targetFY ? ` · ${quarterLabel(p.targetFY, p.targetQ ?? 4)}` : '';
    return `${m}${t}${p.notes ? ` · ${p.notes}` : ''}`;
  };
  const changeLog = sheet(
    'Change log',
    ['When', 'Who', 'Application_Primary', 'Action', 'Before', 'After'],
    history.map((h) => [DT(h.changedAt), S(h.changedBy), S(h.appKey), S(h.action), S(fmtPlan(h.before)), S(fmtPlan(h.after))]),
    [17, 20, 48, 9, 40, 40],
  );

  // 7. Upload history
  const uploadSheet = sheet(
    'Inventory uploads',
    ['Upload #', 'File', 'Uploaded by', 'Uploaded at', 'Note', 'VMs', 'Powered on', 'vCPU', 'Applications', 'VMs added', 'VMs removed', 'Apps added', 'Apps removed'],
    uploads.map((u) => [N(u.id), S(u.filename), S(u.uploadedBy), DT(u.uploadedAt), S(u.note), N(u.vmCount), N(u.poweredOn), N(u.vcpu), N(u.appCount),
      N(u.diff.vmsAdded.length), N(u.diff.vmsRemoved.length), N(u.diff.appsAdded.length), N(u.diff.appsRemoved.length)]),
    [9, 36, 20, 17, 30, 7, 10, 7, 12, 10, 11, 10, 12],
  );

  const summary = sheet(
    'Summary',
    ['Item', 'Value'],
    [
      [S('Generated'), DT(new Date().toISOString())],
      [S('Inventory'), S(inventory ? `${inventory.sourceFile} (upload #${inventory.uploadId}, ${inventory.uploadedBy})` : 'No inventory uploaded')],
      [S('Footprint basis'), S(scopeNote)],
      [S('Current FY'), S(fyLabel(settings.currentFY))],
      [S('Horizon'), S(`to end of ${fyLabel(settings.horizonFY)}`)],
      [S('VMs today'), N(vms.length)],
      [S('vCPU today'), N(vms.reduce((s, v) => s + v.vcpu, 0))],
      [S(`VMs remaining end ${fyLabel(settings.horizonFY)}`), N(footprintAt(vms, plans, fyQuarterEnd(settings.horizonFY, 4)).vms)],
      [S(`vCPU remaining end ${fyLabel(settings.horizonFY)}`), N(footprintAt(vms, plans, fyQuarterEnd(settings.horizonFY, 4)).vcpu)],
      [S('Applications'), N(apps.length)],
      [S('Applications with a decision'), N(apps.filter((a) => planFor(plans, a.key).disposition !== 'tbd').length)],
      ...settings.deadlines.map((d) => [S(`${d.label}${d.confirmed ? '' : ' (date to confirm)'}`), D(d.date)]),
    ],
    [44, 60],
  );

  const sheets = [summary, treatment, roadmap, byQuarter, vmSheet, changeLog, uploadSheet];
  if (orphans.length) {
    sheets.push(sheet('Unmatched decisions', ['Application_Primary (not in latest inventory)', 'Treatment', 'Target period', 'Notes', 'Last updated by'],
      orphans.map(([k, p]) => [S(k), S(DISP[p.disposition].label), S(p.targetFY ? quarterLabel(p.targetFY, p.targetQ ?? 4) : ''), S(p.notes), S(p.updatedBy)]),
      [52, 28, 12, 40, 20]));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await writeExcelFile(sheets as any).toBuffer()) as Buffer;
}
