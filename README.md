# On-Prem Footprint

A browser-only web app that visualises the on-prem virtualisation footprint (VMs and vCPU) and projects its run-down by
financial year as each application is given a target disposition.

FY runs **1 July – 30 June** (FY27 = Jul 2026 – Jun 2027). The current FY is derived from today's date.

## Pages

| Page | What it does |
|---|---|
| **Executive Summary** | KPIs, VMs and vCPU remaining at the end of each FY (shown indexed to 100% on one axis, or as two separate absolute charts), deadline markers, a countdown and the projected footprint on each deadline date (for hardware deadlines, only the footprint on that vendor's clusters), vCPU leaving each FY by disposition, the disposition mix, footprint by domain, and the hardware estate by vendor. |
| **Application Planner** | One row per `Application_Primary`. Set the disposition, the FY and quarter in which it leaves on-prem, and notes. Filter by domain, tier, disposition, vCenter or environment. Sort any column. Expand a row to see its VMs, select several rows to edit them together, or switch to the **By VM** view to sort VMs by application, domain, location and so on. Export to CSV. |
| **Data & Settings** | Load the VMInfo `.xlsx`, set the planning horizon, choose whether powered-off VMs count, edit deadlines (VMware renewal, Cisco and Lenovo hardware renewal, or your own), map each cluster to a vendor, and export or import the plan as JSON. |

### Dispositions

Retire · Move to SaaS · Modernise → AWS · Modernise → Azure · Lift & Shift → AWS · Stay On-Prem (Data Sovereignty) ·
Stay On-Prem (Latency) · Not yet decided.

An application counts as gone from on-prem at the end of its target FY quarter (Q4 if no quarter is chosen).
Applications that stay on-prem, are undecided, or have no target FY yet stay in the footprint.

### Categories taken from the spreadsheet

`Application_Primary` is parsed as `Name - Tier - Domain (Service)`, for example
`Windchill (CSV) - Tier1 - SCC (Product Lifecycle Management)` gives Domain **SCC** and Tier **Tier 1**. Environment,
vCenter (site) and VMLocation (cluster) come from their own columns. If the workbook has a `Clusters` sheet, it supplies
host and core counts. Clusters with `-HX-` in the name default to Cisco HyperFlex and all others to Lenovo; you can
change this on the Data & Settings page.

## Data privacy

This repository is public, so **no inventory data is committed**. `.gitignore` excludes `*.xlsx`, `*.csv` and plan
exports. The Excel file is parsed in the browser, and the inventory, plan and settings are kept in the browser's
`localStorage`. Until a file is loaded, the app shows synthetic demo data. To share decisions with other people, use
**Export plan (JSON)** and **Import plan**. Plans are matched on the exact `Application_Primary` text, so loading a newer
VMInfo export keeps your decisions.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ – host on any web server / S3 / Azure Static Web Apps
```

Stack: React 19 + TypeScript + Vite, Recharts, read-excel-file.
