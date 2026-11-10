# OnPrem Transformation Planner

A web app where a team plans the on-prem virtualisation exit together. Each application (`Application_Primary`) gets
a **treatment** and a **target FY quarter**. The app projects how VMs and vCPU decline quarter by quarter against the
VMware and hardware renewal deadlines.

FY runs **1 July – 30 June** (FY27 = Jul 2026 – Jun 2027). Q1 = Jul–Sep, Q2 = Oct–Dec, Q3 = Jan–Mar, Q4 = Apr–Jun.

## Deploy on a server (no GitHub, no internet)

1. Install **Node.js 22.13+ or 24 LTS** on the server. This is the only prerequisite.
2. Copy `OnPremTransformationPlanner-<version>.zip` to the server and unzip it. Build the zip with `npm run package`, or take it
   from a release.
3. Run `start.bat` for port 9080, or `start.bat 9000` for another port. On Linux, run `./start.sh 9000`.
4. Everyone opens `http://<server>:<port>`.

The package contains `server.mjs` (the API server with every library bundled in), `app/` (the web pages) and
`data/footprint.db`, which is created on first start. The database holds every decision, the change history, the
settings and each uploaded VMInfo file, so **back up that file**. It is a single self-contained file and safe to copy while the server is running. To upgrade, replace `server.mjs` and `app/`
and keep `data/`. When an upgrade changes the database structure, the server first saves a copy of the database to
`data/backups/`.

## Pages

