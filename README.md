# Kidney Advisor

Local-first self-management app for chronic kidney disease (stage 3). Tracks labs, blood pressure, medications, diet, symptoms, and appointment prep — all in your browser, no server, no telemetry.

## Run it

Double-click `index.html`. That's it. Works offline. No install.

For best results, pin the tab in your browser or save it as a desktop shortcut.

## Features

### Dashboard
- Latest eGFR with stage badge (3a/3b), creatinine, potassium, BP
- Today's diet bars vs targets
- eGFR trend chart
- Recent symptoms and today's medication adherence
- **Smart alerts** — flagged automatically when:
  - eGFR drops into Stage 4 or declines >25% YoY
  - Potassium trends up across last 3 readings, or exceeds 5.5
  - Phosphorus > 4.5, Hemoglobin < 11, Bicarbonate < 22
  - UACR enters albuminuria range
  - 7-day BP average exceeds your target
  - Medication refills are due or overdue

### Labs
- Manual entry for 11 values (eGFR, creatinine, BUN, K, P, Ca, Hgb, albumin, bicarbonate, UACR)
- 6 trend charts
- **CSV import** with auto-detected column mapping (handles common lab portal formats; you can override the mapping before importing)
- **CSV export** for sharing with your care team

### Blood Pressure
- Quick log with systolic/diastolic/pulse/position
- 7-day and 30-day rolling averages vs your target
- Trend chart

### Medications
- List with refill countdown (warns at 7 days, flagged when overdue)
- Daily adherence checklist
- **Reminder times** per medication (24-hour format like `08:00, 20:00`) — fires browser notifications when the app is open

### Diet
- **Searchable food database** of ~100 CKD-relevant foods with sodium / potassium / phosphorus / protein / fluid values
- "Low-K", "Low-P", "Low-Na" tags on kidney-friendly foods
- Custom entry form for items not in the database
- Today's totals vs your configurable targets

### Symptoms
- Daily log: fatigue, swelling, nausea, itch, sleep, mood, weight
- Multi-line trend chart for symptom severity
- Weight trend chart (watch for fluid retention)

### Visit Prep
- Track upcoming appointment date, provider, and notes
- Build a question list, organized by category (Labs, Meds, Diet, BP, Symptoms, Lifestyle, Planning)
- 21 pre-built common-question templates — one click to add
- Mark questions as Open → Asked → Answered, with notes per answer
- **Print / Save-as-PDF** the question list to bring to your visit
- Auto-generated past-visit summary from answered questions

### Settings
- Personal targets (BP, sodium, K, P, protein, fluids)
- Reminder times for BP and daily check-in
- **OneDrive sync** — pick a JSON file in any synced folder; the app auto-writes to it on every change. Open the same file from another device to keep everything in sync. (Requires Edge or Chrome — uses the File System Access API.)
- Manual JSON export/import as backup

## Data & privacy

Everything lives in `localStorage` on this device. The optional sync feature writes to a file you pick — typically in OneDrive — so the data flows between your devices via OneDrive's file sync, not through any third-party server.

**Back up regularly.** Settings → Export JSON. If you clear browser data, you'll lose entries without a backup.

## Default targets (edit in Settings)

| Target            | Default       |
|-------------------|---------------|
| Sodium            | 2,300 mg/day  |
| Potassium         | 2,500 mg/day  |
| Phosphorus        | 900 mg/day    |
| Protein           | 55 g/day      |
| Fluids            | 64 oz/day     |
| BP                | <130/80 mmHg  |

Protein target is roughly 0.7 g/kg/day for an 80 kg person — recalculate using your weight.

## Reminder time format

`08:00` — single time
`08:00, 20:00` — multiple times, comma-separated
24-hour format only. Notifications require:
1. The app tab to be open
2. Notifications permission granted (browser will prompt when you enable)

## CSV import format

The app auto-detects columns whose headers contain words like:
- date / drawn / collected
- egfr / gfr
- creat (creatinine)
- bun / urea
- potass / k
- phosph / p
- calc / ca
- hemo / hgb / hb
- album
- bicarb / hco3 / co2
- uacr / microalb

If auto-detection misses a column, use the dropdowns in the preview to fix the mapping before confirming the import. Date formats accepted: ISO (`YYYY-MM-DD`), US (`M/D/YYYY`), and most common variants.

## Disclaimer

Educational tool only. Not medical advice. Use alongside (not instead of) care from your nephrologist and primary physician.