| Page | What it does |
|---|---|
| **Executive Summary** | KPIs, VMs and vCPU remaining **by quarter or by FY** (indexed to today on one axis, or as two absolute charts), deadline markers and countdowns with the projected footprint on each date (for hardware deadlines, only the footprint on that vendor's clusters), vCPU leaving per quarter by treatment, the treatment mix, a **treatment timeline** listing apps in the order they leave, footprint by domain, and the hardware estate. |
| **Application Planner** | Set each application's treatment, the **FY quarter** it leaves on-prem, and notes. Filter and sort by domain, tier, treatment, vCenter or environment. Expand a row to see its VMs, select several rows to edit them together, switch to a per-VM view, and see who changed each row last and its full history. |
| **Inventory Updates** | Upload the latest VMInfo `.xlsx`. Each upload is kept with who uploaded it, when, a note, the original file (downloadable), and a comparison with the previous upload: VMs and vCPU up or down, plus lists of new and removed applications and VMs. If an application was renamed, its decision can be **re-linked** to the new name. |
| **Activity** | Change log of every decision (who, when, before and after), filterable by person and application. |
| **Settings** | Planning horizon, whether powered-off VMs count, deadlines (VMware, Cisco or Lenovo hardware, or your own), cluster-to-vendor mapping, a JSON backup, and decision import. You can also import decisions saved in a browser by the earlier browser-only version. |

**Export to Excel (with charts)**, available on every main page, produces one workbook. Its first sheet, **Executive Summary**, holds the key figures, deadlines with the projected footprint on each date, the treatment mix, domain and hardware tables, and six **native Excel charts**: footprint by quarter as % of today, vCPU leaving per quarter by treatment, vCPU and VMs remaining by quarter, vCPU at each FY end, and vCPU by treatment. The charts are editable and read from a *Chart data* sheet, and the Executive Summary sheet prints on one landscape page width. The remaining sheets are:
Treatment plan (one row per application: treatment, target FY, quarter, period, the date it's off on-prem by, notes,
who changed it last); Quarterly roadmap (apps, VMs and vCPU leaving and remaining per quarter, split by treatment);
Apps by quarter; VMs; Change log; Inventory uploads; Chart data; and Unmatched decisions.
The dashboard also has a **Print / Save as PDF** button that lays the executive summary out on A4 landscape pages.

### Executive Summary additions (v2.6)

- **Treatment timeline**: a matrix of treatment × financial year. Each cell lists the applications with their VM
  counts, target quarter and confidence, plus a TOTAL. Stay On-Prem rows span all years, and Sovereignty-bound includes
  the clusters pinned for data sovereignty. The same matrix is in the Excel *Treatment timeline* sheet.
- **VMs on-prem today**: total VMs, powered on and off, and how many are in the plan.
- **Resources assigned vs. used**: vCPU and vRAM used = the 24-hour average utilisation % from the RVTools report ×
  assigned, for powered-on VMs. Storage provisioned vs. used is for all VMs, including powered-off ones.

**Virtualization Resource** is a treatment for the virtualization platform itself (for example vCenter, VMware or
HyperFlex management). Those VMs are left out of the footprint, the forecast and every chart, and are listed greyed for
reference. **Domain corrections**: click the Domain cell in the planner to override the domain parsed from
Application_Primary. Corrections are kept across uploads and logged in Activity.

### Milestones on the Executive Summary (v2.8)

In Settings › Deadlines, each milestone has these options:
- **On Exec Summary**: whether leadership sees it in Key deadlines, the "Next deadline" card, the chart and the Excel export.
- **Colour**: chosen with a colour picker.
- **Shown as**: *Dot*, a numbered dot just above the time axis, or *Dotted line*, for enterprise-wide milestones (Go-Live
  milestones default to this).

The number and colour on the chart match the badge in the Key deadlines list on the right, which is numbered by date.

### Confidence and the risk-adjusted forecast

For each application that leaves on-prem, the planner records a **confidence**: High, Medium, Low or Unknown. It is
blank until someone rates it. Confidence means "it will be off on-prem by its target quarter". Each level counts a share of the
workload as moved, and these weights are editable in Settings (defaults: High 100%, Medium 75%, Low 50%, Unknown 25%, Not rated 25%).

The forecast is shown in three scenarios:
- **Risk-adjusted** (default headline): every move is weighted by its confidence.
- **Full plan**: every scheduled move happens on its target quarter.
- **Committed**: only High-confidence moves happen. This is the safe floor.

The **Risk-adjusted / Full plan** toggle on the Executive Summary switches every headline number and chart, and the
Excel export follows it. The absolute charts shade the range from committed to full plan.

### Treatments

Retire · Move to SaaS · Modernise → AWS · Modernise → Azure · Lift & Shift → AWS · Stay On-Prem (Data Sovereignty) ·
Stay On-Prem (Latency) · Stay On-Prem (Maintain: no migration planned, not sovereignty- or latency-bound) · Not yet decided.

The three Stay On-Prem treatments can carry an optional **Review by** quarter, which marks when the decision should be
re-assessed. It does not change the forecast. The Executive Summary's **What stays on-prem** card, also in the Excel export,
breaks the remaining end-of-horizon footprint down into Sovereignty, Latency, Maintain, Undecided, moves that have no
target or fall after the horizon, and (in risk-adjusted view) the confidence shortfall on scheduled moves.
If the app reads a treatment it doesn't recognise, for example one written by a newer version, it shows that application as Undecided instead of failing.

Decisions belong to the application, not to a particular upload. They're keyed on the exact `Application_Primary`
text, so every new VMInfo upload picks them up automatically. An application counts as off on-prem at the end of its
target quarter.

### Data-sovereignty clusters

In Settings, each cluster has a **Data sovereignty** switch, with an optional reason. Every VM on a switched-on cluster is
**pinned on-prem**: it never counts as moving to SaaS, Modernise or Lift & Shift, though Retire still applies. Planning stays
per application. In the Application Planner, pinned VMs are greyed out with a flag pointing to the setting. Application rows
show "n of m VMs pinned" and how much vCPU can still move, and fully pinned applications offer one click to set Stay
On-Prem – Data Sovereignty. A Cluster filter helps review what runs where. Pinned VMs appear in "What stays on-prem"
and in the Excel export, and switching a cluster on or off is logged in Activity.

### Application mapping rules

On the Inventory Updates page you can correct the VMInfo data without editing the spreadsheet. A **merge** rule counts one
Application_Primary as another, for example duplicates with a different tier or spelling. An **assign VM** rule moves a
single VM, for example an untagged one, to an application. Rules apply to every upload, keep the original value (shown in the VM view and
in the Excel *VMs* and *Mapping rules* sheets), are logged in Activity and can be removed. A rule is flagged *No longer
needed* once the source disappears from the VMInfo file, for example after the CMDB has been corrected. Merging never deletes a
decision without asking: a decision on the merged application moves to the target, and if both have one you choose.

**Components:** a merge rule can keep the merged labels as *components*. The application then has one treatment,
but expanding it in the planner shows each component (from the label's service text) with its owners and VMs, for
example Custom Sound ▸ Clinical Fitting Software, Application testing, Package testing and Analytics. The Excel *VMs* sheet has a
Component column. You can switch this per rule on the Inventory Updates page.

### Collaboration

When someone first opens the app, it asks for their name, which is then recorded against every change and upload.
Pages check for other people's changes every 8 seconds. If two people edit the same application at once, the second
save is refused and that person sees the first person's version instead of silently overwriting it.
There is no login. Anyone who can reach the URL can edit, so run it on an internal network. SSO or Active Directory
sign-in can be added later.

### Categories taken from the spreadsheet

`Application_Primary` is parsed as `Name - Tier - Domain (Service)`, for example
`Windchill (CSV) - Tier1 - SCC (Product Lifecycle Management)` gives Domain **SCC** and Tier **Tier 1**. Environment,
vCenter and cluster come from their own columns. The `Clusters` sheet supplies host and core counts. Clusters default to
Cisco FlashStack (Equinix-Linux, Equinix-Windows, MacPark-CCTV, MacPark-Linux, MacPark-Windows), Cisco HyperFlex
(names containing `-HX-`) or Lenovo (all others). You can change any cluster in Settings.

## Data privacy

This repository is public, so no inventory data is committed. `.gitignore` excludes `*.xlsx`, `*.csv`, `data/` and
build output. Inventory and decisions exist only in the server's `data/footprint.db`.

## Development

```bash
npm install
npm run dev:server   # API on :8090 (auto-restarts on change)
npm run dev          # web app on :5173, with /api proxied to :8090
npm run package      # builds release/OnPremTransformationPlanner-<version>.zip
```

`start.bat` and `start.sh` in the repo root build from source and run, which needs internet once for `npm install`.

Stack: React 19 + TypeScript + Vite and Recharts on the front end. The server uses Node's built-in `node:sqlite` with
Express, read-excel-file and write-excel-file, all bundled into one file.

To rename the product, edit `src/lib/brand.ts`.
