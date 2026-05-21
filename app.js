// Kidney Advisor — local-first CKD stage 3 tracker
// All data lives in localStorage + an optional sync file. No telemetry.

// Actively unregister any previously-installed service worker. The earlier
// SW caused intermittent "Failed to fetch" during cloud sync. version.json
// polling handles update propagation without it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister().catch(() => {}));
  }).catch(() => {});
}

const STORAGE_KEY = 'kidney-advisor-v1';
const FIRED_KEY = 'kidney-advisor-fired';
const ADVISOR_SECRET_KEY = 'kidney-advisor-secret';
const ADVISOR_USAGE_KEY = 'kidney-advisor-usage';

// Defaults tuned to Jason's profile: 56 y/o male, 195 lb (88.5 kg), CKD stage 3b
// trending toward stage 4 (last eGFR 27, 2026-04-27). Values follow KDOQI 2020
// nutrition guidance for non-dialysis CKD stages 3–5:
//   Energy 25–35 kcal/kg/day → ~2200 kcal at sedentary baseline
//   Protein 0.55–0.60 g/kg/day (LPD to slow progression) → ~53 g
//   Sodium <2300 mg, tightened to 2000 given CKD progression
//   Potassium 2000–3000 mg, individualized to lab K
//   Phosphorus 800–1000 mg, tightened to 800 given stage 4 risk
//   Fiber 30 g (men 50+ DGA)
//   Macros: ~50% carbs (275 g) / ~30% fat (73 g) of 2200 kcal
// Adjust per nephrology/RD guidance — these are starting targets, not orders.
const DEFAULT_SETTINGS = {
  weightLbs: 195,
  sodiumTarget: 2000,
  potassiumTarget: 2500,
  phosphorusTarget: 800,
  proteinTarget: 53,
  fluidTarget: 64,
  caloriesTarget: 2200,
  carbsTarget: 275,
  fatTarget: 73,
  fiberTarget: 30,
  stepsTarget: 8000,
  bpSys: 130,
  bpDia: 80,
  settingsProfileVersion: 1,
};

const DEFAULT_REMINDERS = {
  bpTime: '',
  checkinTime: '',
  enabled: false,
};

// ─── State ────────────────────────────────────────────────────────────────

let state = load();
let charts = {};
let syncHandle = null;
let syncWriteTimer = null;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw);
    const merged = mergeState(parsed);
    // Persist any settings-profile migration in localStorage so the new
    // targets stick even if the user never edits anything this session.
    // Skip the cloud push — each device migrates on its own first launch
    // and last-write-wins would otherwise race across devices.
    if (Number(parsed?.settings?.settingsProfileVersion || 0) < TARGET_PROFILE_VERSION) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch {}
    }
    return merged;
  } catch (e) {
    console.error('Load failed', e);
    return blankState();
  }
}

function mergeState(incoming) {
  const merged = {
    ...blankState(),
    ...incoming,
    settings: { ...DEFAULT_SETTINGS, ...(incoming.settings || {}) },
    reminders: { ...DEFAULT_REMINDERS, ...(incoming.reminders || {}) },
    questions: incoming.questions || [],
    visit: incoming.visit || { date: '', provider: '', notes: '' },
    advisorChat: incoming.advisorChat || [],
  };
  applySettingsProfileMigrations(merged);
  return merged;
}

// One-time settings refresh. When DEFAULT_SETTINGS gets retuned (e.g. new
// CKD-stage guidance), bump TARGET_PROFILE_VERSION and add the keys that
// should be force-overwritten in this revision. Saved state from prior
// versions takes precedence in mergeState's spread, so without this Jason's
// old targets would shadow the new defaults forever.
const TARGET_PROFILE_VERSION = 1;
const TARGET_PROFILE_KEYS_BY_VERSION = {
  1: ['weightLbs', 'sodiumTarget', 'potassiumTarget', 'phosphorusTarget',
      'proteinTarget', 'fluidTarget', 'caloriesTarget', 'carbsTarget',
      'fatTarget', 'fiberTarget'],
};
function applySettingsProfileMigrations(s) {
  const current = Number(s.settings.settingsProfileVersion) || 0;
  if (current >= TARGET_PROFILE_VERSION) return false;
  let changed = false;
  for (let v = current + 1; v <= TARGET_PROFILE_VERSION; v++) {
    const keys = TARGET_PROFILE_KEYS_BY_VERSION[v] || [];
    for (const k of keys) {
      if (s.settings[k] !== DEFAULT_SETTINGS[k]) {
        s.settings[k] = DEFAULT_SETTINGS[k];
        changed = true;
      }
    }
  }
  s.settings.settingsProfileVersion = TARGET_PROFILE_VERSION;
  return changed;
}

function blankState() {
  return {
    labs: [],
    bp: [],
    meds: [],
    medLog: {},
    diet: [],
    steps: [],
    symptoms: [],
    questions: [],
    visit: { date: '', provider: '', notes: '' },
    advisorChat: [],
    settings: { ...DEFAULT_SETTINGS },
    reminders: { ...DEFAULT_REMINDERS },
    lastModified: 0,
  };
}

function save(opts = {}) {
  state.lastModified = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleSyncWrite();
  if (!opts.skipCloud) scheduleCloudPush();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Decode the creation timestamp embedded in a uid() id (base36 of Date.now()).
// uid() format: base36(Date.now()) + 6 random base36 chars. Returns null if
// the parsed timestamp looks implausible.
function decodeUidCreated(id) {
  if (!id || typeof id !== 'string' || id.length <= 6) return null;
  const tsPart = id.slice(0, id.length - 6);
  const ms = parseInt(tsPart, 36);
  if (!Number.isFinite(ms) || ms < 1.5e12 || ms > Date.now() + 86400000) return null;
  return new Date(ms);
}

function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Idempotent migration: retro-correct diet entries that were stamped with the
// UTC date instead of the local date at creation. Pre-fix, `todayISO()`
// returned UTC, so anything logged after the UTC rollover (5 PM Phoenix)
// landed on the next day's totals. Safe because the criterion is strict:
// stored `date` must equal UTC-at-creation AND UTC must differ from local at
// creation. After re-dating, d.date == local, so the predicate no longer
// matches — re-running is a no-op. Run on every init + cloud pull so cloud
// data is also normalized.
function migrateUtcShiftedDates() {
  let fixed = 0;
  for (const d of state.diet) {
    const created = decodeUidCreated(d.id);
    if (!created) continue;
    const local = localDateString(created);
    const utc = created.toISOString().slice(0, 10);
    if (d.date === utc && utc !== local) {
      d.date = local;
      fixed++;
    }
  }
  if (fixed) {
    save();
    setTimeout(() => flash(`Re-dated ${fixed} entr${fixed === 1 ? 'y' : 'ies'} from UTC to local date`), 600);
  }
  return fixed;
}

// All display timestamps render in Arizona time (America/Phoenix, UTC-7 year-round,
// no DST). Forcing the tz means cloud-sync status, lab dates, briefings, etc.
// stay correct even if the user opens the app from a device set to another
// timezone (e.g. travel, a borrowed laptop).
const PHOENIX_TZ = 'America/Phoenix';

const phx = {
  // Full datetime, MM/DD/YYYY, h:mm AM/PM AZ
  datetime: (input) => {
    if (input == null || input === '') return '';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { timeZone: PHOENIX_TZ, dateStyle: 'short', timeStyle: 'short' });
  },
  // Short month + day + 12-hour time
  short: (input) => {
    if (input == null || input === '') return '';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { timeZone: PHOENIX_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
  // Date only (no time)
  date: (input) => {
    if (input == null || input === '') return '';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { timeZone: PHOENIX_TZ });
  },
  // Weekday + month + day (no time, no year)
  dateLong: (input) => {
    if (input == null || input === '') return '';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { timeZone: PHOENIX_TZ, weekday: 'short', month: 'short', day: 'numeric' });
  },
  // Today's date as YYYY-MM-DD in Phoenix tz (independent of device tz)
  isoToday: () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PHOENIX_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date());
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  },
};

const fmt = {
  // Bare YYYY-MM-DD dates: parse as midnight Phoenix so we don't accidentally
  // wrap to the prior day in UTC. Then render in Phoenix tz.
  date: iso => {
    if (!iso) return '';
    if (iso.length === 10) return phx.date(iso + 'T00:00:00-07:00');
    return phx.date(iso);
  },
  dt:   iso => iso ? phx.short(iso) : '',
  num:  (v, d = 1) => (v === null || v === undefined || v === '') ? '—' : Number(v).toFixed(d),
};

// ─── eGFR staging ─────────────────────────────────────────────────────────

function egfrStage(egfr) {
  if (egfr == null || egfr === '') return null;
  const n = Number(egfr);
  if (n >= 90) return { label: 'Stage 1', cls: 'stage-1', color: 'good' };
  if (n >= 60) return { label: 'Stage 2', cls: 'stage-2', color: 'good' };
  if (n >= 45) return { label: 'Stage 3a', cls: 'stage-3a', color: 'warn' };
  if (n >= 30) return { label: 'Stage 3b', cls: 'stage-3b', color: 'warn' };
  if (n >= 15) return { label: 'Stage 4',  cls: 'stage-4',  color: 'bad' };
  return { label: 'Stage 5', cls: 'stage-5', color: 'bad' };
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

function switchView(view) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  setTimeout(() => Object.values(charts).forEach(c => c && c.resize()), 50);
}

document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  switchView(btn.dataset.view);
});

const brandHome = document.getElementById('brand-home');
brandHome.addEventListener('click', () => switchView('diet'));
brandHome.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView('diet'); }
});

// ─── Forms ────────────────────────────────────────────────────────────────

function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = el.value === '' ? null : Number(el.value);
    else v = el.value;
    out[el.name] = v;
  }
  return out;
}

document.getElementById('lab-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.labs.push({ id: uid(), ...data });
  state.labs.sort((a, b) => a.date.localeCompare(b.date));
  save();
  e.target.reset();
  e.target.elements.date.value = todayISO();
  renderAll();
});

document.getElementById('bp-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.bp.push({ id: uid(), ...data });
  state.bp.sort((a, b) => a.datetime.localeCompare(b.datetime));
  save();
  e.target.reset();
  e.target.elements.datetime.value = nowDatetimeLocal();
  renderAll();
});

document.getElementById('med-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.meds.push({ id: uid(), ...data });
  save();
  e.target.reset();
  renderAll();
});

document.getElementById('diet-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.diet.push({ id: uid(), ...data });
  state.diet.sort((a, b) => a.date.localeCompare(b.date));
  save();
  e.target.reset();
  e.target.elements.date.value = todayISO();
  e.target.elements.servings.value = 1;
  renderAll();
});

document.getElementById('symptom-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.symptoms.push({ id: uid(), ...data });
  state.symptoms.sort((a, b) => a.date.localeCompare(b.date));
  save();
  e.target.reset();
  e.target.elements.date.value = todayISO();
  renderAll();
});

document.getElementById('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.settings = { ...state.settings, ...data };
  save();
  renderAll();
  flash('Targets saved');
});

document.getElementById('reminders-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = readForm(e.target);
  state.reminders = { ...state.reminders, ...data };
  if (data.enabled && 'Notification' in window && Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      state.reminders.enabled = false;
      flash('Notifications denied — toggle off');
    }
  }
  save();
  renderNotificationStatus();
  flash('Reminders saved');
});

document.getElementById('visit-form').addEventListener('submit', e => {
  e.preventDefault();
  state.visit = { ...state.visit, ...readForm(e.target) };
  save();
  flash('Saved');
  renderVisit();
});

document.getElementById('question-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  if (!data.text) return;
  state.questions.push({
    id: uid(),
    cat: data.cat,
    text: data.text,
    status: 'open',
    answer: '',
    addedDate: todayISO(),
  });
  save();
  e.target.reset();
  renderVisit();
});

// ─── Delete helpers ───────────────────────────────────────────────────────

function deleteFromList(listName, id) {
  if (!confirm('Delete this entry?')) return;
  state[listName] = state[listName].filter(x => x.id !== id);
  save();
  renderAll();
}

function deleteMed(id) {
  if (!confirm('Delete this medication?')) return;
  state.meds = state.meds.filter(m => m.id !== id);
  for (const day in state.medLog) delete state.medLog[day][id];
  save();
  renderAll();
}

// ─── Lab trend alerts ─────────────────────────────────────────────────────

function computeAlerts() {
  const alerts = [];
  const labs = state.labs;
  const last = labs[labs.length - 1];

  // eGFR-based
  if (last && last.egfr != null) {
    const e = Number(last.egfr);
    if (e < 30) alerts.push({ severity: 'bad', text: `eGFR ${fmt.num(e, 0)} indicates Stage 4 — discuss promptly with your nephrologist.` });
    else if (e < 45) alerts.push({ severity: 'warn', text: `eGFR ${fmt.num(e, 0)} is in Stage 3b range.` });
    // Year-over-year decline
    const oneYearAgo = labs.find(l => l.egfr != null && Date.parse(l.date) <= Date.now() - 350 * 24 * 3600 * 1000);
    if (oneYearAgo && oneYearAgo.egfr) {
      const drop = ((Number(oneYearAgo.egfr) - e) / Number(oneYearAgo.egfr)) * 100;
      if (drop > 25) alerts.push({ severity: 'bad', text: `eGFR has dropped ${drop.toFixed(0)}% from a year ago (was ${fmt.num(oneYearAgo.egfr,0)}, now ${fmt.num(e,0)}).` });
      else if (drop > 10) alerts.push({ severity: 'warn', text: `eGFR is down ${drop.toFixed(0)}% from a year ago.` });
    }
  }

  // Potassium trend (last 3 readings rising)
  const kPoints = labs.filter(l => l.potassium != null).slice(-3);
  if (kPoints.length === 3) {
    const [a, b, c] = kPoints.map(p => Number(p.potassium));
    if (c > b && b > a) alerts.push({ severity: 'warn', text: `Potassium trending up across last 3 labs (${a.toFixed(1)} → ${b.toFixed(1)} → ${c.toFixed(1)} mEq/L).` });
    if (c > 5.5) alerts.push({ severity: 'bad', text: `Latest potassium ${c.toFixed(1)} mEq/L is high — discuss with your nephrologist.` });
  }

  // Phosphorus high
  if (last && last.phosphorus != null && Number(last.phosphorus) > 4.5) {
    alerts.push({ severity: 'warn', text: `Phosphorus ${fmt.num(last.phosphorus, 1)} mg/dL is elevated.` });
  }

  // Hemoglobin (anemia)
  if (last && last.hemoglobin != null && Number(last.hemoglobin) < 11) {
    alerts.push({ severity: 'warn', text: `Hemoglobin ${fmt.num(last.hemoglobin, 1)} g/dL suggests anemia — common in CKD; ask about iron and ESA.` });
  }

  // Bicarbonate (metabolic acidosis)
  if (last && last.bicarbonate != null && Number(last.bicarbonate) < 22) {
    alerts.push({ severity: 'warn', text: `Bicarbonate ${fmt.num(last.bicarbonate, 1)} mEq/L is low — possible metabolic acidosis.` });
  }

  // UACR
  if (last && last.uacr != null) {
    const u = Number(last.uacr);
    if (u > 300) alerts.push({ severity: 'bad', text: `UACR ${u.toFixed(0)} mg/g is in macroalbuminuria range.` });
    else if (u > 30) alerts.push({ severity: 'warn', text: `UACR ${u.toFixed(0)} mg/g indicates albuminuria.` });
  }

  // BP averages
  const avg7 = bpAverage(7);
  if (avg7 && (avg7.sys > state.settings.bpSys || avg7.dia > state.settings.bpDia)) {
    alerts.push({ severity: 'warn', text: `7-day BP average ${avg7.sys}/${avg7.dia} is over your target of ${state.settings.bpSys}/${state.settings.bpDia}.` });
  }

  // Refills
  for (const m of state.meds) {
    if (m.refill) {
      const days = Math.floor((new Date(m.refill) - new Date()) / (24 * 3600 * 1000));
      if (days < 0) alerts.push({ severity: 'bad', text: `${m.name} refill is ${-days} day(s) overdue.` });
      else if (days <= 5) alerts.push({ severity: 'warn', text: `${m.name} refill due in ${days} day(s).` });
    }
  }

  return alerts;
}

function renderAlerts() {
  const panel = document.getElementById('alerts-panel');
  const alerts = computeAlerts();
  if (alerts.length === 0) { panel.hidden = true; return; }
  const hasBad = alerts.some(a => a.severity === 'bad');
  panel.classList.toggle('severity-bad', hasBad);
  panel.hidden = false;
  panel.innerHTML = `<h3>${hasBad ? 'Attention needed' : 'Heads up'}</h3>
    <ul>${alerts.map(a => `<li class="${a.severity}">${a.text}</li>`).join('')}</ul>`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────

function renderDashboard() {
  renderAlerts();

  const lastLab = state.labs[state.labs.length - 1];

  const egfrEl = document.getElementById('kpi-egfr-value');
  const egfrMeta = document.getElementById('kpi-egfr-meta');
  if (lastLab && lastLab.egfr != null) {
    const stg = egfrStage(lastLab.egfr);
    egfrEl.innerHTML = `${fmt.num(lastLab.egfr, 0)}<span class="stage-badge ${stg.cls}">${stg.label}</span>`;
    egfrEl.className = 'kpi-value ' + stg.color;
    egfrMeta.textContent = fmt.date(lastLab.date);
  } else {
    egfrEl.textContent = '—';
    egfrEl.className = 'kpi-value';
    egfrMeta.textContent = 'No labs entered';
  }

  document.getElementById('kpi-creat-value').textContent =
    lastLab && lastLab.creatinine != null ? fmt.num(lastLab.creatinine, 2) : '—';

  const kEl = document.getElementById('kpi-k-value');
  if (lastLab && lastLab.potassium != null) {
    kEl.textContent = fmt.num(lastLab.potassium, 1);
    const k = Number(lastLab.potassium);
    kEl.className = 'kpi-value ' + (k > 5.5 ? 'bad' : k > 5.0 ? 'warn' : 'good');
  } else {
    kEl.textContent = '—';
    kEl.className = 'kpi-value';
  }

  const lastBp = state.bp[state.bp.length - 1];
  const bpEl = document.getElementById('kpi-bp-value');
  const bpMeta = document.getElementById('kpi-bp-meta');
  if (lastBp) {
    bpEl.textContent = `${lastBp.systolic}/${lastBp.diastolic}`;
    const overTarget = lastBp.systolic > state.settings.bpSys || lastBp.diastolic > state.settings.bpDia;
    bpEl.className = 'kpi-value ' + (overTarget ? 'warn' : 'good');
    const avg = bpAverage(7);
    bpMeta.textContent = avg ? `7-day avg: ${avg.sys}/${avg.dia}` : `${state.bp.length} readings`;
  } else {
    bpEl.textContent = '—';
    bpEl.className = 'kpi-value';
    bpMeta.textContent = 'No readings';
  }

  renderDietBars(document.getElementById('dash-diet-bars'));
  renderEgfrTrend('dash-egfr-chart');

  const sympWrap = document.getElementById('dash-symptoms');
  const recent = state.symptoms.slice(-3).reverse();
  sympWrap.innerHTML = recent.length === 0
    ? 'No symptoms logged.'
    : recent.map(s =>
      `<div class="symptom-row">
        <span class="date">${fmt.date(s.date)}</span> ·
        Fatigue ${s.fatigue ?? '—'}, Swelling ${s.swelling || 'none'}, Sleep ${s.sleep ?? '—'}
        ${s.notes ? ' — ' + s.notes : ''}
      </div>`).join('');

  const medsWrap = document.getElementById('dash-meds');
  if (state.meds.length === 0) {
    medsWrap.textContent = 'No medications configured.';
  } else {
    const today = todayISO();
    const log = state.medLog[today] || {};
    const taken = state.meds.filter(m => log[m.id]).length;
    medsWrap.innerHTML = `<div class="kpi-meta">${taken} of ${state.meds.length} taken today</div>` +
      state.meds.slice(0, 5).map(m => `<div class="symptom-row">${m.name} ${m.dose || ''} <span class="date">${m.frequency || ''}</span></div>`).join('');
  }
}

function bpAverage(days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = state.bp.filter(b => new Date(b.datetime).getTime() >= cutoff);
  if (recent.length === 0) return null;
  return {
    sys: Math.round(recent.reduce((a, b) => a + Number(b.systolic), 0) / recent.length),
    dia: Math.round(recent.reduce((a, b) => a + Number(b.diastolic), 0) / recent.length),
    n: recent.length,
  };
}

function sumDietTotals(entries) {
  return entries.reduce((a, d) => {
    const s = Number(d.servings) || 1;
    a.calories   += (Number(d.calories) || 0) * s;
    a.carbs      += (Number(d.carbs) || 0) * s;
    a.fat        += (Number(d.fat) || 0) * s;
    a.fiber      += (Number(d.fiber) || 0) * s;
    a.protein    += (Number(d.protein) || 0) * s;
    a.sodium     += (Number(d.sodium) || 0) * s;
    a.potassium  += (Number(d.potassium) || 0) * s;
    a.phosphorus += (Number(d.phosphorus) || 0) * s;
    a.fluids     += (Number(d.fluids) || 0) * s;
    return a;
  }, { calories: 0, carbs: 0, fat: 0, fiber: 0, protein: 0, sodium: 0, potassium: 0, phosphorus: 0, fluids: 0 });
}

// ─── Steps tracking ──────────────────────────────────────────────────────
// `state.steps` is an array of { id, date, steps, source, time }.
//   - source='manual': additive (user logs +500 walking around)
//   - source='shortcut' or 'healthkit': CUMULATIVE for the day (Apple Watch
//     reports total day-so-far). When a sync arrives, we drop any existing
//     non-manual entries for that date and push the new authoritative value.
//   - For the day total: if any sync entry exists for the date, prefer the
//     highest sync value (latest cumulative); otherwise sum the manuals.
//     This way users can do quick manual logs early, then a single Apple
//     Watch sync rolls up everything without double-counting.
function totalStepsForDate(dateStr) {
  if (!Array.isArray(state.steps)) return 0;
  const dayEntries = state.steps.filter(s => s.date === dateStr);
  if (!dayEntries.length) return 0;
  const syncEntries = dayEntries.filter(s => s.source !== 'manual');
  if (syncEntries.length) {
    return Math.max(...syncEntries.map(s => Number(s.steps) || 0));
  }
  return dayEntries.reduce((sum, s) => sum + (Number(s.steps) || 0), 0);
}

// Current local time in YYYY-MM-DDTHH:MM, anchored to Phoenix tz (matches the
// format the BP datetime-local input uses).
function nowDatetimePhoenix() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PHOENIX_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

// Log a BP reading from an automation source. Idempotent for sync sources:
// if an entry already exists with the same datetime + sys + dia, returns it
// without adding a duplicate. Manual entries are always added.
function logBP({ systolic, diastolic, pulse, datetime, position, notes, source }) {
  const sys = Math.round(Number(systolic));
  const dia = Math.round(Number(diastolic));
  if (!Number.isFinite(sys) || sys <= 0) return null;
  if (!Number.isFinite(dia) || dia <= 0) return null;
  if (!Array.isArray(state.bp)) state.bp = [];
  const time = datetime || nowDatetimePhoenix();
  const isSync = source && source !== 'manual';
  if (isSync) {
    // Idempotency — sync runs (Shortcut, Apple Health import) often repeat the
    // same readings. Skip if same datetime + sys + dia already present.
    const dup = state.bp.find(e =>
      e.datetime === time &&
      Number(e.systolic) === sys &&
      Number(e.diastolic) === dia
    );
    if (dup) return dup;
  }
  const entry = {
    id: uid(),
    datetime: time,
    systolic: sys,
    diastolic: dia,
    pulse: Number.isFinite(Number(pulse)) ? Math.round(Number(pulse)) : null,
    position: position || 'seated',
    notes: notes || '',
    source: source || 'manual',
  };
  state.bp.push(entry);
  state.bp.sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
  return entry;
}

function logSteps(count, opts = {}) {
  count = Math.round(Number(count));
  if (!count || isNaN(count) || count < 0) return;
  const date = opts.date || todayISO();
  const source = opts.source || 'manual';
  if (!Array.isArray(state.steps)) state.steps = [];
  if (source !== 'manual') {
    // Drop earlier sync entries for this date; the new sync is authoritative.
    state.steps = state.steps.filter(s => !(s.date === date && s.source !== 'manual'));
  }
  state.steps.push({
    id: uid(),
    date,
    steps: count,
    source,
    time: new Date().toISOString(),
  });
  state.steps.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  save();
  if (!opts.skipRender) renderAll();
  return count;
}

// Render the dedicated Steps card on the Dashboard.
function renderStepsCard() {
  const today = todayISO();
  const total = totalStepsForDate(today);
  const target = state.settings.stepsTarget || 8000;
  const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
  const remaining = Math.max(0, target - total);

  const countEl = document.getElementById('steps-today-count');
  const targetEl = document.getElementById('steps-today-target');
  const barEl = document.getElementById('steps-today-bar');
  const remainEl = document.getElementById('steps-today-remaining');
  const statusEl = document.getElementById('steps-source-status');

  if (!countEl) return; // dashboard not rendered yet

  countEl.textContent = total.toLocaleString();
  if (targetEl) targetEl.textContent = target.toLocaleString();
  if (barEl) {
    barEl.style.width = pct + '%';
    barEl.className = 'steps-progress-fill' + (pct >= 100 ? ' done' : pct >= 50 ? ' mid' : '');
  }
  if (remainEl) {
    remainEl.textContent = pct >= 100
      ? `🎉 +${(total - target).toLocaleString()} over target`
      : `${remaining.toLocaleString()} steps to go`;
  }

  if (statusEl) {
    if (!Array.isArray(state.steps)) state.steps = [];
    const todays = state.steps.filter(s => s.date === today);
    if (!todays.length) {
      statusEl.innerHTML = '<span class="steps-source-empty">No entries yet today — quick-log below or sync from Apple Watch.</span>';
    } else {
      const sorted = [...todays].sort((a, b) => (b.time || '').localeCompare(a.time || ''));
      const latest = sorted[0];
      const srcLabel = latest.source === 'shortcut' ? 'Apple Watch (Shortcut)'
                     : latest.source === 'healthkit' ? 'Apple Health import'
                     : latest.source === 'url' ? 'URL sync'
                     : 'Manual';
      const manualCount = todays.filter(s => s.source === 'manual').length;
      const syncCount = todays.filter(s => s.source !== 'manual').length;
      const breakdown = syncCount
        ? `<span class="steps-tag steps-tag-sync">${syncCount} sync</span>`
        : '';
      const manuals = manualCount
        ? `<span class="steps-tag steps-tag-manual">${manualCount} manual</span>`
        : '';
      statusEl.innerHTML = `Latest: <strong>${Number(latest.steps).toLocaleString()}</strong> via ${escapeHtml(srcLabel)} · ${escapeHtml(phx.short(latest.time))} AZ ${breakdown} ${manuals}`;
    }
  }
}

function renderDietBars(container) {
  const today = todayISO();
  const todays = state.diet.filter(d => d.date === today);
  const totals = sumDietTotals(todays);
  const stepsToday = totalStepsForDate(today);

  // Steps treat "over target" as good (the more, the better) — invert the
  // color logic vs nutritional limits where over-target is a problem.
  const bars = [
    { key: 'calories',   label: 'Calories',   unit: 'kcal', target: state.settings.caloriesTarget,   value: totals.calories },
    { key: 'carbs',      label: 'Carbs',      unit: 'g',  target: state.settings.carbsTarget,      value: totals.carbs },
    { key: 'fat',        label: 'Fat',        unit: 'g',  target: state.settings.fatTarget,        value: totals.fat },
    { key: 'fiber',      label: 'Fiber',      unit: 'g',  target: state.settings.fiberTarget,      value: totals.fiber },
    { key: 'protein',    label: 'Protein',    unit: 'g',  target: state.settings.proteinTarget,    value: totals.protein },
    { key: 'sodium',     label: 'Sodium',     unit: 'mg', target: state.settings.sodiumTarget,     value: totals.sodium },
    { key: 'potassium',  label: 'Potassium',  unit: 'mg', target: state.settings.potassiumTarget,  value: totals.potassium },
    { key: 'phosphorus', label: 'Phosphorus', unit: 'mg', target: state.settings.phosphorusTarget, value: totals.phosphorus },
    { key: 'fluids',     label: 'Fluids',     unit: 'oz', target: state.settings.fluidTarget,      value: totals.fluids },
    { key: 'steps',      label: 'Steps',      unit: '',   target: state.settings.stepsTarget || 8000, value: stepsToday, invert: true },
  ];

  container.innerHTML = bars.map(b => {
    const pct = b.target > 0 ? Math.min(100, (b.value / b.target) * 100) : 0;
    let cls;
    if (b.invert) {
      cls = pct >= 100 ? '' : pct >= 50 ? 'warn' : 'bad';
    } else {
      cls = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
    }
    const displayValue = b.key === 'steps' ? Math.round(b.value).toLocaleString() : Math.round(b.value);
    const displayTarget = b.key === 'steps' ? Number(b.target).toLocaleString() : b.target;
    return `<div class="diet-bar">
      <div class="diet-bar-label">${b.label}</div>
      <div class="diet-bar-track"><div class="diet-bar-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="diet-bar-value">${displayValue} / ${displayTarget}${b.unit ? ' ' + b.unit : ''}</div>
    </div>`;
  }).join('');

  const todayLabel = document.getElementById('diet-today-label');
  if (todayLabel) todayLabel.textContent = phx.dateLong(today + 'T00:00:00-07:00');

  const actions = document.getElementById('today-totals-actions');
  if (actions) actions.hidden = todays.length === 0;
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateString(d);
}

function moveTodayEntriesToYesterday() {
  const today = todayISO();
  const yest = yesterdayISO();
  const todays = state.diet.filter(d => d.date === today);
  if (!todays.length) { flash('Nothing logged today.'); return; }
  if (!confirm(`Move all ${todays.length} entr${todays.length === 1 ? 'y' : 'ies'} currently dated today (${fmt.date(today)}) to yesterday (${fmt.date(yest)})?`)) return;
  for (const d of todays) d.date = yest;
  save();
  renderAll();
  flash(`Moved ${todays.length} entr${todays.length === 1 ? 'y' : 'ies'} to ${fmt.date(yest)}`);
}

function renderDietHistory() {
  const tbody = document.querySelector('#diet-history-table tbody');
  const detail = document.getElementById('diet-history-detail');
  const countEl = document.getElementById('diet-history-count');
  if (!tbody) return;

  const today = todayISO();
  // Group prior days; skip today (Today's Totals shows that).
  const byDate = {};
  for (const d of state.diet) {
    if (!d.date || d.date === today) continue;
    (byDate[d.date] = byDate[d.date] || []).push(d);
  }
  const dates = Object.keys(byDate).sort().reverse();

  // Collect all dates with either diet or step entries (skip today)
  const stepDays = new Set((state.steps || []).filter(s => s.date && s.date !== today).map(s => s.date));
  const allDates = new Set([...dates, ...stepDays]);
  const datesAll = [...allDates].sort().reverse();

  if (!datesAll.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted)">No previous days logged yet.</td></tr>`;
    if (detail) { detail.hidden = true; detail.innerHTML = ''; }
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = `${datesAll.length} day${datesAll.length === 1 ? '' : 's'}`;

  // Build per-day totals + over-target markers.
  const targets = {
    calories: state.settings.caloriesTarget,
    carbs: state.settings.carbsTarget,
    fat: state.settings.fatTarget,
    fiber: state.settings.fiberTarget,
    protein: state.settings.proteinTarget,
    sodium: state.settings.sodiumTarget,
    potassium: state.settings.potassiumTarget,
    phosphorus: state.settings.phosphorusTarget,
    fluids: state.settings.fluidTarget,
    steps: state.settings.stepsTarget || 8000,
  };
  const cell = (val, target, decimals = 0) => {
    const v = Math.round(val);
    const cls = target > 0 && val >= target ? 'warn' : '';
    return `<td class="${cls}">${decimals > 0 ? val.toFixed(decimals) : v}</td>`;
  };
  // Steps: hit-target is GOOD (not warn). Render with comma-thousands.
  const stepsCell = (val, target) => {
    const v = Math.round(val);
    const cls = target > 0 && val >= target ? 'good' : '';
    return `<td class="${cls}">${v.toLocaleString()}</td>`;
  };

  tbody.innerHTML = datesAll.map(date => {
    const dayDiet = byDate[date] || [];
    const t = sumDietTotals(dayDiet);
    const stepsT = totalStepsForDate(date);
    return `<tr data-history-date="${date}" style="cursor:pointer">
      <td>${fmt.date(date)}</td>
      ${cell(t.calories, targets.calories)}
      ${cell(t.carbs, targets.carbs)}
      ${cell(t.fat, targets.fat)}
      ${cell(t.fiber, targets.fiber)}
      ${cell(t.protein, targets.protein)}
      ${cell(t.sodium, targets.sodium)}
      ${cell(t.potassium, targets.potassium)}
      ${cell(t.phosphorus, targets.phosphorus)}
      ${cell(t.fluids, targets.fluids, 1)}
      ${stepsCell(stepsT, targets.steps)}
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-history-date]').forEach(tr => {
    tr.addEventListener('click', () => showDietHistoryDetail(tr.dataset.historyDate));
  });
}

function showDietHistoryDetail(date) {
  const detail = document.getElementById('diet-history-detail');
  if (!detail) return;
  const entries = state.diet.filter(d => d.date === date);
  if (!entries.length) { detail.hidden = true; detail.innerHTML = ''; return; }

  detail.hidden = false;
  detail.innerHTML = `
    <div class="card-row" style="margin-top:12px">
      <h4 style="margin:0">${fmt.date(date)} — entries</h4>
      <button class="secondary" id="btn-close-history-detail">Close</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Meal</th><th>Serv</th><th>Cal</th><th>Carb</th><th>Fat</th><th>Fib</th><th>Prot</th><th>Na</th><th>K</th><th>P</th><th>Fluids</th></tr></thead>
        <tbody>
          ${entries.map(d => `<tr>
            <td>${escapeHtml(d.item || '')}</td>
            <td>${escapeHtml(d.meal || '')}</td>
            <td>${fmt.num(d.servings, 2)}</td>
            <td>${fmt.num(d.calories, 0)}</td>
            <td>${fmt.num(d.carbs, 1)}</td>
            <td>${fmt.num(d.fat, 1)}</td>
            <td>${fmt.num(d.fiber, 1)}</td>
            <td>${fmt.num(d.protein, 1)}</td>
            <td>${fmt.num(d.sodium, 0)}</td>
            <td>${fmt.num(d.potassium, 0)}</td>
            <td>${fmt.num(d.phosphorus, 0)}</td>
            <td>${fmt.num(d.fluids, 1)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  const closeBtn = document.getElementById('btn-close-history-detail');
  if (closeBtn) closeBtn.addEventListener('click', () => { detail.hidden = true; detail.innerHTML = ''; });
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Schedule a re-render at next local midnight so Today's Totals reset and the
// previous day rolls into the history table automatically. Reschedules itself.
let midnightTimer = null;
function scheduleMidnightRefresh() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  midnightTimer = setTimeout(() => {
    renderAll();
    scheduleMidnightRefresh();
  }, next.getTime() - now.getTime());
}

// ─── Labs view ────────────────────────────────────────────────────────────

function renderLabs() {
  const tbody = document.querySelector('#labs-table tbody');
  const rows = [...state.labs].reverse();
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="12" style="text-align:center;color:var(--text-muted)">No labs yet.</td></tr>`
    : rows.map(l => {
      const stg = egfrStage(l.egfr);
      return `<tr>
        <td>${fmt.date(l.date)}</td>
        <td>${fmt.num(l.egfr, 0)}${stg ? ` <span class="stage-badge ${stg.cls}">${stg.label}</span>` : ''}</td>
        <td>${fmt.num(l.creatinine, 2)}</td>
        <td>${fmt.num(l.potassium, 1)}</td>
        <td>${fmt.num(l.phosphorus, 1)}</td>
        <td>${fmt.num(l.calcium, 1)}</td>
        <td>${fmt.num(l.hemoglobin, 1)}</td>
        <td>${fmt.num(l.albumin, 1)}</td>
        <td>${fmt.num(l.bicarbonate, 1)}</td>
        <td>${fmt.num(l.uacr, 0)}</td>
        <td>${fmt.num(l.bun, 0)}</td>
        <td><button class="icon" data-del-lab="${l.id}" title="Delete">×</button></td>
      </tr>`;
    }).join('');

  tbody.querySelectorAll('[data-del-lab]').forEach(b =>
    b.addEventListener('click', () => deleteFromList('labs', b.dataset.delLab)));

  renderLabChart('chart-egfr',  'egfr',        'eGFR');
  renderLabChart('chart-creat', 'creatinine',  'Creatinine');
  renderLabChart('chart-k',     'potassium',   'Potassium');
  renderLabChart('chart-p',     'phosphorus',  'Phosphorus');
  renderLabChart('chart-hgb',   'hemoglobin',  'Hemoglobin');
  renderLabChart('chart-uacr',  'uacr',        'UACR');
}

function renderLabChart(canvasId, field, label) {
  const points = state.labs
    .filter(l => l[field] != null && l[field] !== '')
    .map(l => ({ x: l.date, y: Number(l[field]) }));
  drawLineChart(canvasId, points, label);
}

function renderEgfrTrend(canvasId) {
  const points = state.labs
    .filter(l => l.egfr != null && l.egfr !== '')
    .map(l => ({ x: l.date, y: Number(l.egfr) }));
  drawLineChart(canvasId, points, 'eGFR');
}

function drawLineChart(canvasId, points, label) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (charts[canvasId]) charts[canvasId].destroy();

  charts[canvasId] = new Chart(el, {
    type: 'line',
    data: {
      labels: points.map(p => p.x),
      datasets: [{
        label,
        data: points.map(p => p.y),
        borderColor: '#0a6c8e',
        backgroundColor: 'rgba(10, 108, 142, 0.1)',
        tension: 0.2,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 11 } } },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
}

// ─── CSV import / export ──────────────────────────────────────────────────

const LAB_FIELDS = ['date','egfr','creatinine','bun','potassium','phosphorus','calcium','hemoglobin','albumin','bicarbonate','uacr','notes'];

const FIELD_PATTERNS = {
  date:        /date|drawn|collected|reported/i,
  egfr:        /e[\s-]?gfr|^gfr/i,
  creatinine:  /creat/i,
  bun:         /^\s*bun\b|urea[\s-]?nitrogen/i,
  potassium:   /potass|^k$|^k\s/i,
  phosphorus:  /phosph|^p$|^p\s/i,
  calcium:     /calc|^ca$|^ca\s/i,
  hemoglobin:  /hemo|hgb|hb\b/i,
  albumin:     /album/i,
  bicarbonate: /bicarb|hco3|^co2$|carbon\s+dioxide/i,
  uacr:        /uacr|micro[\s-]?alb|alb.*creat/i,
  notes:       /note|comment/i,
};

function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); field = '';
        if (cur.length > 1 || cur[0] !== '') rows.push(cur);
        cur = [];
      } else field += c;
    }
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(c => c !== ''));
}

function autoDetectMapping(headers) {
  const map = {};
  for (const field of LAB_FIELDS) {
    const idx = headers.findIndex(h => FIELD_PATTERNS[field] && FIELD_PATTERNS[field].test(h));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

function normalizeDateStr(s) {
  if (!s) return '';
  s = s.trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY or MM/DD/YYYY
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) {
    let [_, mo, d, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Try Date parser
  const dt = new Date(s);
  if (!isNaN(dt)) return dt.toISOString().slice(0, 10);
  return '';
}

let csvWorking = null; // { headers, rows, mapping }

document.getElementById('btn-csv-import').addEventListener('click', () => {
  document.getElementById('csv-file').click();
});

document.getElementById('csv-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const rows = parseCSV(ev.target.result);
      if (rows.length < 2) { alert('CSV needs a header row plus at least one data row.'); return; }
      const headers = rows[0].map(h => h.trim());
      const dataRows = rows.slice(1);
      const mapping = autoDetectMapping(headers);
      csvWorking = { headers, rows: dataRows, mapping };
      renderCsvPreview();
    } catch (err) {
      alert('Could not parse CSV: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function renderCsvPreview() {
  const wrap = document.getElementById('csv-preview');
  if (!csvWorking) { wrap.hidden = true; return; }
  const { headers, rows, mapping } = csvWorking;

  const mappingHtml = LAB_FIELDS.map(f => {
    const opts = ['<option value="-1">— ignore —</option>']
      .concat(headers.map((h, i) => `<option value="${i}" ${mapping[f] === i ? 'selected' : ''}>${escapeHtml(h)}</option>`));
    return `<label>${f}<select data-map-field="${f}">${opts.join('')}</select></label>`;
  }).join('');

  const previewRows = rows.slice(0, 5).map(r => {
    return '<tr>' + LAB_FIELDS.map(f => {
      const idx = mapping[f] != null ? mapping[f] : -1;
      const v = idx >= 0 ? (r[idx] || '') : '';
      return `<td>${escapeHtml(String(v))}</td>`;
    }).join('') + '</tr>';
  }).join('');

  wrap.hidden = false;
  wrap.innerHTML = `
    <h4>Column Mapping (${rows.length} rows detected)</h4>
    <div class="csv-mapping">${mappingHtml}</div>
    <div class="table-wrap"><table>
      <thead><tr>${LAB_FIELDS.map(f => `<th>${f}</th>`).join('')}</tr></thead>
      <tbody>${previewRows}</tbody>
    </table></div>
    <div class="row">
      <button id="btn-csv-confirm" class="primary">Import ${rows.length} Labs</button>
      <button id="btn-csv-cancel" class="secondary">Cancel</button>
    </div>
  `;

  wrap.querySelectorAll('[data-map-field]').forEach(sel => {
    sel.addEventListener('change', () => {
      const f = sel.dataset.mapField;
      const v = Number(sel.value);
      if (v < 0) delete csvWorking.mapping[f];
      else csvWorking.mapping[f] = v;
      renderCsvPreview();
    });
  });
  document.getElementById('btn-csv-confirm').addEventListener('click', confirmCsvImport);
  document.getElementById('btn-csv-cancel').addEventListener('click', () => {
    csvWorking = null;
    document.getElementById('csv-preview').hidden = true;
  });
}

function confirmCsvImport() {
  if (!csvWorking) return;
  const { rows, mapping } = csvWorking;
  if (mapping.date == null) { alert('Please map a date column before importing.'); return; }
  let added = 0, skipped = 0;
  for (const r of rows) {
    const lab = { id: uid() };
    const dateRaw = r[mapping.date];
    const dateIso = normalizeDateStr(dateRaw);
    if (!dateIso) { skipped++; continue; }
    lab.date = dateIso;
    let hasNumeric = false;
    for (const f of LAB_FIELDS) {
      if (f === 'date' || f === 'notes') continue;
      if (mapping[f] == null) continue;
      const raw = String(r[mapping[f]] || '').trim().replace(/[<>≤≥]/g, '').replace(/[^\d.\-]/g, '');
      if (raw === '' || isNaN(Number(raw))) continue;
      lab[f] = Number(raw);
      hasNumeric = true;
    }
    if (mapping.notes != null) lab.notes = String(r[mapping.notes] || '');
    if (!hasNumeric) { skipped++; continue; }
    state.labs.push(lab);
    added++;
  }
  state.labs.sort((a, b) => a.date.localeCompare(b.date));
  save();
  csvWorking = null;
  document.getElementById('csv-preview').hidden = true;
  flash(`Imported ${added} labs${skipped ? ` (${skipped} skipped)` : ''}`);
  renderAll();
}

document.getElementById('btn-csv-export').addEventListener('click', () => {
  if (state.labs.length === 0) { alert('No labs to export.'); return; }
  const headers = LAB_FIELDS;
  const lines = [headers.join(',')];
  for (const l of state.labs) {
    lines.push(headers.map(h => csvEscape(l[h] ?? '')).join(','));
  }
  download(`kidney-advisor-labs-${todayISO()}.csv`, lines.join('\n'), 'text/csv');
});

function csvEscape(v) {
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── BP view ──────────────────────────────────────────────────────────────

function renderBp() {
  const tbody = document.querySelector('#bp-table tbody');
  const rows = [...state.bp].reverse();
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No readings yet.</td></tr>`
    : rows.map(b => {
      const over = b.systolic > state.settings.bpSys || b.diastolic > state.settings.bpDia;
      return `<tr>
        <td>${fmt.dt(b.datetime)}</td>
        <td style="${over ? 'color:var(--bad);font-weight:600' : ''}">${b.systolic}</td>
        <td style="${over ? 'color:var(--bad);font-weight:600' : ''}">${b.diastolic}</td>
        <td>${b.pulse ?? '—'}</td>
        <td>${b.position || ''}</td>
        <td>${b.notes || ''}</td>
        <td><button class="icon" data-del-bp="${b.id}" title="Delete">×</button></td>
      </tr>`;
    }).join('');

  tbody.querySelectorAll('[data-del-bp]').forEach(btn =>
    btn.addEventListener('click', () => deleteFromList('bp', btn.dataset.delBp)));

  const points = state.bp.map(b => ({ x: b.datetime, sys: b.systolic, dia: b.diastolic }));
  if (charts['chart-bp']) charts['chart-bp'].destroy();
  const el = document.getElementById('chart-bp');
  if (el) {
    charts['chart-bp'] = new Chart(el, {
      type: 'line',
      data: {
        labels: points.map(p => fmt.dt(p.x)),
        datasets: [
          { label: 'Systolic',  data: points.map(p => p.sys), borderColor: '#c0392b', tension: 0.2, pointRadius: 3 },
          { label: 'Diastolic', data: points.map(p => p.dia), borderColor: '#0a6c8e', tension: 0.2, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: { ticks: { font: { size: 11 } } },
        },
      },
    });
  }

  const wrap = document.getElementById('bp-stats');
  const avg7  = bpAverage(7);
  const avg30 = bpAverage(30);
  const last  = state.bp[state.bp.length - 1];
  wrap.innerHTML = `
    <div><div class="bp-stat-label">Latest</div><div class="bp-stat-value">${last ? `${last.systolic}/${last.diastolic}` : '—'}</div></div>
    <div><div class="bp-stat-label">7-day avg</div><div class="bp-stat-value">${avg7 ? `${avg7.sys}/${avg7.dia}` : '—'}</div></div>
    <div><div class="bp-stat-label">30-day avg</div><div class="bp-stat-value">${avg30 ? `${avg30.sys}/${avg30.dia}` : '—'}</div></div>
    <div><div class="bp-stat-label">Target</div><div class="bp-stat-value">&lt;${state.settings.bpSys}/${state.settings.bpDia}</div></div>
  `;
}

// ─── Medications view ─────────────────────────────────────────────────────

function renderMeds() {
  const tbody = document.querySelector('#meds-table tbody');
  tbody.innerHTML = state.meds.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No medications yet.</td></tr>`
    : state.meds.map(m => {
      let refillStr = '';
      if (m.refill) {
        const days = Math.floor((new Date(m.refill) - new Date()) / (24 * 3600 * 1000));
        const cls = days < 0 ? 'bad' : days < 7 ? 'warn' : '';
        refillStr = `<span class="${cls ? 'kpi-value ' + cls : ''}" style="font-size:13px">${fmt.date(m.refill)} (${days < 0 ? `${-days}d overdue` : `${days}d left`})</span>`;
      }
      return `<tr>
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td>${escapeHtml(m.dose || '')}</td>
        <td>${escapeHtml(m.frequency || '')}</td>
        <td>${escapeHtml(m.time || '')}</td>
        <td>${escapeHtml(m.reason || '')}</td>
        <td>${refillStr}</td>
        <td><button class="icon" data-del-med="${m.id}" title="Delete">×</button></td>
      </tr>`;
    }).join('');

  tbody.querySelectorAll('[data-del-med]').forEach(b =>
    b.addEventListener('click', () => deleteMed(b.dataset.delMed)));

  const today = todayISO();
  if (!state.medLog[today]) state.medLog[today] = {};
  const log = state.medLog[today];

  const checklist = document.getElementById('med-checklist');
  checklist.innerHTML = state.meds.length === 0
    ? '<div style="color:var(--text-muted)">Add medications to enable the daily checklist.</div>'
    : state.meds.map(m => `
      <label class="med-check-row">
        <input type="checkbox" data-med-check="${m.id}" ${log[m.id] ? 'checked' : ''} />
        <div>
          <div class="med-check-name">${escapeHtml(m.name)} ${m.dose ? `<span class="med-check-meta">(${escapeHtml(m.dose)})</span>` : ''}</div>
          <div class="med-check-meta">${escapeHtml(m.frequency || '')} ${m.time ? '· ' + escapeHtml(m.time) : ''}</div>
        </div>
      </label>
    `).join('');

  checklist.querySelectorAll('[data-med-check]').forEach(cb => {
    cb.addEventListener('change', () => {
      state.medLog[today][cb.dataset.medCheck] = cb.checked;
      save();
      renderDashboard();
    });
  });
}

// ─── Diet view ────────────────────────────────────────────────────────────

function renderFoodResults(query = '') {
  const wrap = document.getElementById('food-results');
  const q = query.trim().toLowerCase();
  let items = window.FOOD_DB || [];
  if (q) items = items.filter(f => f.name.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q));
  items = items.slice(0, 60);
  wrap.innerHTML = items.length === 0
    ? '<div style="color:var(--text-muted);padding:10px">No matches.</div>'
    : items.map((f, i) => {
      const tags = (f.tags || []).map(t => `<span class="food-tag tag-${t}">${t}</span>`).join(' ');
      return `<div class="food-card" data-food-idx="${window.FOOD_DB.indexOf(f)}">
        <div class="name">${escapeHtml(f.name)} ${tags}</div>
        <div class="serving">${escapeHtml(f.serving)} · ${f.cat}</div>
        <div class="stats">
          Na ${f.sodium}mg · K ${f.potassium}mg · P ${f.phosphorus}mg · Pro ${f.protein}g${f.fluids ? ' · '+f.fluids+'oz' : ''}
        </div>
      </div>`;
    }).join('');

  wrap.querySelectorAll('[data-food-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const f = window.FOOD_DB[Number(card.dataset.foodIdx)];
      const servings = parseFloat(prompt(`Servings of ${f.name}? (${f.serving})`, '1'));
      if (!servings || isNaN(servings) || servings <= 0) return;
      state.diet.push({
        id: uid(),
        date: todayISO(),
        item: f.name,
        servings,
        sodium: f.sodium,
        potassium: f.potassium,
        phosphorus: f.phosphorus,
        protein: f.protein,
        fluids: f.fluids,
      });
      save();
      flash(`Added ${f.name}`);
      renderAll();
    });
  });
}

document.getElementById('food-search').addEventListener('input', e => {
  renderFoodResults(e.target.value);
  const clear = document.getElementById('food-search-clear');
  if (clear) clear.hidden = !e.target.value;
});

// ─── My Foods: autofill + quick re-add from previously logged entries ────
// Derived live from state.diet (no separate registry). Keys by normalized
// item name, snapshot is most-recent nutrient values, with use-count.

const MY_FOODS_FIELDS = ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus','fluids'];
const normMyFood = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function getMyFoods() {
  const map = new Map();
  for (const e of state.diet || []) {
    const item = (e.item || '').trim();
    if (!item) continue;
    if (normMyFood(item) === 'water') continue; // already covered by Quick Water Log
    const key = normMyFood(item);
    const existing = map.get(key);
    const date = e.date || '';
    if (!existing || date >= (existing.lastDate || '')) {
      const snapshot = {
        item,
        lastDate: date,
        count: (existing ? existing.count : 0) + 1,
      };
      for (const f of MY_FOODS_FIELDS) {
        if (e[f] != null && !isNaN(Number(e[f]))) snapshot[f] = Number(e[f]);
      }
      map.set(key, snapshot);
    } else {
      existing.count += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const d = (b.lastDate || '').localeCompare(a.lastDate || '');
    return d !== 0 ? d : b.count - a.count;
  });
}

function renderMyFoodsCard(query) {
  const card = document.getElementById('my-foods-card');
  const wrap = document.getElementById('my-foods-results');
  if (!card || !wrap) return;
  const all = getMyFoods();
  if (all.length === 0) { card.hidden = true; wrap.innerHTML = ''; return; }
  card.hidden = false;
  const q = (query || '').trim().toLowerCase();
  const items = q
    ? all.filter(f => f.item.toLowerCase().includes(q))
    : all.slice(0, 24);
  if (items.length === 0) {
    wrap.innerHTML = '<div style="color:var(--text-muted);padding:10px">No matches.</div>';
    return;
  }
  wrap.innerHTML = items.map((f, i) => {
    const parts = [];
    if (f.calories != null) parts.push(`${Math.round(f.calories)} kcal`);
    if (f.sodium != null) parts.push(`Na ${Math.round(f.sodium)}mg`);
    if (f.potassium != null) parts.push(`K ${Math.round(f.potassium)}mg`);
    if (f.phosphorus != null) parts.push(`P ${Math.round(f.phosphorus)}mg`);
    if (f.protein != null) parts.push(`Pro ${f.protein}g`);
    if (f.fluids != null) parts.push(`${f.fluids}oz`);
    const stats = parts.length ? parts.join(' · ') : '<em>no saved nutrients</em>';
    const meta = [f.lastDate ? `Last ${escapeHtml(f.lastDate)}` : null, `${f.count}× logged`]
      .filter(Boolean).join(' · ');
    return `<div class="food-card" data-my-food-idx="${i}">
      <div class="name">${escapeHtml(f.item)}</div>
      <div class="serving">${meta}</div>
      <div class="stats">${stats}</div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-my-food-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const f = items[Number(el.dataset.myFoodIdx)];
      const servings = parseFloat(prompt(`Servings of ${f.item}?`, '1'));
      if (!servings || isNaN(servings) || servings <= 0) return;
      const entry = { id: uid(), date: todayISO(), item: f.item, servings };
      for (const k of MY_FOODS_FIELDS) {
        if (f[k] != null) entry[k] = f[k];
      }
      state.diet.push(entry);
      state.diet.sort((a, b) => a.date.localeCompare(b.date));
      save();
      flash(`Added ${f.item} × ${servings}`);
      renderAll();
    });
  });
}

function renderMyFoodsDatalist() {
  const dl = document.getElementById('my-foods-list');
  if (!dl) return;
  const all = getMyFoods();
  dl.innerHTML = all.slice(0, 250)
    .map(f => `<option value="${escapeHtml(f.item).replace(/"/g, '&quot;')}"></option>`)
    .join('');
}

function refreshMyFoods() {
  const input = document.getElementById('my-foods-search');
  renderMyFoodsCard(input ? input.value : '');
  renderMyFoodsDatalist();
}

function autofillDietFormFromName(name) {
  const norm = normMyFood(name);
  if (!norm) return;
  const match = getMyFoods().find(f => normMyFood(f.item) === norm);
  if (!match) return;
  const form = document.getElementById('diet-form');
  if (!form) return;
  for (const k of MY_FOODS_FIELDS) {
    const input = form.elements[k];
    if (input && !input.value && match[k] != null) {
      input.value = match[k];
    }
  }
}

document.querySelector('#diet-form [name=item]')?.addEventListener('input', e => {
  autofillDietFormFromName(e.target.value);
});
document.querySelector('#diet-form [name=item]')?.addEventListener('change', e => {
  autofillDietFormFromName(e.target.value);
});

document.getElementById('my-foods-search')?.addEventListener('input', e => {
  renderMyFoodsCard(e.target.value);
  updateSearchClearVisibility('my-foods-search', 'my-foods-search-clear');
});
document.getElementById('my-foods-search-clear')?.addEventListener('click', () => {
  const input = document.getElementById('my-foods-search');
  if (!input) return;
  input.value = '';
  input.focus();
  renderMyFoodsCard('');
  updateSearchClearVisibility('my-foods-search', 'my-foods-search-clear');
});

// ─── USDA FoodData Central search ────────────────────────────────────────

const USDA_KEY_STORAGE = 'kidney-advisor-usda';
function loadUSDAKey() {
  try { return JSON.parse(localStorage.getItem(USDA_KEY_STORAGE) || '{}').apiKey || ''; }
  catch { return ''; }
}
function saveUSDAKey(k) {
  localStorage.setItem(USDA_KEY_STORAGE, JSON.stringify({ apiKey: k || '' }));
}

function usdaNutrientById(food, id) {
  const n = (food.foodNutrients || []).find(x => x.nutrientId === id);
  return n && typeof n.value === 'number' ? n.value : null;
}

function extractUSDANutrients(food) {
  // Prefer labelNutrients (per serving) for Branded; otherwise per 100g from foodNutrients
  if (food.labelNutrients && food.labelNutrients.calories) {
    const ln = food.labelNutrients;
    const v = key => (ln[key] && typeof ln[key].value === 'number') ? ln[key].value : null;
    return {
      perServing: true,
      servingText: food.householdServingFullText || (food.servingSize ? `${food.servingSize} ${food.servingSizeUnit || ''}`.trim() : 'per serving'),
      calories: v('calories'),
      protein: v('protein'),
      carbs: v('carbohydrates'),
      fat: v('fat'),
      fiber: v('fiber'),
      sodium: v('sodium'),
      potassium: v('potassium'),
      phosphorus: v('phosphorus'),
    };
  }
  return {
    perServing: false,
    servingText: '100 g',
    calories: usdaNutrientById(food, 1008),
    protein: usdaNutrientById(food, 1003),
    fat: usdaNutrientById(food, 1004),
    carbs: usdaNutrientById(food, 1005),
    fiber: usdaNutrientById(food, 1079),
    sodium: usdaNutrientById(food, 1093),
    potassium: usdaNutrientById(food, 1092),
    phosphorus: usdaNutrientById(food, 1091),
  };
}

let usdaSearchTimer = null;
let usdaLastResults = [];
let offLastResults = [];

function setResultsSectionVisibility() {
  const usdaSection = document.getElementById('usda-section');
  const offSection = document.getElementById('off-section');
  if (usdaSection) usdaSection.hidden = !usdaLastResults.length && !usdaSection.dataset.loading;
  if (offSection) offSection.hidden = !offLastResults.length && !offSection.dataset.loading;
}

async function searchUSDA(query) {
  const wrap = document.getElementById('usda-results');
  const section = document.getElementById('usda-section');
  // Surface kidney-friendly restaurant picks above the USDA results when the
  // query names a chain we recognize. Runs in parallel with the USDA fetch.
  renderRestaurantSuggestions(detectRestaurant(query));
  if (!query || query.trim().length < 2) {
    wrap.innerHTML = '';
    usdaLastResults = [];
    if (section) { section.hidden = true; delete section.dataset.loading; }
    return;
  }
  if (section) { section.hidden = false; section.dataset.loading = '1'; }
  wrap.innerHTML = '<div class="results-loading"><span class="advisor-spinner"></span>Searching USDA…</div>';

  const apiKey = loadUSDAKey() || 'DEMO_KEY';
  // Build URL with URLSearchParams; use repeated dataType params to avoid the
  // parentheses-in-comma-list problem. GET avoids CORS preflight entirely.
  const params = new URLSearchParams();
  params.set('api_key', apiKey);
  params.set('query', query.trim());
  params.set('pageSize', '25');
  for (const dt of ['Branded', 'Foundation', 'SR Legacy']) {
    params.append('dataType', dt);
  }
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isJson = ct.includes('json');

    // USDA sometimes 200's a redirect to its Angular portal site when the
    // demo key is throttled or the API is briefly unavailable. Body is then
    // HTML, not JSON. Treat any non-JSON response as a soft rate-limit so
    // the user gets the actionable "get your own key" UI instead of a wall
    // of HTML in the error toast.
    if (!res.ok || !isJson) {
      let msg = `${res.status} ${res.statusText}`;
      let body = '';
      try { body = await res.text(); } catch {}
      const looksHtml = /^\s*<(?:!doctype|html|\?xml)/i.test(body);

      if (looksHtml) {
        throw Object.assign(
          new Error('USDA returned a web page instead of JSON — typically the shared demo key is throttled, or USDA briefly routed API traffic to their portal site. Get a free personal key for a 1,000/hour quota.'),
          { _rateLimit: true }
        );
      }
      // Try JSON-shaped error body
      try {
        const j = JSON.parse(body);
        if (j.error && j.error.message) msg = j.error.message;
        else if (j.message) msg = j.message;
      } catch {
        if (body) msg = body.slice(0, 200);
      }
      if (res.status === 429) {
        throw Object.assign(new Error('USDA rate limit hit. Get your own free key at fdc.nal.usda.gov/api-key-signup.html — adds 1000 requests/hour. Then paste it into Settings → USDA Food Database.'), { _rateLimit: true });
      }
      if (res.status === 403) msg = 'API key rejected (403). Check your key in Settings → USDA Food Database, or clear the field to use the shared demo key.';
      throw new Error(msg);
    }
    const data = await res.json();
    usdaLastResults = data.foods || [];
    renderUSDAResults(usdaLastResults);
  } catch (err) {
    clearTimeout(timeoutId);
    let display = err.message || String(err);
    let isRateLimit = !!err._rateLimit;
    if (err.name === 'AbortError') {
      display = 'Request timed out after 15 seconds. USDA may be slow or your connection was interrupted — try again.';
    } else if (display === 'Failed to fetch' || display.startsWith('NetworkError')) {
      display = 'Could not reach USDA (network or browser block). Common causes: offline, VPN/proxy interference, ad blocker, or corporate firewall blocking api.nal.usda.gov. Try again, disable extensions, or check your connection.';
    } else if (display.includes('rate limit') || display.includes('OVER_RATE_LIMIT') || display.includes('429')) {
      isRateLimit = true;
    }

    if (isRateLimit) {
      wrap.innerHTML = `
        <div style="padding:14px;background:#fff3cd;border:1px solid #ffe69c;border-radius:6px;color:#664d03">
          <strong>USDA rate limit hit</strong> — the shared demo key is throttled (~30 searches/hour across all users).
          <p style="margin:8px 0">Get your own free key in 30 seconds — no credit card. It bumps you to <strong>1,000 searches/hour</strong>.</p>
          <ol style="margin:8px 0 12px 20px">
            <li><a href="https://fdc.nal.usda.gov/api-key-signup.html" target="_blank" style="color:#0a6c8e;font-weight:600">Click here to sign up</a> — name + email only</li>
            <li>Check your email for a key starting with letters/numbers (no <code>sk-</code> prefix, just a long string)</li>
            <li>Paste it below and click Save</li>
          </ol>
          <form id="usda-key-inline-form" class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
            <input type="password" id="usda-key-inline-input" placeholder="Paste USDA API key here" autocomplete="off" style="flex:1;min-width:240px;padding:6px 10px;border:1px solid #ccc;border-radius:4px" />
            <button type="submit" class="primary">Save & Retry Search</button>
          </form>
        </div>`;
      const inlineForm = document.getElementById('usda-key-inline-form');
      if (inlineForm) {
        inlineForm.addEventListener('submit', ev => {
          ev.preventDefault();
          const newKey = document.getElementById('usda-key-inline-input').value.trim();
          if (!newKey) { alert('Paste your USDA key first.'); return; }
          saveUSDAKey(newKey);
          // Also update Settings field if it's already in the DOM
          const settingsField = document.querySelector('#usda-key-form input[name="usdaKey"]');
          if (settingsField) settingsField.value = newKey;
          flash('USDA key saved — retrying search…');
          searchUSDA(query);
        });
      }
    } else {
      wrap.innerHTML = `<div style="padding:10px;color:var(--bad)">Search failed: ${escapeHtml(display)}</div>`;
    }
  }
}

function renderUSDAResults(foods) {
  const wrap = document.getElementById('usda-results');
  const section = document.getElementById('usda-section');
  const countEl = document.getElementById('usda-count');
  if (section) delete section.dataset.loading;
  if (countEl) countEl.textContent = foods.length ? `${foods.length} result${foods.length === 1 ? '' : 's'}` : '';
  if (!foods.length) {
    wrap.innerHTML = '<div class="results-empty">No matches in USDA. Check Open Food Facts results below, or try a simpler query.</div>';
    if (section) section.hidden = false;
    return;
  }
  const servingOptions = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  wrap.innerHTML = foods.map((f, i) => {
    const n = extractUSDANutrients(f);
    const brand = f.brandOwner || f.brandName || '';
    const desc = f.description || '';
    const calPer = n.calories != null ? Math.round(n.calories) : null;
    const cal = calPer != null ? `${calPer} kcal` : '— kcal';
    const macros = [
      n.protein != null ? `P ${n.protein.toFixed(1)}g` : null,
      n.carbs != null ? `C ${n.carbs.toFixed(1)}g` : null,
      n.fat != null ? `F ${n.fat.toFixed(1)}g` : null,
      n.fiber != null ? `Fib ${n.fiber.toFixed(1)}g` : null,
    ].filter(Boolean).join(' · ');
    const kidney = [
      n.sodium != null ? `Na ${Math.round(n.sodium)}mg` : null,
      n.potassium != null ? `K ${Math.round(n.potassium)}mg` : null,
      n.phosphorus != null ? `P ${Math.round(n.phosphorus)}mg` : null,
    ].filter(Boolean).join(' · ');

    const options = servingOptions.map(opt => {
      const label = opt === 0.25 ? '1/4' : opt === 0.5 ? '1/2' : opt === 0.75 ? '3/4' : String(opt);
      const kcal = calPer != null ? ` — ${Math.round(calPer * opt)} kcal` : '';
      const selected = opt === 1 ? ' selected' : '';
      return `<option value="${opt}"${selected}>${label} serving${opt === 1 ? '' : 's'}${kcal}</option>`;
    }).join('');

    return `<div class="food-card" data-usda-idx="${i}">
      <div class="name">${escapeHtml(desc)}${brand ? ` <span class="food-tag" style="background:#eef;color:#338">${escapeHtml(brand)}</span>` : ''}</div>
      <div class="serving">Per ${escapeHtml(n.servingText)} · ${cal}${macros ? ' · ' + macros : ''}</div>
      ${kidney ? `<div class="stats">${kidney}</div>` : ''}
      <div class="row" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <label style="margin:0;font-size:13px">Servings
          <select class="usda-serving-select" data-usda-idx="${i}" style="margin-left:6px">
            ${options}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <input type="number" class="usda-serving-custom" data-usda-idx="${i}" step="0.05" min="0.05" placeholder="e.g. 1.25" style="width:90px;display:none" />
        <span class="usda-serving-preview hint" data-usda-idx="${i}" style="margin:0">${calPer != null ? Math.round(calPer) + ' kcal' : ''}</span>
        <button type="button" class="primary usda-add-btn" data-usda-idx="${i}" style="margin-left:auto">Add</button>
      </div>
    </div>`;
  }).join('');

  function readServings(idx) {
    const sel = wrap.querySelector(`.usda-serving-select[data-usda-idx="${idx}"]`);
    const custom = wrap.querySelector(`.usda-serving-custom[data-usda-idx="${idx}"]`);
    if (!sel) return 1;
    if (sel.value === 'custom') {
      const v = parseFloat(custom && custom.value);
      return v > 0 ? v : null;
    }
    return parseFloat(sel.value) || 1;
  }

  function updatePreview(idx) {
    const food = usdaLastResults[Number(idx)];
    const preview = wrap.querySelector(`.usda-serving-preview[data-usda-idx="${idx}"]`);
    if (!food || !preview) return;
    const n = extractUSDANutrients(food);
    const s = readServings(idx);
    if (s == null) { preview.textContent = 'Enter a custom amount'; return; }
    const parts = [];
    if (n.calories != null) parts.push(`${Math.round(n.calories * s)} kcal`);
    if (n.sodium != null) parts.push(`Na ${Math.round(n.sodium * s)}mg`);
    if (n.potassium != null) parts.push(`K ${Math.round(n.potassium * s)}mg`);
    preview.textContent = parts.join(' · ');
  }

  wrap.querySelectorAll('.usda-serving-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = sel.dataset.usdaIdx;
      const custom = wrap.querySelector(`.usda-serving-custom[data-usda-idx="${idx}"]`);
      if (sel.value === 'custom') {
        if (custom) { custom.style.display = ''; custom.focus(); }
      } else {
        if (custom) { custom.style.display = 'none'; }
      }
      updatePreview(idx);
      e.stopPropagation();
    });
  });

  wrap.querySelectorAll('.usda-serving-custom').forEach(input => {
    input.addEventListener('input', e => {
      updatePreview(input.dataset.usdaIdx);
      e.stopPropagation();
    });
    input.addEventListener('click', e => e.stopPropagation());
  });

  wrap.querySelectorAll('.usda-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = btn.dataset.usdaIdx;
      const food = usdaLastResults[Number(idx)];
      if (!food) return;
      const servings = readServings(idx);
      if (!servings || isNaN(servings) || servings <= 0) {
        alert('Enter a serving amount greater than 0.');
        return;
      }
      const n = extractUSDANutrients(food);
      const entry = { id: uid(), date: todayISO(), item: food.description, servings };
      for (const f of ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus']) {
        if (n[f] != null) entry[f] = n[f];
      }
      state.diet.push(entry);
      save();
      flash(`Added ${food.description} × ${servings}`);
      renderAll();
    });
  });
}

// ─── Open Food Facts search (secondary source) ───────────────────────────
// Supplements USDA. OFF has stronger international + grocery branded coverage;
// USDA has stronger restaurant + USDA-tested staples. Fetch in parallel.

let offSearchTimer = null;

async function searchOpenFoodFacts(query) {
  const wrap = document.getElementById('off-results');
  const section = document.getElementById('off-section');
  const countEl = document.getElementById('off-count');
  if (!wrap) return;
  if (!query || query.trim().length < 2) {
    wrap.innerHTML = '';
    offLastResults = [];
    if (section) { section.hidden = true; delete section.dataset.loading; }
    return;
  }
  if (section) { section.hidden = false; section.dataset.loading = '1'; }
  wrap.innerHTML = '<div class="results-loading"><span class="advisor-spinner"></span>Searching Open Food Facts…</div>';
  if (countEl) countEl.textContent = '';

  const params = new URLSearchParams();
  params.set('search_terms', query.trim());
  params.set('search_simple', '1');
  params.set('action', 'process');
  params.set('json', '1');
  params.set('page_size', '20');
  params.set('fields', 'code,product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,quantity,image_front_small_url');
  const url = `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
    // Same guard as USDA: a non-JSON body usually means a maintenance/portal page.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      const peek = (await res.text()).slice(0, 60);
      throw new Error(`Open Food Facts returned a non-JSON response (peek: ${peek.replace(/[\r\n]+/g, ' ')}…)`);
    }
    const data = await res.json();
    const raw = Array.isArray(data.products) ? data.products : [];
    // Filter to products that have at least a name and at least one nutrient
    offLastResults = raw.filter(p => {
      if (!(p.product_name || p.product_name_en)) return false;
      const n = p.nutriments || {};
      return n['energy-kcal_100g'] != null || n['energy-kcal_serving'] != null ||
             n['proteins_100g'] != null || n['carbohydrates_100g'] != null;
    });
    renderOffResults(offLastResults);
  } catch (err) {
    clearTimeout(timeoutId);
    if (section) delete section.dataset.loading;
    let display = err.message || String(err);
    if (err.name === 'AbortError') display = 'Open Food Facts timed out after 15 seconds.';
    else if (display === 'Failed to fetch' || display.startsWith('NetworkError')) {
      display = 'Could not reach Open Food Facts. Skip and use USDA results.';
    }
    wrap.innerHTML = `<div class="results-empty" style="color:var(--bad)">Open Food Facts: ${escapeHtml(display)}</div>`;
  }
}

function renderOffResults(products) {
  const wrap = document.getElementById('off-results');
  const section = document.getElementById('off-section');
  const countEl = document.getElementById('off-count');
  if (section) delete section.dataset.loading;
  if (countEl) countEl.textContent = products.length ? `${products.length} result${products.length === 1 ? '' : 's'}` : '';
  if (!products.length) {
    wrap.innerHTML = '<div class="results-empty">No matches in Open Food Facts.</div>';
    if (section) section.hidden = false;
    return;
  }
  const servingOptions = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  wrap.innerHTML = products.map((p, i) => {
    const n = extractOffNutrients(p);
    const name = p.product_name || p.product_name_en || 'Unknown product';
    const brand = p.brands || '';
    const calPer = n.calories != null ? Math.round(n.calories) : null;
    const cal = calPer != null ? `${calPer} kcal` : '— kcal';
    const macros = [
      n.protein != null ? `P ${n.protein.toFixed(1)}g` : null,
      n.carbs != null ? `C ${n.carbs.toFixed(1)}g` : null,
      n.fat != null ? `F ${n.fat.toFixed(1)}g` : null,
      n.fiber != null ? `Fib ${n.fiber.toFixed(1)}g` : null,
    ].filter(Boolean).join(' · ');
    const kidney = [
      n.sodium != null ? `Na ${Math.round(n.sodium)}mg` : null,
      n.potassium != null ? `K ${Math.round(n.potassium)}mg` : null,
      n.phosphorus != null ? `P ${Math.round(n.phosphorus)}mg` : null,
    ].filter(Boolean).join(' · ');

    const options = servingOptions.map(opt => {
      const label = opt === 0.25 ? '1/4' : opt === 0.5 ? '1/2' : opt === 0.75 ? '3/4' : String(opt);
      const kcal = calPer != null ? ` — ${Math.round(calPer * opt)} kcal` : '';
      const selected = opt === 1 ? ' selected' : '';
      return `<option value="${opt}"${selected}>${label} serving${opt === 1 ? '' : 's'}${kcal}</option>`;
    }).join('');

    const imgHtml = p.image_front_small_url
      ? `<img src="${escapeHtml(p.image_front_small_url)}" alt="" loading="lazy" class="off-thumb" />`
      : '';

    return `<div class="food-card off-card" data-off-idx="${i}">
      ${imgHtml}
      <div class="name">${escapeHtml(name)}${brand ? ` <span class="food-tag tag-brand">${escapeHtml(brand)}</span>` : ''}</div>
      <div class="serving">Per ${escapeHtml(n.servingText)} · ${cal}${macros ? ' · ' + macros : ''}</div>
      ${kidney ? `<div class="stats">${kidney}</div>` : ''}
      <div class="row" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <label style="margin:0;font-size:13px">Servings
          <select class="off-serving-select" data-off-idx="${i}" style="margin-left:6px">
            ${options}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <input type="number" class="off-serving-custom" data-off-idx="${i}" step="0.05" min="0.05" placeholder="e.g. 1.25" style="width:90px;display:none" />
        <span class="off-serving-preview hint" data-off-idx="${i}" style="margin:0">${calPer != null ? Math.round(calPer) + ' kcal' : ''}</span>
        <button type="button" class="primary off-add-btn" data-off-idx="${i}" style="margin-left:auto">Add</button>
      </div>
    </div>`;
  }).join('');

  function readServings(idx) {
    const sel = wrap.querySelector(`.off-serving-select[data-off-idx="${idx}"]`);
    const custom = wrap.querySelector(`.off-serving-custom[data-off-idx="${idx}"]`);
    if (!sel) return 1;
    if (sel.value === 'custom') {
      const v = parseFloat(custom && custom.value);
      return v > 0 ? v : null;
    }
    return parseFloat(sel.value) || 1;
  }

  function updatePreview(idx) {
    const prod = offLastResults[Number(idx)];
    const preview = wrap.querySelector(`.off-serving-preview[data-off-idx="${idx}"]`);
    if (!prod || !preview) return;
    const n = extractOffNutrients(prod);
    const s = readServings(idx);
    if (s == null) { preview.textContent = 'Enter a custom amount'; return; }
    const parts = [];
    if (n.calories != null) parts.push(`${Math.round(n.calories * s)} kcal`);
    if (n.sodium != null) parts.push(`Na ${Math.round(n.sodium * s)}mg`);
    if (n.potassium != null) parts.push(`K ${Math.round(n.potassium * s)}mg`);
    preview.textContent = parts.join(' · ');
  }

  wrap.querySelectorAll('.off-serving-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = sel.dataset.offIdx;
      const custom = wrap.querySelector(`.off-serving-custom[data-off-idx="${idx}"]`);
      if (sel.value === 'custom') {
        if (custom) { custom.style.display = ''; custom.focus(); }
      } else {
        if (custom) { custom.style.display = 'none'; }
      }
      updatePreview(idx);
      e.stopPropagation();
    });
  });

  wrap.querySelectorAll('.off-serving-custom').forEach(input => {
    input.addEventListener('input', e => {
      updatePreview(input.dataset.offIdx);
      e.stopPropagation();
    });
    input.addEventListener('click', e => e.stopPropagation());
  });

  wrap.querySelectorAll('.off-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = btn.dataset.offIdx;
      const prod = offLastResults[Number(idx)];
      if (!prod) return;
      const servings = readServings(idx);
      if (!servings || isNaN(servings) || servings <= 0) {
        alert('Enter a serving amount greater than 0.');
        return;
      }
      const n = extractOffNutrients(prod);
      const name = prod.product_name || prod.product_name_en || 'Unknown product';
      const entry = { id: uid(), date: todayISO(), item: name, servings };
      for (const f of ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus']) {
        if (n[f] != null) entry[f] = n[f];
      }
      state.diet.push(entry);
      save();
      flash(`Added ${name} × ${servings}`);
      renderAll();
    });
  });
}

// ─── Nutritionix search (third source) ────────────────────────────────────
// Branded + restaurant catalog. Free tier: 200 lookups/day with email signup.
// Instant search returns name + brand + calories only — full nutrients
// (Na/K/P) are fetched on Add via /v2/search/item (branded) or
// /v2/natural/nutrients (common). Two API calls per add: search + hydrate.

const NUTRITIONIX_KEY_STORAGE = 'kidney-advisor-nutritionix';
const NUTRITIONIX_BASE = 'https://trackapi.nutritionix.com/v2';
// Nutritionix uses USDA attr_ids inside full_nutrients[]:
//   208=cal 203=protein 204=fat 205=carbs 269=sugar 291=fiber
//   307=sodium 306=potassium 305=phosphorus
const NIX_ATTR = { calories: 208, protein: 203, fat: 204, carbs: 205, fiber: 291, sodium: 307, potassium: 306, phosphorus: 305 };

function loadNutritionixCreds() {
  try {
    const s = JSON.parse(localStorage.getItem(NUTRITIONIX_KEY_STORAGE) || '{}');
    return { appId: s.appId || '', appKey: s.appKey || '' };
  } catch { return { appId: '', appKey: '' }; }
}
function saveNutritionixCreds(appId, appKey) {
  localStorage.setItem(NUTRITIONIX_KEY_STORAGE, JSON.stringify({ appId: appId || '', appKey: appKey || '' }));
}
function hasNutritionixCreds() {
  const c = loadNutritionixCreds();
  return !!(c.appId && c.appKey);
}
function nutritionixHeaders() {
  const c = loadNutritionixCreds();
  return { 'x-app-id': c.appId, 'x-app-key': c.appKey, 'Content-Type': 'application/json' };
}

let nutritionixSearchTimer = null;
let nutritionixLastResults = [];

function extractNutritionixNutrients(food) {
  // Branded item-detail and natural/nutrients both return per-serving values
  // in top-level nf_* fields, plus a full_nutrients[] array keyed by USDA
  // attr_id. Prefer top-level when present (less ambiguous), fall back to
  // full_nutrients for phosphorus (no top-level field exists for it).
  const fullMap = {};
  for (const fn of (food.full_nutrients || [])) {
    if (fn && fn.attr_id != null && typeof fn.value === 'number') fullMap[fn.attr_id] = fn.value;
  }
  const pick = (topKey, attrId) => {
    if (typeof food[topKey] === 'number') return food[topKey];
    if (fullMap[attrId] != null) return fullMap[attrId];
    return null;
  };
  const servingText = food.serving_qty && food.serving_unit
    ? `${food.serving_qty} ${food.serving_unit}${food.serving_weight_grams ? ` (${food.serving_weight_grams}g)` : ''}`
    : (food.serving_weight_grams ? `${food.serving_weight_grams}g` : 'per serving');
  return {
    perServing: true,
    servingText,
    calories: pick('nf_calories', NIX_ATTR.calories),
    protein: pick('nf_protein', NIX_ATTR.protein),
    carbs: pick('nf_total_carbohydrate', NIX_ATTR.carbs),
    fat: pick('nf_total_fat', NIX_ATTR.fat),
    fiber: pick('nf_dietary_fiber', NIX_ATTR.fiber),
    sodium: pick('nf_sodium', NIX_ATTR.sodium),
    potassium: pick('nf_potassium', NIX_ATTR.potassium),
    phosphorus: fullMap[NIX_ATTR.phosphorus] != null ? fullMap[NIX_ATTR.phosphorus] : null,
  };
}

async function hydrateNutritionixItem(item) {
  // item is a row from nutritionixLastResults. Branded rows have nix_item_id;
  // common rows only have food_name (and tag_id). Fetch full nutrients.
  if (item._hydrated) return item._hydrated;
  if (item.nix_item_id) {
    const url = `${NUTRITIONIX_BASE}/search/item?nix_item_id=${encodeURIComponent(item.nix_item_id)}`;
    const res = await fetch(url, { headers: nutritionixHeaders() });
    if (!res.ok) throw new Error(`Nutritionix item lookup ${res.status} ${res.statusText}`);
    const data = await res.json();
    const food = (data.foods && data.foods[0]) || null;
    if (!food) throw new Error('Nutritionix returned no food data for that item.');
    item._hydrated = food;
    return food;
  }
  // Common food → natural nutrients endpoint
  const q = `${item.serving_qty || 1} ${item.serving_unit || ''} ${item.food_name || ''}`.trim();
  const res = await fetch(`${NUTRITIONIX_BASE}/natural/nutrients`, {
    method: 'POST',
    headers: nutritionixHeaders(),
    body: JSON.stringify({ query: q }),
  });
  if (!res.ok) throw new Error(`Nutritionix natural lookup ${res.status} ${res.statusText}`);
  const data = await res.json();
  const food = (data.foods && data.foods[0]) || null;
  if (!food) throw new Error('Nutritionix natural endpoint returned no foods.');
  item._hydrated = food;
  return food;
}

async function searchNutritionix(query) {
  const wrap = document.getElementById('nutritionix-results');
  const section = document.getElementById('nutritionix-section');
  const countEl = document.getElementById('nutritionix-count');
  if (!wrap) return;
  if (!query || query.trim().length < 2) {
    wrap.innerHTML = '';
    nutritionixLastResults = [];
    if (section) { section.hidden = true; delete section.dataset.loading; }
    return;
  }
  if (!hasNutritionixCreds()) {
    // Silent — user hasn't set up Nutritionix. Section stays hidden so the
    // search UI doesn't get cluttered with a "no key" message every keystroke.
    if (section) { section.hidden = true; delete section.dataset.loading; }
    nutritionixLastResults = [];
    return;
  }
  if (section) { section.hidden = false; section.dataset.loading = '1'; }
  wrap.innerHTML = '<div class="results-loading"><span class="advisor-spinner"></span>Searching Nutritionix…</div>';
  if (countEl) countEl.textContent = '';

  const url = `${NUTRITIONIX_BASE}/search/instant?query=${encodeURIComponent(query.trim())}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: nutritionixHeaders(), signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      if (res.status === 401) throw new Error('Nutritionix rejected the credentials (401). Re-check App ID + App Key in Settings.');
      if (res.status === 403) throw new Error('Nutritionix returned 403 — App ID/Key mismatch or daily quota exceeded.');
      if (res.status === 429) throw new Error('Nutritionix rate limit hit (429). Free tier is 200 lookups/day — wait or upgrade.');
      throw new Error(`Nutritionix ${res.status}: ${body.slice(0, 160) || res.statusText}`);
    }
    const data = await res.json();
    const branded = Array.isArray(data.branded) ? data.branded : [];
    const common = Array.isArray(data.common) ? data.common : [];
    // Tag rows by type so the renderer + hydrator know how to handle them.
    nutritionixLastResults = [
      ...branded.map(b => ({ ...b, _nixType: 'branded' })),
      ...common.map(c => ({ ...c, _nixType: 'common' })),
    ];
    renderNutritionixResults(nutritionixLastResults);
  } catch (err) {
    clearTimeout(timeoutId);
    if (section) delete section.dataset.loading;
    let display = err.message || String(err);
    if (err.name === 'AbortError') display = 'Nutritionix timed out after 15 seconds.';
    else if (display === 'Failed to fetch' || display.startsWith('NetworkError')) {
      display = 'Could not reach Nutritionix (network/CORS). Try again or check connection.';
    }
    wrap.innerHTML = `<div class="results-empty" style="color:var(--bad)">Nutritionix: ${escapeHtml(display)}</div>`;
  }
}

function renderNutritionixResults(items) {
  const wrap = document.getElementById('nutritionix-results');
  const section = document.getElementById('nutritionix-section');
  const countEl = document.getElementById('nutritionix-count');
  if (section) delete section.dataset.loading;
  if (!items.length) {
    if (countEl) countEl.textContent = '';
    wrap.innerHTML = '<div class="results-empty">No Nutritionix matches.</div>';
    if (section) section.hidden = false;
    return;
  }
  if (countEl) countEl.textContent = `${items.length} result${items.length === 1 ? '' : 's'}`;
  const servingOptions = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  wrap.innerHTML = items.map((f, i) => {
    const isBranded = f._nixType === 'branded';
    const name = f.food_name || 'Unknown';
    const brand = f.brand_name || '';
    const serving = (f.serving_qty != null && f.serving_unit)
      ? `${f.serving_qty} ${f.serving_unit}${f.serving_weight_grams ? ` (${f.serving_weight_grams}g)` : ''}`
      : (f.serving_weight_grams ? `${f.serving_weight_grams}g` : '1 serving');
    const calPer = (isBranded && typeof f.nf_calories === 'number') ? Math.round(f.nf_calories) : null;
    const calStr = calPer != null ? `${calPer} kcal` : (isBranded ? '— kcal' : 'cal on add');
    const tagSrc = isBranded ? 'Branded' : 'Common';
    const photoUrl = f.photo && (f.photo.thumb || f.photo.highres);

    const options = servingOptions.map(opt => {
      const label = opt === 0.25 ? '1/4' : opt === 0.5 ? '1/2' : opt === 0.75 ? '3/4' : String(opt);
      const kcal = calPer != null ? ` — ${Math.round(calPer * opt)} kcal` : '';
      const selected = opt === 1 ? ' selected' : '';
      return `<option value="${opt}"${selected}>${label} serving${opt === 1 ? '' : 's'}${kcal}</option>`;
    }).join('');

    return `<div class="food-card nix-card" data-nix-idx="${i}">
      ${photoUrl ? `<img class="off-thumb" src="${escapeHtml(photoUrl)}" alt="" loading="lazy" />` : ''}
      <div class="name">${escapeHtml(name)}${brand ? ` <span class="food-tag" style="background:#fce9d9;color:#7a3c0a">${escapeHtml(brand)}</span>` : ''} <span class="food-tag" style="background:#eef;color:#338">${tagSrc}</span></div>
      <div class="serving">Per ${escapeHtml(serving)} · ${calStr}</div>
      <div class="row" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <label style="margin:0;font-size:13px">Servings
          <select class="nix-serving-select" data-nix-idx="${i}" style="margin-left:6px">
            ${options}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <input type="number" class="nix-serving-custom" data-nix-idx="${i}" step="0.05" min="0.05" placeholder="e.g. 1.25" style="width:90px;display:none" />
        <span class="nix-serving-preview hint" data-nix-idx="${i}" style="margin:0">${calPer != null ? Math.round(calPer) + ' kcal' : ''}</span>
        <button type="button" class="primary nix-add-btn" data-nix-idx="${i}" style="margin-left:auto">Add</button>
      </div>
    </div>`;
  }).join('');

  function readServings(idx) {
    const sel = wrap.querySelector(`.nix-serving-select[data-nix-idx="${idx}"]`);
    const custom = wrap.querySelector(`.nix-serving-custom[data-nix-idx="${idx}"]`);
    if (!sel) return 1;
    if (sel.value === 'custom') {
      const v = parseFloat(custom && custom.value);
      return v > 0 ? v : null;
    }
    return parseFloat(sel.value) || 1;
  }
  function updatePreview(idx) {
    const item = nutritionixLastResults[Number(idx)];
    const preview = wrap.querySelector(`.nix-serving-preview[data-nix-idx="${idx}"]`);
    if (!item || !preview) return;
    const s = readServings(idx);
    if (s == null) { preview.textContent = 'Enter a custom amount'; return; }
    const cal = (item._nixType === 'branded' && typeof item.nf_calories === 'number')
      ? Math.round(item.nf_calories * s) : null;
    preview.textContent = cal != null ? `${cal} kcal` : 'Full nutrients fetched on Add';
  }

  wrap.querySelectorAll('.nix-serving-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = sel.dataset.nixIdx;
      const custom = wrap.querySelector(`.nix-serving-custom[data-nix-idx="${idx}"]`);
      if (sel.value === 'custom') {
        if (custom) { custom.style.display = ''; custom.focus(); }
      } else {
        if (custom) custom.style.display = 'none';
      }
      updatePreview(idx);
      e.stopPropagation();
    });
  });
  wrap.querySelectorAll('.nix-serving-custom').forEach(input => {
    input.addEventListener('input', e => { updatePreview(input.dataset.nixIdx); e.stopPropagation(); });
    input.addEventListener('click', e => e.stopPropagation());
  });
  wrap.querySelectorAll('.nix-add-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const idx = btn.dataset.nixIdx;
      const item = nutritionixLastResults[Number(idx)];
      if (!item) return;
      const servings = readServings(idx);
      if (!servings || isNaN(servings) || servings <= 0) {
        alert('Enter a serving amount greater than 0.');
        return;
      }
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Fetching…';
      try {
        const food = await hydrateNutritionixItem(item);
        const n = extractNutritionixNutrients(food);
        const name = food.food_name || item.food_name || 'Unknown';
        const displayName = item.brand_name ? `${item.brand_name} ${name}` : name;
        const entry = { id: uid(), date: todayISO(), item: displayName, servings };
        for (const f of ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus']) {
          if (n[f] != null) entry[f] = n[f];
        }
        state.diet.push(entry);
        state.diet.sort((a, b) => a.date.localeCompare(b.date));
        save();
        flash(`Added ${displayName} × ${servings}`);
        renderAll();
      } catch (err) {
        alert(`Couldn't add from Nutritionix: ${err.message || err}`);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });
}

// ─── Search input wiring ─────────────────────────────────────────────────

function updateSearchClearVisibility(inputId, clearId) {
  const input = document.getElementById(inputId);
  const clear = document.getElementById(clearId);
  if (!input || !clear) return;
  clear.hidden = !input.value;
}

document.getElementById('usda-search').addEventListener('input', e => {
  clearTimeout(usdaSearchTimer);
  clearTimeout(offSearchTimer);
  clearTimeout(nutritionixSearchTimer);
  // Restaurant suggestions render immediately on the brand keyword — no need
  // to wait for the 400 ms USDA debounce. Cheap detection, cached AI output.
  renderRestaurantSuggestions(detectRestaurant(e.target.value));
  updateSearchClearVisibility('usda-search', 'usda-search-clear');
  const q = e.target.value;
  usdaSearchTimer = setTimeout(() => searchUSDA(q), 400);
  offSearchTimer = setTimeout(() => searchOpenFoodFacts(q), 500);
  nutritionixSearchTimer = setTimeout(() => searchNutritionix(q), 450);
});

document.getElementById('usda-search-clear')?.addEventListener('click', () => {
  const input = document.getElementById('usda-search');
  if (!input) return;
  input.value = '';
  input.focus();
  clearTimeout(usdaSearchTimer);
  clearTimeout(offSearchTimer);
  clearTimeout(nutritionixSearchTimer);
  renderRestaurantSuggestions(null);
  searchUSDA('');
  searchOpenFoodFacts('');
  searchNutritionix('');
  updateSearchClearVisibility('usda-search', 'usda-search-clear');
});

document.getElementById('food-search-clear')?.addEventListener('click', () => {
  const input = document.getElementById('food-search');
  if (!input) return;
  input.value = '';
  input.focus();
  renderFoodResults('');
  updateSearchClearVisibility('food-search', 'food-search-clear');
});


// ─── Restaurant kidney-friendly picks ─────────────────────────────────────
// When the USDA search query names a chain restaurant, surface CKD-tuned
// menu suggestions above the raw USDA results. Static hand-picked items
// render immediately; if a Gemini API key is configured, richer AI-generated
// picks replace them and get cached for 30 days per chain.

const RESTAURANT_CACHE_KEY = 'kidney-advisor-restaurant-picks';
const RESTAURANT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Keyword (lowercase) → display name. Longer keywords listed first so
// "panda express" matches before "panda" would in a shorter list.
const RESTAURANT_BRANDS = [
  ['mcdonalds', "McDonald's"], ['mcdonald', "McDonald's"],
  ['burger king', 'Burger King'],
  ['wendys', "Wendy's"], ["wendy", "Wendy's"],
  ['chick-fil-a', 'Chick-fil-A'], ['chick fil a', 'Chick-fil-A'], ['chickfila', 'Chick-fil-A'],
  ['starbucks', 'Starbucks'],
  ['taco bell', 'Taco Bell'],
  ['subway', 'Subway'],
  ['kfc', 'KFC'],
  ['chipotle', 'Chipotle'],
  ['pizza hut', 'Pizza Hut'],
  ['dominos', "Domino's"], ['domino', "Domino's"],
  ['olive garden', 'Olive Garden'],
  ['applebees', "Applebee's"], ['applebee', "Applebee's"],
  ['chilis', "Chili's"],
  ['ihop', 'IHOP'],
  ['dennys', "Denny's"], ['denny', "Denny's"],
  ['cracker barrel', 'Cracker Barrel'],
  ['panera', 'Panera Bread'],
  ['five guys', 'Five Guys'],
  ['in-n-out', 'In-N-Out'], ['in n out', 'In-N-Out'],
  ['jack in the box', 'Jack in the Box'],
  ['sonic', 'Sonic'],
  ['arbys', "Arby's"], ['arby', "Arby's"],
  ['carls jr', "Carl's Jr."],
  ['hardees', "Hardee's"],
  ['panda express', 'Panda Express'],
  ['dairy queen', 'Dairy Queen'],
  ['popeyes', 'Popeyes'],
  ['whataburger', 'Whataburger'],
  ['culvers', "Culver's"],
  ['outback', 'Outback Steakhouse'],
  ['texas roadhouse', 'Texas Roadhouse'],
  ['red lobster', 'Red Lobster'],
  ['cheesecake factory', 'The Cheesecake Factory'],
  ['buffalo wild wings', 'Buffalo Wild Wings'],
  ['dunkin', "Dunkin'"],
  ['tim hortons', 'Tim Hortons'],
  ['krispy kreme', 'Krispy Kreme'],
  ['wingstop', 'Wingstop'],
  ['qdoba', 'Qdoba'],
  ['jersey mikes', "Jersey Mike's"], ['jersey mike', "Jersey Mike's"],
  ['firehouse', 'Firehouse Subs'],
  ['jimmy johns', "Jimmy John's"], ['jimmy john', "Jimmy John's"],
  ['raising canes', "Raising Cane's"], ['raising cane', "Raising Cane's"],
  ['zaxbys', "Zaxby's"], ['zaxby', "Zaxby's"],
  ['el pollo loco', 'El Pollo Loco'],
  ['sweetgreen', 'Sweetgreen'],
  ['cava', 'Cava'],
  ['shake shack', 'Shake Shack'],
  ['pf changs', "P.F. Chang's"], ['p f chang', "P.F. Chang's"],
];

function detectRestaurant(query) {
  if (!query) return null;
  const q = ' ' + String(query).toLowerCase().trim() + ' ';
  if (q.length < 4) return null;
  for (const [keyword, display] of RESTAURANT_BRANDS) {
    const padded = ' ' + keyword + ' ';
    if (q.includes(padded)) return display;
    if (q.startsWith(keyword + ' ') || q.endsWith(' ' + keyword)) return display;
    if (q.trim() === keyword) return display;
  }
  return null;
}

// Hand-picked starter suggestions for offline / no-API-key use. Values are
// approximations from each chain's published nutrition; intent is "lower
// sodium, lower phosphorus additives, lean protein within reason." Encourage
// users to verify on the chain's actual nutrition page before ordering.
const RESTAURANT_FALLBACK_PICKS = {
  "McDonald's": [
    { item: 'Hamburger (small, no cheese), ask "no salt on patty"', why: 'Lowest-sodium burger build. Skipping cheese drops ~250 mg sodium and ~125 mg phosphorus.', kcal: 250, na: 510, pro: 12 },
    { item: 'Grilled Chicken Sandwich, no cheese, light sauce — eat half', why: 'Grilled (not crispy) keeps Na lower; halving puts sodium under ~500 mg.', kcal: 220, na: 480, pro: 18 },
    { item: 'Side Salad with Grilled Chicken, balsamic on the side', why: 'Skips the high-sodium bun and the cheese. Balsamic is the lowest-Na dressing option.', kcal: 220, na: 480, pro: 25 },
    { item: 'Egg McMuffin, no cheese, no Canadian bacon (egg + English muffin only)', why: 'Stripping the meat + cheese cuts sodium roughly in half vs. the full sandwich.', kcal: 200, na: 350, pro: 9 },
    { item: 'Apple slices + bottled water', why: 'Zero-sodium side and a clean fluid log entry.', kcal: 15, na: 0, pro: 0 },
  ],
  "Burger King": [
    { item: 'Hamburger (no cheese, no pickles)', why: 'The simplest build. Skipping pickles drops ~150 mg sodium.', kcal: 240, na: 380, pro: 12 },
    { item: 'Grilled Chicken Garden Salad, light Italian on the side', why: 'No bun + grilled chicken keeps sodium ~600 mg with dressing controlled.', kcal: 280, na: 620, pro: 25 },
    { item: 'BK Veggie burger, no cheese, no mayo', why: 'Plant patty avoids phosphate-preserved meat additives; ditching mayo saves ~100 mg sodium.', kcal: 320, na: 700, pro: 15 },
  ],
  "Wendy's": [
    { item: 'Jr. Hamburger, no cheese, plain', why: 'Smallest, leanest beef option. Plain (no ketchup/pickles) saves ~200 mg sodium.', kcal: 230, na: 430, pro: 13 },
    { item: 'Apple Pecan Chicken Salad — half portion, dressing on the side', why: 'Grilled chicken + apples + pecans give protein and flavor without phosphate additives.', kcal: 280, na: 640, pro: 21 },
    { item: 'Plain Baked Potato (skip cheese/sour cream/bacon)', why: 'Whole food vs. fries. ⚠ high potassium (~900 mg) — skip if your last K was >5.0.', kcal: 270, na: 25, pro: 7, note: 'Skip if your last potassium was >5.0 mEq/L.' },
  ],
  "Chick-fil-A": [
    { item: 'Grilled Chicken Sandwich, no cheese, no sauce', why: 'Grilled (not breaded) cuts sodium ~30%. No cheese drops phosphorus.', kcal: 320, na: 680, pro: 28 },
    { item: 'Grilled Nuggets (8-ct) + Side Salad, balsamic vinaigrette on the side', why: 'Pure lean protein + greens. Use half the dressing packet to manage Na.', kcal: 230, na: 660, pro: 28 },
    { item: 'Fruit Cup (medium)', why: 'Clean side — no added sodium, low phosphorus, modest potassium.', kcal: 60, na: 0, pro: 1 },
  ],
  "Starbucks": [
    { item: 'Tall (12 oz) brewed coffee, splash of half-and-half', why: 'No phosphate additives, no syrups. Avoid most non-dairy milks — they\'re fortified with phosphate additives.', kcal: 25, na: 10, pro: 1 },
    { item: 'Tall Cappuccino with 2% milk', why: '~4 oz of milk → ~120 mg phosphorus + ~150 mg K. Keep to one per day.', kcal: 80, na: 70, pro: 6, note: 'Avoid oat/soy/almond milk — most are fortified with phosphate additives.' },
    { item: 'Spinach, Feta & Egg White Wrap — eat half', why: 'Full wrap is 830 mg Na; half is reasonable. Higher protein, decent fiber.', kcal: 145, na: 415, pro: 10 },
    { item: 'Plain Bagel with cream cheese on the side', why: 'Skip "everything" bagel (high Na). Smear half the cream cheese.', kcal: 350, na: 460, pro: 11 },
  ],
  "Taco Bell": [
    { item: 'Power Menu Veggie Bowl, "Fresco style"', why: 'Fresco style swaps cheese/sauce for salsa — strips ~120 mg phosphorus and ~250 mg sodium per item.', kcal: 430, na: 990, pro: 12, note: 'Still high in sodium — eat the lightest other foods on this day.' },
    { item: 'Crunchy Taco, Fresco style × 2', why: 'Two Fresco crunchy tacos are ~340 kcal / ~600 mg Na — among the lowest-Na meals on the menu.', kcal: 340, na: 600, pro: 12 },
    { item: 'Black Beans (à la carte) + side of rice', why: 'Plant protein, fiber, no cheese or sauce. Watch portion — one serving each.', kcal: 240, na: 500, pro: 8 },
  ],
  "Subway": [
    { item: '6" Veggie Delite on 9-grain wheat, no cheese, oil + vinegar', why: 'No deli meat = the single biggest sodium win at Subway. Cold-cut subs hit 1000–1500 mg easily.', kcal: 230, na: 280, pro: 8 },
    { item: '6" Rotisserie-Style Chicken, no cheese, mustard, extra veggies', why: 'Rotisserie chicken is lower-Na than turkey or ham. Mustard < mayo < ranch for sodium.', kcal: 320, na: 580, pro: 26 },
    { item: '6" Turkey, no cheese, oil + vinegar — eat half, save the rest', why: 'Half a turkey sub puts Na around 400–500 mg; the full one doubles that.', kcal: 140, na: 380, pro: 9 },
  ],
  "KFC": [
    { item: 'Kentucky Grilled Chicken Breast (skin removed)', why: 'Grilled, not fried; removing skin cuts ~30% sodium and most of the saturated fat.', kcal: 130, na: 410, pro: 25 },
    { item: 'Green Beans (side) + Corn on the Cob (small)', why: 'Two whole-food sides that come in well under 500 mg Na combined.', kcal: 130, na: 380, pro: 4 },
  ],
  "Chipotle": [
    { item: 'Burrito Bowl: lettuce + brown rice + fajita veggies + chicken + mild salsa + guac; no cheese, no beans', why: 'Beans + cheese are the heaviest K/P hitters. Guac for healthy fat. Mild salsa < hot for sodium.', kcal: 550, na: 880, pro: 32 },
    { item: 'Salad: greens + fajita veggies + sofritas + mild salsa + vinaigrette on the side', why: 'Sofritas (tofu) is lower-Na than barbacoa or carnitas. Vinaigrette is the lowest-Na dressing.', kcal: 420, na: 760, pro: 22 },
  ],
  "Panera Bread": [
    { item: 'Half "You Pick Two": Caesar Salad (no cheese, dressing on side) + cup of Garden Vegetable soup', why: 'Garden Vegetable is one of the lower-Na soups (~700 mg cup). No-cheese Caesar shaves ~250 mg.', kcal: 360, na: 950, pro: 12 },
    { item: 'Mediterranean Veggie Sandwich on whole grain — eat half', why: 'A half is ~340 kcal / ~640 mg Na. Pair with fruit for a reasonable lunch.', kcal: 340, na: 640, pro: 10 },
  ],
  "Olive Garden": [
    { item: 'Garden-Fresh Salad (no croutons, no cheese), dressing on the side + grilled chicken add-on', why: 'Skip the breadsticks (~400 mg Na each). Croutons + cheese are the salad\'s sodium drivers.', kcal: 280, na: 720, pro: 28 },
    { item: 'Herb-Grilled Salmon + steamed broccoli substitute', why: 'Salmon is omega-3 rich and naturally low-Na; sub steamed broccoli for the higher-Na default sides.', kcal: 460, na: 730, pro: 42 },
  ],
  "Pizza Hut": [
    { item: 'Thin Crust Veggie Lover\'s, 1 slice (medium) + side salad', why: 'Thin crust is ~20% less Na than original/pan. Veggie toppings beat pepperoni/sausage by ~200 mg Na/slice.', kcal: 220, na: 530, pro: 9 },
  ],
  "Domino's": [
    { item: 'Thin Crust cheese pizza, 1 slice (medium) + garden salad', why: 'Thin crust cuts Na ~25%; one slice keeps you under 500 mg from the pizza itself.', kcal: 200, na: 450, pro: 8 },
  ],
};

function restaurantSlug(brand) {
  return String(brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadRestaurantCache() {
  try { return JSON.parse(localStorage.getItem(RESTAURANT_CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function saveRestaurantCache(c) {
  try { localStorage.setItem(RESTAURANT_CACHE_KEY, JSON.stringify(c)); } catch {}
}
function getCachedRestaurantPicks(brand) {
  const entry = loadRestaurantCache()[restaurantSlug(brand)];
  if (!entry || !Array.isArray(entry.picks)) return null;
  if (Date.now() - (entry.ts || 0) > RESTAURANT_CACHE_TTL_MS) return null;
  return entry.picks;
}
function setCachedRestaurantPicks(brand, picks) {
  const cache = loadRestaurantCache();
  cache[restaurantSlug(brand)] = { ts: Date.now(), picks };
  saveRestaurantCache(cache);
}

let restaurantFetchInFlight = null;
let restaurantLastBrand = null;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Tolerant JSON extractor for LLM responses. Tries, in order:
//   1. Direct JSON.parse on the trimmed string
//   2. Strip a ```json … ``` fence and retry
//   3. Slice from the first '{' to the last '}' and retry
//   4. Same slice with smart-quotes flattened to straight quotes
//   5. Same slice with a trailing-comma fixup (",}" → "}", ",]" → "]")
//   6. As a last resort for MAX_TOKENS truncation, walk back through the
//      string trimming the tail until a substring parses cleanly
// Returns the parsed value, or null if nothing works.
function tryParseJSONLoose(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const attempts = [];
  attempts.push(raw.trim());

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1].trim());

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const slice = raw.slice(first, last + 1);
    attempts.push(slice);
    attempts.push(slice.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"'));
    attempts.push(slice.replace(/,(\s*[}\]])/g, '$1'));
  }

  for (const s of attempts) {
    try { return JSON.parse(s); } catch {}
  }

  // Truncation recovery: walk the tail back to find the longest parsable
  // prefix that ends on a balanced brace. Only kicks in if we have a clear
  // opening '{' to anchor on.
  if (first !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let lastBalancedEnd = -1;
    for (let i = first; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) lastBalancedEnd = i;
      }
    }
    if (lastBalancedEnd > first) {
      try { return JSON.parse(raw.slice(first, lastBalancedEnd + 1)); } catch {}
    }
  }
  return null;
}

async function renderRestaurantSuggestions(brand) {
  const wrap = document.getElementById('usda-restaurant-suggestions');
  if (!wrap) return;
  if (!brand) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    wrap.dataset.loaded = '';
    restaurantLastBrand = null;
    return;
  }
  if (restaurantLastBrand === brand && wrap.dataset.loaded === 'fresh') return;
  restaurantLastBrand = brand;
  wrap.hidden = false;

  const cached = getCachedRestaurantPicks(brand);
  const fallback = RESTAURANT_FALLBACK_PICKS[brand] || null;
  const initial = cached || fallback;
  const initialMode = cached ? 'cache' : (fallback ? 'static' : 'loading');
  paintRestaurantSuggestions(brand, initial, initialMode);
  wrap.dataset.loaded = cached ? 'fresh' : 'partial';
  if (cached) return;

  const advisor = loadAdvisorSettings();
  if (!advisor.apiKey) {
    if (!fallback) paintRestaurantSuggestions(brand, null, 'no-key');
    return;
  }

  if (restaurantFetchInFlight && restaurantFetchInFlight.brand === brand) return;
  restaurantFetchInFlight = { brand };
  try {
    const aiPicks = await fetchRestaurantPicksFromGemini(brand, advisor);
    if (restaurantLastBrand !== brand) return;
    if (aiPicks && aiPicks.length) {
      setCachedRestaurantPicks(brand, aiPicks);
      paintRestaurantSuggestions(brand, aiPicks, 'ai');
      wrap.dataset.loaded = 'fresh';
    }
  } catch (err) {
    if (restaurantLastBrand !== brand) return;
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.cssText = 'margin-top:6px;color:var(--bad)';
    note.textContent = `AI picks unavailable: ${err.message}`;
    wrap.appendChild(note);
  } finally {
    restaurantFetchInFlight = null;
  }
}

function paintRestaurantSuggestions(brand, picks, mode) {
  const wrap = document.getElementById('usda-restaurant-suggestions');
  if (!wrap) return;
  const advisor = loadAdvisorSettings();

  const sourceLabel = {
    ai: 'AI-generated for your CKD profile',
    cache: 'Cached from a recent AI run',
    static: 'Hand-picked starter list (add a Gemini key in Settings for AI picks)',
    loading: 'Loading kidney-friendly picks…',
    'no-key': 'Add a Gemini API key in Settings → Ask Advisor for personalized picks.',
  }[mode] || '';

  let body = '';
  if (!picks || picks.length === 0) {
    body = `<p class="hint" style="margin:6px 0 0">No kidney-friendly suggestions on file for ${escapeHtml(brand)} yet.</p>`;
  } else {
    body = picks.map(p => {
      const stats = [];
      if (p.kcal != null) stats.push(`${Math.round(p.kcal)} kcal`);
      if (p.na != null) stats.push(`Na ${Math.round(p.na)}mg`);
      if (p.k != null) stats.push(`K ${Math.round(p.k)}mg`);
      if (p.p != null) stats.push(`P ${Math.round(p.p)}mg`);
      if (p.pro != null) stats.push(`Pro ${Math.round(p.pro)}g`);
      const statLine = stats.length ? `<div class="stats">${stats.join(' · ')}</div>` : '';
      const why = p.why ? `<div class="serving" style="white-space:normal">${escapeHtml(p.why)}</div>` : '';
      const note = p.note ? `<div class="hint" style="margin-top:4px;color:var(--warn)">${escapeHtml(p.note)}</div>` : '';
      return `<div class="food-card restaurant-pick">
        <div class="name">${escapeHtml(p.item || '')}</div>
        ${why}
        ${statLine}
        ${note}
      </div>`;
    }).join('');
  }

  const refreshAttr = advisor.apiKey ? '' : 'disabled title="Add a Gemini API key in Settings to refresh"';
  const refreshLabel = mode === 'loading' ? 'Loading…' : (mode === 'ai' || mode === 'cache' ? 'Refresh with AI' : 'Get AI picks');

  wrap.innerHTML = `
    <div class="restaurant-suggest-header">
      <div>
        <h3 style="margin:0">Kidney-friendly picks at ${escapeHtml(brand)}</h3>
        <p class="hint" style="margin:4px 0 0">${escapeHtml(sourceLabel)}</p>
      </div>
      <button type="button" class="secondary" id="btn-restaurant-refresh" ${refreshAttr}>${escapeHtml(refreshLabel)}</button>
    </div>
    <p class="hint" style="margin:6px 0">Always double-check the chain's posted nutrition before ordering — recipes and sodium levels change.</p>
    <div class="food-results restaurant-picks-grid">${body}</div>
  `;

  const refreshBtn = document.getElementById('btn-restaurant-refresh');
  if (refreshBtn && advisor.apiKey) {
    refreshBtn.addEventListener('click', () => {
      const cache = loadRestaurantCache();
      delete cache[restaurantSlug(brand)];
      saveRestaurantCache(cache);
      wrap.dataset.loaded = '';
      restaurantLastBrand = null;
      renderRestaurantSuggestions(brand);
    });
  }
}

async function fetchRestaurantPicksFromGemini(brand, advisorSettings) {
  const weight = state.settings.weightLbs || 195;
  const lastLab = state.labs[state.labs.length - 1];
  const labContext = lastLab ? [
    lastLab.egfr != null ? `eGFR ${lastLab.egfr}` : null,
    lastLab.potassium != null ? `K ${lastLab.potassium} mEq/L` : null,
    lastLab.phosphorus != null ? `P ${lastLab.phosphorus} mg/dL` : null,
  ].filter(Boolean).join(', ') : 'no recent labs on file';

  const systemPrompt = `You are a renal dietitian assistant. Given a chain restaurant, return 4–6 menu items most appropriate for a non-dialysis CKD stage 3–4 patient. Optimize for:
- Sodium ≤ 600 mg per item where feasible
- Lower phosphorus additives (avoid melted cheese, processed/deli meat, dark colas, phosphate-preserved chicken)
- Lower potassium when the user's K is elevated (avoid big portions of potato, tomato sauce, beans, banana, oranges, dark leafy greens)
- Reasonable lean protein 15–30 g per item
- Realistic, orderable items — name them as they appear on the menu, including standard modifications ("no cheese", "Fresco style", "dressing on the side")

Return ONLY valid JSON with this exact shape — no prose, no markdown:

{
  "picks": [
    {
      "item": "string — menu item with any modifications",
      "why": "1 short sentence explaining the kidney benefit",
      "kcal": number,
      "na": number_sodium_mg,
      "k": number_or_null_potassium_mg,
      "p": number_or_null_phosphorus_mg,
      "pro": number_protein_g,
      "note": "optional one-line caution or null"
    }
  ]
}

Use null for any value not reliably known. Values should reflect the item AS ORDERED with the modifications you specified.`;

  const userPrompt = `Patient context: ${weight} lbs, CKD stage 3b trending toward stage 4, last labs ${labContext}. Daily targets: sodium ${state.settings.sodiumTarget} mg, potassium ${state.settings.potassiumTarget} mg, phosphorus ${state.settings.phosphorusTarget} mg, protein ${state.settings.proteinTarget} g.

Restaurant: ${brand}

Return 4–6 kidney-friendly menu picks as JSON.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(advisorSettings.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': advisorSettings.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        // Gemini 2.5 Flash spends "thinking" tokens against maxOutputTokens
        // before emitting any visible content. With dynamic thinking on,
        // even 4096 wasn't enough — picks JSON kept truncating mid-array.
        // For a structured short-form output like this we don't need
        // reasoning, so thinkingBudget: 0 dedicates the full budget to the
        // actual response. Bumped maxOutputTokens to 8192 as a safety net.
        maxOutputTokens: 8192,
        temperature: 0.4,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(await res.text());
      if (j.error && j.error.message) msg = j.error.message;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const u = data.usageMetadata || {};
  const cached = u.cachedContentTokenCount || 0;
  const usage = loadAdvisorUsage();
  usage.input += (u.promptTokenCount || 0) - cached;
  usage.output += u.candidatesTokenCount || 0;
  usage.cacheRead += cached;
  usage.requests += 1;
  saveAdvisorUsage(usage);

  const cand = (data.candidates && data.candidates[0]) || null;
  const finishReason = cand && cand.finishReason || 'UNKNOWN';
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.map(p => p.text || '').join('').trim();

  // Log raw response so it survives the visible error toast for inspection.
  console.log('[restaurant-picks] Gemini response', { finishReason, text, raw: data });

  if (!text) {
    if (finishReason === 'SAFETY') throw new Error('Gemini blocked the response (safety filter)');
    if (finishReason === 'MAX_TOKENS') throw new Error('Hit token cap before any JSON was produced — try again');
    throw new Error(`No content returned (finish: ${finishReason})`);
  }

  let parsed = tryParseJSONLoose(text);
  if (!parsed) {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
    if (finishReason === 'MAX_TOKENS') {
      throw new Error(`Gemini ran out of tokens mid-JSON — try again (got: ${snippet}…)`);
    }
    throw new Error(`Could not parse JSON (finish: ${finishReason}, got: ${snippet}…)`);
  }
  if (!parsed || !Array.isArray(parsed.picks)) return null;
  return parsed.picks.slice(0, 8).map(p => ({
    item: String(p.item || '').slice(0, 200),
    why: String(p.why || '').slice(0, 400),
    kcal: numOrNull(p.kcal),
    na: numOrNull(p.na),
    k: numOrNull(p.k),
    p: numOrNull(p.p),
    pro: numOrNull(p.pro),
    note: p.note ? String(p.note).slice(0, 200) : null,
  })).filter(p => p.item);
}

const usdaKeyForm = document.getElementById('usda-key-form');
if (usdaKeyForm) {
  usdaKeyForm.addEventListener('submit', e => {
    e.preventDefault();
    const val = (new FormData(e.target).get('usdaKey') || '').toString().trim();
    saveUSDAKey(val);
    flash(val ? 'USDA key saved' : 'USDA key cleared (using demo key)');
  });
  // Pre-fill from storage
  const existing = loadUSDAKey();
  if (existing) usdaKeyForm.elements.usdaKey.value = existing;
}

function renderNutritionixStatus() {
  const el = document.getElementById('nutritionix-status');
  if (!el) return;
  const c = loadNutritionixCreds();
  if (c.appId && c.appKey) {
    el.innerHTML = `<span style="color:var(--good)">✓ Configured</span> — Nutritionix results will appear under USDA in the Diet tab search.`;
  } else {
    el.innerHTML = `<span style="color:var(--text-muted)">Not configured</span> — Nutritionix search is hidden until both App ID and App Key are saved.`;
  }
}

const nutritionixKeyForm = document.getElementById('nutritionix-key-form');
if (nutritionixKeyForm) {
  nutritionixKeyForm.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const appId = (fd.get('nutritionixAppId') || '').toString().trim();
    const appKey = (fd.get('nutritionixAppKey') || '').toString().trim();
    saveNutritionixCreds(appId, appKey);
    renderNutritionixStatus();
    flash(appId && appKey ? 'Nutritionix credentials saved' : 'Nutritionix credentials cleared');
  });
  const existing = loadNutritionixCreds();
  if (existing.appId) nutritionixKeyForm.elements.nutritionixAppId.value = existing.appId;
  if (existing.appKey) nutritionixKeyForm.elements.nutritionixAppKey.value = existing.appKey;
  renderNutritionixStatus();
}

// ─── Barcode scanner + Open Food Facts lookup ─────────────────────────────
//
// BarcodeDetector isn't in Safari yet, so we use html5-qrcode (loaded lazily
// from a CDN on first scan) which works cross-browser via getUserMedia + a
// pure-JS decoder. Supports UPC/EAN/Code-128/Code-39/QR.

let html5QrCodeInstance = null;
let html5QrCodeLoaded = false;
const HTML5_QRCODE_SRC = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';

function setBarcodeStatus(msg) {
  const el = document.getElementById('barcode-status');
  if (el) el.innerHTML = msg;
}

function loadHtml5QrCode() {
  if (html5QrCodeLoaded && typeof Html5Qrcode !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${HTML5_QRCODE_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => { html5QrCodeLoaded = true; resolve(); });
      existing.addEventListener('error', () => reject(new Error('Failed to load scanner library')));
      return;
    }
    const s = document.createElement('script');
    s.src = HTML5_QRCODE_SRC;
    s.async = true;
    s.onload = () => { html5QrCodeLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load scanner library — check your connection'));
    document.head.appendChild(s);
  });
}

async function openBarcodeScanner() {
  const modal = document.getElementById('barcode-scanner-modal');
  if (!modal) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Camera access is not available in this browser. Type the barcode instead.');
    return;
  }

  modal.hidden = false;
  setBarcodeStatus('Loading scanner…');

  try {
    await loadHtml5QrCode();
  } catch (err) {
    setBarcodeStatus(`${escapeHtml(err.message)}. Type the barcode instead.`);
    return;
  }

  setBarcodeStatus('Requesting camera…');

  try {
    html5QrCodeInstance = new Html5Qrcode('barcode-video-container', { verbose: false });
    const config = {
      fps: 12,
      qrbox: (w, h) => {
        const minEdge = Math.min(w, h);
        return { width: Math.floor(minEdge * 0.85), height: Math.floor(minEdge * 0.45) };
      },
      aspectRatio: 1.333,
      formatsToSupport: typeof Html5QrcodeSupportedFormats !== 'undefined' ? [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.ITF,
        Html5QrcodeSupportedFormats.QR_CODE,
      ] : undefined,
    };

    // html5-qrcode rejects `{ ideal: 'environment' }`. It accepts either a
    // plain string ('environment' or 'user') or `{ exact: 'environment' }`.
    // Plain string degrades gracefully on devices without a back camera
    // (desktop) by falling back to the default camera.
    await html5QrCodeInstance.start(
      { facingMode: 'environment' },
      config,
      (decodedText) => onBarcodeDetected(decodedText),
      () => { /* per-frame decode failures are expected — ignore */ }
    );
    setBarcodeStatus('Hold still — point the back camera at the barcode.');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setBarcodeStatus(`Camera failed: ${escapeHtml(msg)}. Type the barcode instead.`);
  }
}

async function closeBarcodeScanner() {
  if (html5QrCodeInstance) {
    try {
      if (typeof html5QrCodeInstance.isScanning === 'undefined' || html5QrCodeInstance.isScanning) {
        await html5QrCodeInstance.stop();
      }
      html5QrCodeInstance.clear();
    } catch (e) { /* already stopped */ }
    html5QrCodeInstance = null;
  }
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) modal.hidden = true;
}

async function onBarcodeDetected(code) {
  await closeBarcodeScanner();
  flash(`Scanned: ${code}`);
  if (navigator.vibrate) navigator.vibrate(50);
  const manualInput = document.getElementById('barcode-manual-input');
  if (manualInput) manualInput.value = code;
  lookupBarcode(code);
}

async function lookupBarcode(code) {
  const wrap = document.getElementById('barcode-result');
  if (!wrap) return;
  const normalized = String(code).replace(/\D/g, '');
  if (!normalized) {
    wrap.hidden = false;
    wrap.innerHTML = `<div style="padding:10px;color:var(--bad)">Enter a numeric barcode.</div>`;
    return;
  }

  wrap.hidden = false;
  wrap.innerHTML = `<div style="padding:10px;color:var(--text-muted)"><span class="advisor-spinner"></span>Looking up ${escapeHtml(normalized)}…</div>`;

  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(normalized)}.json?fields=product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,quantity,image_front_small_url`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
    const data = await res.json();
    if (data.status !== 1 || !data.product) {
      wrap.innerHTML = `<div style="padding:10px">No match for <strong>${escapeHtml(normalized)}</strong> in Open Food Facts. Try the USDA search below, or use Custom Entry.</div>`;
      return;
    }
    renderBarcodeProduct(data.product, normalized);
  } catch (err) {
    wrap.innerHTML = `<div style="padding:10px;color:var(--bad)">Lookup failed: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

// Open Food Facts stores per-100g (or per-100ml) values. serving_quantity is
// usually grams. Convert to per-serving and to mg for kidney values.
function extractOffNutrients(p) {
  const n = p.nutriments || {};
  const servingG = parseFloat(p.serving_quantity);
  const useServing = Number.isFinite(servingG) && servingG > 0;
  const mult = useServing ? servingG / 100 : 1;

  const v = (k) => {
    const raw = n[k];
    if (raw == null || raw === '') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  };

  // Try per-serving fields first if OFF provides them, else scale per-100g.
  const pick = (servingKey, per100Key, scaleMg = 1) => {
    const s = v(servingKey);
    if (s != null) return s * scaleMg;
    const p100 = v(per100Key);
    if (p100 != null) return p100 * mult * scaleMg;
    return null;
  };

  // Sodium: OFF gives sodium in grams; convert to mg. Fallback: salt_g * 400.
  let sodium = pick('sodium_serving', 'sodium_100g', 1000);
  if (sodium == null) {
    const saltServ = v('salt_serving');
    const salt100 = v('salt_100g');
    if (saltServ != null) sodium = saltServ * 400;
    else if (salt100 != null) sodium = salt100 * mult * 400;
  }

  return {
    perServing: useServing,
    servingText: p.serving_size || (useServing ? `${servingG} g` : '100 g'),
    calories:   pick('energy-kcal_serving', 'energy-kcal_100g'),
    protein:    pick('proteins_serving',    'proteins_100g'),
    fat:        pick('fat_serving',         'fat_100g'),
    carbs:      pick('carbohydrates_serving','carbohydrates_100g'),
    fiber:      pick('fiber_serving',       'fiber_100g'),
    sugars:     pick('sugars_serving',      'sugars_100g'),
    sodium,
    potassium:  pick('potassium_serving',   'potassium_100g', 1000),
    phosphorus: pick('phosphorus_serving',  'phosphorus_100g', 1000),
  };
}

function renderBarcodeProduct(product, code) {
  const wrap = document.getElementById('barcode-result');
  if (!wrap) return;
  const n = extractOffNutrients(product);
  const name = product.product_name || product.product_name_en || 'Unknown product';
  const brand = product.brands || '';
  const calPer = n.calories != null ? Math.round(n.calories) : null;
  const macros = [
    n.protein != null ? `P ${n.protein.toFixed(1)}g` : null,
    n.carbs != null ? `C ${n.carbs.toFixed(1)}g` : null,
    n.fat != null ? `F ${n.fat.toFixed(1)}g` : null,
    n.fiber != null ? `Fib ${n.fiber.toFixed(1)}g` : null,
  ].filter(Boolean).join(' · ');
  const kidney = [
    n.sodium != null ? `Na ${Math.round(n.sodium)}mg` : null,
    n.potassium != null ? `K ${Math.round(n.potassium)}mg` : null,
    n.phosphorus != null ? `P ${Math.round(n.phosphorus)}mg` : null,
  ].filter(Boolean).join(' · ');

  const servingOptions = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const options = servingOptions.map(opt => {
    const label = opt === 0.25 ? '1/4' : opt === 0.5 ? '1/2' : opt === 0.75 ? '3/4' : String(opt);
    const kcal = calPer != null ? ` — ${Math.round(calPer * opt)} kcal` : '';
    const selected = opt === 1 ? ' selected' : '';
    return `<option value="${opt}"${selected}>${label} serving${opt === 1 ? '' : 's'}${kcal}</option>`;
  }).join('');

  const imgHtml = product.image_front_small_url
    ? `<img src="${escapeHtml(product.image_front_small_url)}" alt="" style="float:right;max-width:64px;max-height:64px;margin-left:10px;border-radius:6px" />`
    : '';

  wrap.innerHTML = `<div class="food-card">
    ${imgHtml}
    <div class="name">${escapeHtml(name)}${brand ? ` <span class="food-tag" style="background:#eef;color:#338">${escapeHtml(brand)}</span>` : ''}</div>
    <div class="serving">Per ${escapeHtml(n.servingText)} · ${calPer != null ? calPer + ' kcal' : '— kcal'}${macros ? ' · ' + macros : ''}</div>
    ${kidney ? `<div class="stats">${kidney}</div>` : ''}
    <div class="row" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
      <label style="margin:0;font-size:13px">Servings
        <select id="barcode-serving-select" style="margin-left:6px">
          ${options}
          <option value="custom">Custom…</option>
        </select>
      </label>
      <input type="number" id="barcode-serving-custom" step="0.05" min="0.05" placeholder="e.g. 1.25" style="width:90px;display:none" />
      <span id="barcode-serving-preview" class="hint" style="margin:0">${calPer != null ? calPer + ' kcal' : ''}</span>
      <button type="button" class="primary" id="btn-barcode-add" style="margin-left:auto">Add to today</button>
      <button type="button" class="secondary" id="btn-barcode-dismiss">Dismiss</button>
    </div>
    <p class="hint" style="margin-top:8px;font-size:11px;opacity:0.7">UPC ${escapeHtml(code)} · data from Open Food Facts</p>
  </div>`;

  const sel = document.getElementById('barcode-serving-select');
  const custom = document.getElementById('barcode-serving-custom');
  const preview = document.getElementById('barcode-serving-preview');

  function readServings() {
    if (sel.value === 'custom') {
      const v = parseFloat(custom.value);
      return v > 0 ? v : null;
    }
    return parseFloat(sel.value) || 1;
  }
  function updatePreview() {
    const s = readServings();
    if (s == null) { preview.textContent = 'Enter a custom amount'; return; }
    const parts = [];
    if (n.calories != null) parts.push(`${Math.round(n.calories * s)} kcal`);
    if (n.sodium != null) parts.push(`Na ${Math.round(n.sodium * s)}mg`);
    if (n.potassium != null) parts.push(`K ${Math.round(n.potassium * s)}mg`);
    preview.textContent = parts.join(' · ');
  }
  sel.addEventListener('change', () => {
    custom.style.display = sel.value === 'custom' ? '' : 'none';
    if (sel.value === 'custom') custom.focus();
    updatePreview();
  });
  custom.addEventListener('input', updatePreview);

  document.getElementById('btn-barcode-add').addEventListener('click', () => {
    const servings = readServings();
    if (!servings || servings <= 0) { alert('Enter a serving amount greater than 0.'); return; }
    const entry = { id: uid(), date: todayISO(), item: name, servings };
    for (const f of ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus']) {
      if (n[f] != null) entry[f] = n[f];
    }
    state.diet.push(entry);
    save();
    flash(`Added ${name} × ${servings}`);
    wrap.hidden = true;
    wrap.innerHTML = '';
    const manualInput = document.getElementById('barcode-manual-input');
    if (manualInput) manualInput.value = '';
    renderAll();
  });

  document.getElementById('btn-barcode-dismiss').addEventListener('click', () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
  });
}

document.getElementById('btn-barcode-scan')?.addEventListener('click', openBarcodeScanner);
document.getElementById('btn-barcode-close')?.addEventListener('click', closeBarcodeScanner);
document.getElementById('barcode-scanner-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'barcode-scanner-modal') closeBarcodeScanner();
});
document.getElementById('barcode-manual-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = document.getElementById('barcode-manual-input').value.trim();
  if (!val) return;
  lookupBarcode(val);
});

function logWater(oz) {
  if (!oz || isNaN(oz) || oz <= 0) return;
  state.diet.push({
    id: uid(),
    date: todayISO(),
    item: 'Water',
    meal: '',
    servings: 1,
    fluids: oz,
  });
  save();
  renderAll();
  flash(`+${oz} oz water logged`);
}

document.querySelectorAll('[data-water]').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    logWater(Number(btn.dataset.water));
  });
});

document.getElementById('water-custom-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('water-custom-oz');
  const oz = parseFloat(input.value);
  if (!oz || oz <= 0) { alert('Enter a number of ounces greater than 0.'); return; }
  logWater(oz);
  input.value = '';
  input.focus();
});

document.getElementById('bp-quick-form').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const sys = Number(form.elements.systolic.value);
  const dia = Number(form.elements.diastolic.value);
  const pulse = form.elements.pulse.value ? Number(form.elements.pulse.value) : null;
  if (!sys || !dia) return;
  state.bp.push({
    id: uid(),
    datetime: new Date().toISOString().slice(0, 16),
    systolic: sys,
    diastolic: dia,
    pulse,
    position: 'seated',
    notes: '',
  });
  state.bp.sort((a, b) => a.datetime.localeCompare(b.datetime));
  save();
  renderAll();
  flash(`BP ${sys}/${dia}${pulse ? ' · ' + pulse + ' bpm' : ''} logged`);
  form.reset();
  const last = document.getElementById('bp-quick-last');
  if (last) last.textContent = `Last: ${sys}/${dia}${pulse ? ' · ' + pulse : ''} just now`;
});

// On every render, show the most recent BP in the quick-log card
(function showLastBPOnDiet() {
  const obs = new MutationObserver(() => {
    const last = document.getElementById('bp-quick-last');
    if (!last) return;
    const lastBp = state.bp[state.bp.length - 1];
    if (lastBp && !last.textContent) {
      last.textContent = `Last: ${lastBp.systolic}/${lastBp.diastolic}${lastBp.pulse ? ' · ' + lastBp.pulse : ''} (${fmt.dt(lastBp.datetime)})`;
    }
  });
  // Run once on load
  setTimeout(() => {
    const last = document.getElementById('bp-quick-last');
    if (last && state.bp.length) {
      const lb = state.bp[state.bp.length - 1];
      last.textContent = `Last: ${lb.systolic}/${lb.diastolic}${lb.pulse ? ' · ' + lb.pulse : ''} (${fmt.dt(lb.datetime)})`;
    }
  }, 200);
})();

function renderDiet() {
  renderDietBars(document.getElementById('diet-bars'));
  renderStepsCard();
  renderDietHistory();

  const today = todayISO();
  const tbody = document.querySelector('#diet-table tbody');
  const rows = state.diet.filter(d => d.date === today).reverse();
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="13" style="text-align:center;color:var(--text-muted)">No entries yet today.</td></tr>`
    : rows.map(d => `<tr>
      <td>${escapeHtml(d.item || '')}</td>
      <td>${escapeHtml(d.meal || '')}</td>
      <td>${fmt.num(d.servings, 2)}</td>
      <td>${fmt.num(d.calories, 0)}</td>
      <td>${fmt.num(d.carbs, 1)}</td>
      <td>${fmt.num(d.fat, 1)}</td>
      <td>${fmt.num(d.fiber, 1)}</td>
      <td>${fmt.num(d.protein, 1)}</td>
      <td>${fmt.num(d.sodium, 0)}</td>
      <td>${fmt.num(d.potassium, 0)}</td>
      <td>${fmt.num(d.phosphorus, 0)}</td>
      <td>${fmt.num(d.fluids, 1)}</td>
      <td><button class="icon" data-del-diet="${d.id}" title="Delete">×</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-del-diet]').forEach(b =>
    b.addEventListener('click', () => deleteFromList('diet', b.dataset.delDiet)));
}

// ─── Symptoms view ────────────────────────────────────────────────────────

function renderSymptoms() {
  const tbody = document.querySelector('#symptoms-table tbody');
  const rows = [...state.symptoms].reverse();
  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">No symptoms logged.</td></tr>`
    : rows.map(s => `<tr>
      <td>${fmt.date(s.date)}</td>
      <td>${s.fatigue ?? '—'}</td>
      <td>${s.swelling || '—'}</td>
      <td>${s.nausea ?? '—'}</td>
      <td>${s.itch ?? '—'}</td>
      <td>${s.sleep ?? '—'}</td>
      <td>${s.mood ?? '—'}</td>
      <td>${s.weight ?? '—'}</td>
      <td>${escapeHtml(s.notes || '')}</td>
      <td><button class="icon" data-del-sym="${s.id}" title="Delete">×</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-del-sym]').forEach(b =>
    b.addEventListener('click', () => deleteFromList('symptoms', b.dataset.delSym)));

  const labels = state.symptoms.map(s => s.date);
  const buildSet = (key) => state.symptoms.map(s => s[key] == null ? null : Number(s[key]));

  if (charts['chart-symptoms']) charts['chart-symptoms'].destroy();
  const el = document.getElementById('chart-symptoms');
  if (el) {
    charts['chart-symptoms'] = new Chart(el, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Fatigue', data: buildSet('fatigue'), borderColor: '#c0392b', spanGaps: true, tension: 0.2 },
          { label: 'Nausea',  data: buildSet('nausea'),  borderColor: '#c97c08', spanGaps: true, tension: 0.2 },
          { label: 'Itch',    data: buildSet('itch'),    borderColor: '#8e44ad', spanGaps: true, tension: 0.2 },
          { label: 'Sleep',   data: buildSet('sleep'),   borderColor: '#0a6c8e', spanGaps: true, tension: 0.2 },
          { label: 'Mood',    data: buildSet('mood'),    borderColor: '#2f8a3e', spanGaps: true, tension: 0.2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
        scales: { y: { min: 0, max: 10 } },
      },
    });
  }

  const wPoints = state.symptoms.filter(s => s.weight != null && s.weight !== '').map(s => ({ x: s.date, y: Number(s.weight) }));
  drawLineChart('chart-weight', wPoints, 'Weight (lbs)');
}

// ─── Visit Prep view ──────────────────────────────────────────────────────

function renderVisit() {
  // Visit info
  const vf = document.getElementById('visit-form');
  if (vf) {
    vf.elements.date.value = state.visit.date || '';
    vf.elements.provider.value = state.visit.provider || '';
    vf.elements.notes.value = state.visit.notes || '';
  }

  // Templates
  const tplWrap = document.getElementById('question-templates');
  tplWrap.querySelectorAll('.quick-chip').forEach(c => c.remove());
  for (const t of (window.QUESTION_TEMPLATES || [])) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quick-chip';
    chip.textContent = `${t.cat}: ${t.text}`;
    chip.addEventListener('click', () => {
      state.questions.push({ id: uid(), cat: t.cat, text: t.text, status: 'open', answer: '', addedDate: todayISO() });
      save();
      renderVisit();
    });
    tplWrap.appendChild(chip);
  }

  // Questions, grouped by category
  const list = document.getElementById('question-list');
  if (state.questions.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted)">No questions yet — add one above or pick from common questions.</div>';
  } else {
    const groups = {};
    for (const q of state.questions) (groups[q.cat] = groups[q.cat] || []).push(q);
    list.innerHTML = Object.entries(groups).map(([cat, qs]) => `
      <div class="question-group">
        <h4>${escapeHtml(cat)}</h4>
        ${qs.map(q => renderQuestionRow(q)).join('')}
      </div>
    `).join('');

    list.querySelectorAll('[data-q-status]').forEach(sel => {
      sel.addEventListener('change', () => {
        const q = state.questions.find(x => x.id === sel.dataset.qStatus);
        if (q) { q.status = sel.value; save(); renderVisit(); }
      });
    });
    list.querySelectorAll('[data-q-answer]').forEach(ta => {
      ta.addEventListener('blur', () => {
        const q = state.questions.find(x => x.id === ta.dataset.qAnswer);
        if (q && q.answer !== ta.value) { q.answer = ta.value; save(); }
      });
    });
    list.querySelectorAll('[data-q-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this question?')) return;
        state.questions = state.questions.filter(q => q.id !== btn.dataset.qDel);
        save();
        renderVisit();
      });
    });
  }

  // Past visit summary
  const sum = document.getElementById('visit-summary');
  const answered = state.questions.filter(q => q.status === 'answered' && q.answer);
  sum.innerHTML = answered.length === 0
    ? '<div style="color:var(--text-muted)">No answered questions yet. After your visit, mark questions as answered and record what your provider said.</div>'
    : answered.map(q => `<div style="margin-bottom:10px"><strong>${escapeHtml(q.cat)}:</strong> ${escapeHtml(q.text)}<br><span style="color:var(--text-muted)">→ ${escapeHtml(q.answer)}</span></div>`).join('');
}

function renderQuestionRow(q) {
  return `<div class="question-row status-${q.status}">
    <div class="question-status">
      <select data-q-status="${q.id}">
        <option value="open"     ${q.status === 'open' ? 'selected' : ''}>Open</option>
        <option value="asked"    ${q.status === 'asked' ? 'selected' : ''}>Asked</option>
        <option value="answered" ${q.status === 'answered' ? 'selected' : ''}>Answered</option>
      </select>
    </div>
    <div>
      <div class="question-text">${escapeHtml(q.text)}</div>
      <div class="question-answer">
        <textarea data-q-answer="${q.id}" placeholder="Provider's answer / your notes...">${escapeHtml(q.answer || '')}</textarea>
      </div>
    </div>
    <button class="icon" data-q-del="${q.id}" title="Delete">×</button>
  </div>`;
}

document.getElementById('btn-print-visit').addEventListener('click', () => window.print());
document.getElementById('btn-clear-answered').addEventListener('click', () => {
  if (!confirm('Remove all answered questions?')) return;
  state.questions = state.questions.filter(q => q.status !== 'answered');
  save();
  renderVisit();
});

// ─── Settings view ────────────────────────────────────────────────────────

function renderSettings() {
  const form = document.getElementById('settings-form');
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (form.elements[key]) form.elements[key].value = state.settings[key];
  }
  const rf = document.getElementById('reminders-form');
  rf.elements.bpTime.value = state.reminders.bpTime || '';
  rf.elements.checkinTime.value = state.reminders.checkinTime || '';
  rf.elements.enabled.checked = !!state.reminders.enabled;
  renderNotificationStatus();
  renderSyncStatus();
}

function renderNotificationStatus() {
  const el = document.getElementById('notification-status');
  if (!('Notification' in window)) {
    el.textContent = 'Browser notifications not supported in this browser.';
    return;
  }
  const perm = Notification.permission;
  const enabled = state.reminders.enabled && perm === 'granted';
  el.textContent = enabled
    ? `✓ Notifications enabled (permission: ${perm}).`
    : `Notifications: ${perm}${state.reminders.enabled ? ' — but permission needed' : ' (currently disabled)'}`;
}

document.getElementById('btn-export').addEventListener('click', () => {
  download(`kidney-advisor-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const incoming = JSON.parse(ev.target.result);
      if (!confirm('Replace all current data with the imported file?')) return;
      state = mergeState(incoming);
      save();
      renderAll();
      flash('Data imported');
    } catch (err) {
      alert('Could not parse that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ─── Merge-import (additive, dedup, doesn't wipe recent data) ────────────
// Reads a JSON file in the same shape as Export JSON but only adds labs,
// BP readings, meds (and optionally questions/symptoms) without touching
// diet, steps, advisor chat, settings, reminders. Useful for restoring
// historical health records into a state that already has recent diet/
// step tracking you don't want to lose.
function mergeImportData(incoming) {
  const result = { labs: { added: 0, skipped: 0 }, bp: { added: 0, skipped: 0 }, meds: { added: 0, skipped: 0 }, symptoms: { added: 0, skipped: 0 } };
  if (!incoming || typeof incoming !== 'object') throw new Error('Not a JSON object.');

  // Labs — dedup on existing id, then on same date+egfr+creatinine signature.
  if (Array.isArray(incoming.labs)) {
    if (!Array.isArray(state.labs)) state.labs = [];
    const existingIds = new Set(state.labs.map(l => l.id));
    const sig = l => `${l.date}|${l.egfr ?? ''}|${l.creatinine ?? ''}|${l.potassium ?? ''}`;
    const existingSigs = new Set(state.labs.map(sig));
    for (const lab of incoming.labs) {
      if (!lab || !lab.date) { result.labs.skipped++; continue; }
      if (existingIds.has(lab.id) || existingSigs.has(sig(lab))) { result.labs.skipped++; continue; }
      state.labs.push({ ...lab, id: lab.id || uid() });
      existingIds.add(lab.id);
      existingSigs.add(sig(lab));
      result.labs.added++;
    }
    state.labs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  // BP — reuse logBP idempotency: dedup on datetime + sys + dia.
  if (Array.isArray(incoming.bp)) {
    if (!Array.isArray(state.bp)) state.bp = [];
    const before = state.bp.length;
    for (const b of incoming.bp) {
      if (!b || !b.datetime) { result.bp.skipped++; continue; }
      const lenBefore = state.bp.length;
      logBP({
        systolic: b.systolic,
        diastolic: b.diastolic,
        pulse: b.pulse,
        datetime: b.datetime,
        position: b.position,
        notes: b.notes,
        source: b.source || 'imported',
      });
      if (state.bp.length > lenBefore) result.bp.added++;
      else result.bp.skipped++;
    }
  }

  // Meds — dedup on lowercased name (one entry per medication).
  if (Array.isArray(incoming.meds)) {
    if (!Array.isArray(state.meds)) state.meds = [];
    const existingNames = new Set(state.meds.map(m => (m.name || '').trim().toLowerCase()));
    for (const m of incoming.meds) {
      if (!m || !m.name) { result.meds.skipped++; continue; }
      const key = m.name.trim().toLowerCase();
      if (existingNames.has(key)) { result.meds.skipped++; continue; }
      state.meds.push({ ...m, id: m.id || uid() });
      existingNames.add(key);
      result.meds.added++;
    }
  }

  // Symptoms — dedup on date (one snapshot per day).
  if (Array.isArray(incoming.symptoms)) {
    if (!Array.isArray(state.symptoms)) state.symptoms = [];
    const existingDates = new Set(state.symptoms.map(s => s.date));
    for (const s of incoming.symptoms) {
      if (!s || !s.date) { result.symptoms.skipped++; continue; }
      if (existingDates.has(s.date)) { result.symptoms.skipped++; continue; }
      state.symptoms.push({ ...s, id: s.id || uid() });
      existingDates.add(s.date);
      result.symptoms.added++;
    }
    state.symptoms.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  return result;
}

function summarizeMerge(r) {
  const parts = [];
  if (r.labs.added)     parts.push(`${r.labs.added} lab${r.labs.added === 1 ? '' : 's'}`);
  if (r.bp.added)       parts.push(`${r.bp.added} BP reading${r.bp.added === 1 ? '' : 's'}`);
  if (r.meds.added)     parts.push(`${r.meds.added} medication${r.meds.added === 1 ? '' : 's'}`);
  if (r.symptoms.added) parts.push(`${r.symptoms.added} symptom entr${r.symptoms.added === 1 ? 'y' : 'ies'}`);
  const skipped = r.labs.skipped + r.bp.skipped + r.meds.skipped + r.symptoms.skipped;
  let s = parts.length ? `Added ${parts.join(' + ')}` : 'Nothing new to add';
  if (skipped) s += ` · skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`;
  return s;
}

document.getElementById('btn-merge-import')?.addEventListener('click', () => {
  document.getElementById('merge-import-file').click();
});

document.getElementById('merge-import-file')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const incoming = JSON.parse(ev.target.result);
      const labs = Array.isArray(incoming.labs) ? incoming.labs.length : 0;
      const bp   = Array.isArray(incoming.bp) ? incoming.bp.length : 0;
      const meds = Array.isArray(incoming.meds) ? incoming.meds.length : 0;
      const syms = Array.isArray(incoming.symptoms) ? incoming.symptoms.length : 0;
      const parts = [];
      if (labs) parts.push(`${labs} labs`);
      if (bp) parts.push(`${bp} BP readings`);
      if (meds) parts.push(`${meds} meds`);
      if (syms) parts.push(`${syms} symptom entries`);
      if (!parts.length) { alert('Nothing to merge — file has no labs / bp / meds / symptoms.'); return; }
      if (!confirm(`Merge ${parts.join(' + ')} from this file? Existing entries are deduplicated; diet, steps, advisor chat, settings, reminders are NOT touched.`)) return;
      const r = mergeImportData(incoming);
      save();
      renderAll();
      flash(summarizeMerge(r));
    } catch (err) {
      alert('Could not parse that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Erase ALL Kidney Advisor data on this device? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Export first if you want a backup.')) return;
  state = blankState();
  save();
  renderAll();
  flash('All data cleared');
});

const btnMoveToday = document.getElementById('btn-move-today-to-yesterday');
if (btnMoveToday) btnMoveToday.addEventListener('click', moveTodayEntriesToYesterday);

// ─── Steps card event wiring ─────────────────────────────────────────────
function wireStepsCard() {
  const card = document.getElementById('steps-card');
  if (!card) return;

  // Quick-add chips
  card.querySelectorAll('[data-steps-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.stepsAdd, 10);
      if (n > 0) {
        logSteps(n, { source: 'manual' });
        flash(`+${n.toLocaleString()} steps logged`);
      }
    });
  });

  // Custom add (additive)
  const customForm = document.getElementById('steps-custom-form');
  if (customForm) {
    customForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('steps-custom-input');
      const n = parseInt(input.value, 10);
      if (!n || n <= 0) { flash('Enter a step count greater than 0.'); return; }
      logSteps(n, { source: 'manual' });
      input.value = '';
      flash(`+${n.toLocaleString()} steps logged`);
    });
  }

  // Set today's total (replaces sync entries)
  const setTotalForm = document.getElementById('steps-set-total-form');
  if (setTotalForm) {
    setTotalForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('steps-set-total-input');
      const n = parseInt(input.value, 10);
      if (!n || n < 0) { flash('Enter a step count.'); return; }
      logSteps(n, { source: 'shortcut' });
      input.value = '';
      flash(`Today's total set to ${n.toLocaleString()} steps`);
    });
  }

  // Apple Health file picker
  const healthBtn = document.getElementById('btn-steps-health-pick');
  const healthFile = document.getElementById('steps-health-file');
  if (healthBtn && healthFile) {
    healthBtn.addEventListener('click', () => healthFile.click());
    healthFile.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (file) handleAppleHealthFile(file);
      healthFile.value = '';
    });
  }

  // Shortcut URL generators
  const baseUrl = () => (location.origin && !location.origin.startsWith('file'))
    ? (location.origin + location.pathname)
    : 'https://jasonbrown-qa.github.io/kidney-advisor/';

  const btnStepsTmpl = document.getElementById('btn-steps-shortcut-copy');
  if (btnStepsTmpl) {
    btnStepsTmpl.addEventListener('click', async () => {
      const url = baseUrl() + '?steps=[Statistic]';
      const ok = await copyToClipboard(url);
      flash(ok ? 'Steps URL copied — paste into your Shortcut\'s URL action, then drop the Statistic variable into [Statistic]' : 'Could not copy automatically');
    });
  }

  const btnBPTmpl = document.getElementById('btn-bp-shortcut-copy');
  if (btnBPTmpl) {
    btnBPTmpl.addEventListener('click', async () => {
      const url = baseUrl() + '?systolic=[Sys]&diastolic=[Dia]&bp_time=[WhenStr]';
      const ok = await copyToClipboard(url);
      flash(ok ? 'BP URL copied — paste into Shortcut\'s URL action, replace variables' : 'Could not copy automatically');
    });
  }

  const btnCombinedTmpl = document.getElementById('btn-combined-shortcut-copy');
  if (btnCombinedTmpl) {
    btnCombinedTmpl.addEventListener('click', async () => {
      const url = baseUrl() + '?steps=[Statistic]&systolic=[Sys]&diastolic=[Dia]&bp_time=[WhenStr]';
      const ok = await copyToClipboard(url);
      flash(ok ? 'Combined URL copied — one Shortcut, both syncs' : 'Could not copy automatically');
    });
  }
}

// Parses whatever's in the paste-import textarea (raw JSON or a sync URL
// containing #data=...). Returns the parsed object or null if invalid (with
// an alert already shown to the user). Shared by Replace and Merge buttons.
async function parsePastedImportContent() {
  const raw = document.getElementById('paste-import-text').value.trim();
  if (!raw) { alert('Paste JSON, a sync URL, or an iPhone setup link into the box first.'); return null; }
  // Setup link — auto-apply credentials and trigger cloud pull, then bail.
  const installMatch = raw.match(/#install=([^\s]+)/);
  if (installMatch) {
    try {
      const parsed = JSON.parse(b64urlDecode(decodeURIComponent(installMatch[1])));
      const { pat, gistId } = parsed || {};
      if (!pat) { alert('Setup link is missing the GitHub token.'); return null; }
      const sameAsCurrent = pat === cloudGetPat() && (!gistId || gistId === cloudGetGistId());
      if (sameAsCurrent) {
        flash('Setup link matches the current configuration — nothing to apply');
      } else {
        localStorage.setItem(GIST_PAT_KEY, pat);
        if (gistId) localStorage.setItem(GIST_ID_KEY, gistId);
        renderCloudSyncUI();
        setCloudStatus('Setup link applied · pulling…');
        try {
          await cloudSyncNow();
          renderCloudSyncUI();
          flash('Cloud sync configured · pulling your data from the gist');
        } catch (e) {
          setCloudStatus('Setup link saved but initial sync failed: ' + e.message);
        }
      }
      document.getElementById('paste-import-text').value = '';
    } catch (e) {
      alert('Could not decode the setup link: ' + e.message);
    }
    return null;
  }
  const hashMatch = raw.match(/#data=([^\s]+)/);
  if (hashMatch) {
    try {
      const payload = decodeURIComponent(hashMatch[1]);
      const json = payload.startsWith('gz1:')
        ? await gunzipBase64(payload.slice(4))
        : new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)));
      return JSON.parse(json);
    } catch (err) {
      alert('Could not decode the pasted URL: ' + err.message);
      return null;
    }
  }
  // Strip iOS smart punctuation that breaks JSON.parse, then parse.
  const text = raw
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/ /g, ' ');
  try { return JSON.parse(text); }
  catch (err) { alert('That doesn\'t look like valid JSON or a sync URL: ' + err.message); return null; }
}

document.getElementById('btn-paste-merge')?.addEventListener('click', async () => {
  const incoming = await parsePastedImportContent();
  if (!incoming) return;
  const labs = Array.isArray(incoming.labs) ? incoming.labs.length : 0;
  const bp   = Array.isArray(incoming.bp) ? incoming.bp.length : 0;
  const meds = Array.isArray(incoming.meds) ? incoming.meds.length : 0;
  const syms = Array.isArray(incoming.symptoms) ? incoming.symptoms.length : 0;
  const parts = [];
  if (labs) parts.push(`${labs} labs`);
  if (bp) parts.push(`${bp} BP readings`);
  if (meds) parts.push(`${meds} meds`);
  if (syms) parts.push(`${syms} symptom entries`);
  if (!parts.length) { alert('Nothing to merge — pasted content has no labs / bp / meds / symptoms.'); return; }
  if (!confirm(`Merge ${parts.join(' + ')} from the pasted content? Existing entries are deduplicated; diet, steps, advisor chat, settings, reminders are NOT touched.`)) return;
  try {
    const r = mergeImportData(incoming);
    save();
    renderAll();
    document.getElementById('paste-import-text').value = '';
    flash(summarizeMerge(r));
  } catch (err) {
    alert('Merge failed: ' + err.message);
  }
});

document.getElementById('btn-paste-import').addEventListener('click', async () => {
  const raw = document.getElementById('paste-import-text').value.trim();
  if (!raw) {
    alert('Paste JSON or a sync URL into the box first.');
    return;
  }
  let incoming;
  // If the user pasted a full sync URL (containing #data=...), extract the
  // payload and decode it the same way checkHashImport() would.
  const hashMatch = raw.match(/#data=([^\s]+)/);
  if (hashMatch) {
    try {
      const payload = decodeURIComponent(hashMatch[1]);
      const json = payload.startsWith('gz1:')
        ? await gunzipBase64(payload.slice(4))
        : new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)));
      incoming = JSON.parse(json);
    } catch (err) {
      alert('Could not decode the pasted URL: ' + err.message + '. If you copied it from iMessage, it may have been truncated — use Copy raw JSON on the source device instead.');
      return;
    }
  } else {
    // Treat as raw JSON. Strip iOS smart punctuation that breaks JSON.parse.
    const text = raw
      .replace(/[“”„‟″‶]/g, '"')
      .replace(/[‘’‚‛′‵]/g, "'")
      .replace(/ /g, ' ');
    try {
      incoming = JSON.parse(text);
    } catch (err) {
      alert('That doesn’t look like valid JSON or a sync URL: ' + err.message);
      return;
    }
  }
  if (!confirm('Replace all current data with the pasted content?')) return;
  try {
    state = mergeState(incoming);
    save();
    renderAll();
    document.getElementById('paste-import-text').value = '';
    flash('Data imported');
  } catch (err) {
    alert('Import failed while applying the data: ' + err.message);
  }
});

// ─── File System Access sync ──────────────────────────────────────────────

const IDB_DB = 'kidney-advisor';
const IDB_STORE = 'handles';
const fsaSupported = 'showSaveFilePicker' in window;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function verifyHandlePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

async function pickSyncFile() {
  if (!fsaSupported) { alert('Your browser does not support direct file sync. Use Edge or Chrome.'); return; }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'kidney-advisor-sync.json',
      types: [{ description: 'Kidney Advisor data', accept: { 'application/json': ['.json'] } }],
    });
    syncHandle = handle;
    await idbSet('syncHandle', handle);
    await writeSyncFile();
    flash('Sync file connected');
    renderSyncStatus();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not pick file: ' + e.message);
  }
}

async function loadFromSyncFile() {
  if (!syncHandle) {
    if (!fsaSupported) return;
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Kidney Advisor data', accept: { 'application/json': ['.json'] } }],
      });
      syncHandle = handle;
      await idbSet('syncHandle', handle);
    } catch (e) {
      if (e.name !== 'AbortError') alert(e.message);
      return;
    }
  }
  if (!(await verifyHandlePermission(syncHandle, 'read'))) { alert('Permission denied'); return; }
  try {
    const file = await syncHandle.getFile();
    const text = await file.text();
    const incoming = JSON.parse(text);
    if (!confirm('Replace local data with sync file contents?')) return;
    state = mergeState(incoming);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
    flash('Loaded from sync file');
  } catch (e) {
    alert('Could not load: ' + e.message);
  }
}

async function writeSyncFile() {
  if (!syncHandle) return;
  if (!(await verifyHandlePermission(syncHandle, 'readwrite'))) return;
  try {
    const writable = await syncHandle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
  } catch (e) {
    console.error('Sync write failed', e);
  }
}

function scheduleSyncWrite() {
  if (!syncHandle) return;
  clearTimeout(syncWriteTimer);
  syncWriteTimer = setTimeout(writeSyncFile, 500);
}

async function disconnectSync() {
  syncHandle = null;
  await idbDel('syncHandle');
  flash('Sync disconnected');
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = document.getElementById('sync-status');
  const warning = document.getElementById('fsa-warning');
  if (!fsaSupported) {
    if (warning) warning.hidden = false;
    el.textContent = '';
    return;
  }
  if (warning) warning.hidden = true;
  if (syncHandle) {
    el.innerHTML = `<strong style="color:var(--good)">✓ Connected</strong> · ${escapeHtml(syncHandle.name)} · auto-writing on every change.`;
  } else {
    el.textContent = 'Not connected. Pick a JSON file in your OneDrive folder to enable cross-device sync.';
  }
}

document.getElementById('btn-sync-pick').addEventListener('click', pickSyncFile);
document.getElementById('btn-sync-load').addEventListener('click', loadFromSyncFile);
document.getElementById('btn-sync-clear').addEventListener('click', disconnectSync);

// ─── Notifications / Reminders ────────────────────────────────────────────

function getFiredMap() {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}'); } catch { return {}; }
}

function setFired(key) {
  const map = getFiredMap();
  map[key] = todayISO();
  localStorage.setItem(FIRED_KEY, JSON.stringify(map));
}

function alreadyFiredToday(key) {
  const map = getFiredMap();
  return map[key] === todayISO();
}

function parseTimes(str) {
  if (!str) return [];
  return String(str).split(/[,;]/).map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s)).map(s => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  });
}

function checkReminders() {
  if (!state.reminders.enabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // BP
  for (const t of parseTimes(state.reminders.bpTime)) {
    const key = `bp-${t}`;
    if (Math.abs(minutes - t) <= 1 && !alreadyFiredToday(key)) {
      notify('Blood pressure check', 'Time to log a BP reading.');
      setFired(key);
    }
  }

  // Check-in
  for (const t of parseTimes(state.reminders.checkinTime)) {
    const key = `checkin-${t}`;
    if (Math.abs(minutes - t) <= 1 && !alreadyFiredToday(key)) {
      const today = todayISO();
      const log = state.medLog[today] || {};
      const taken = state.meds.filter(m => log[m.id]).length;
      const dietToday = state.diet.filter(d => d.date === today).length;
      notify('Daily check-in', `Meds: ${taken}/${state.meds.length} taken · ${dietToday} diet entries today`);
      setFired(key);
    }
  }

  // Per-med
  for (const m of state.meds) {
    for (const t of parseTimes(m.time)) {
      const key = `med-${m.id}-${t}`;
      if (Math.abs(minutes - t) <= 1 && !alreadyFiredToday(key)) {
        const today = todayISO();
        const log = state.medLog[today] || {};
        if (!log[m.id]) {
          notify(`Medication: ${m.name}`, `${m.dose || ''} ${m.frequency || ''}`.trim() || 'Time to take this dose');
          setFired(key);
        }
      }
    }
  }
}

function notify(title, body) {
  try {
    new Notification(title, { body, icon: '', tag: title });
  } catch (e) {
    console.error('Notify failed', e);
  }
}

// ─── Misc helpers ─────────────────────────────────────────────────────────

function nowDatetimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function flash(msg) {
  const el = document.createElement('div');
  el.className = 'flash-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  // Force a reflow so the .show transition kicks in
  void el.offsetHeight;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── CCDA XML import ──────────────────────────────────────────────────────

// LOINC codes for CKD-relevant labs. Multiple codes map to the same field
// because labs use different codes for the same measurement.
const LOINC_TO_FIELD = {
  '33914-3': 'egfr',     '48642-3': 'egfr',     '48643-1': 'egfr',
  '62238-1': 'egfr',     '69405-9': 'egfr',     '88293-6': 'egfr',
  '98979-8': 'egfr',     '50044-7': 'egfr',
  '2160-0':  'creatinine','38483-4': 'creatinine','14682-9': 'creatinine',
  '6299-2':  'bun',      '3094-0':  'bun',
  '2823-3':  'potassium','6298-4':  'potassium','39790-1': 'potassium',
  '2777-1':  'phosphorus','14879-1': 'phosphorus',
  '17861-6': 'calcium',  '49765-1': 'calcium',
  '718-7':   'hemoglobin','30313-1': 'hemoglobin','30350-3': 'hemoglobin',
  '1751-7':  'albumin',  '54347-0': 'albumin',
  '1963-8':  'bicarbonate','2028-9':'bicarbonate','20565-8':'bicarbonate',
  '14959-1': 'uacr',     '9318-7':  'uacr',     '32294-1': 'uacr',
  '13705-9': 'uacr',     '14958-3': 'uacr',
};

let ccdaWorking = null;

document.getElementById('btn-ccda-import').addEventListener('click', () => {
  document.getElementById('ccda-file').click();
});

document.getElementById('ccda-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const parsed = parseCCDA(ev.target.result);
      if (parsed.length === 0) {
        alert('No CKD-relevant lab values were found in this CCDA file. The XML may not contain observations with recognized LOINC codes, or it may be a non-standard format.');
        return;
      }
      ccdaWorking = parsed;
      renderCcdaPreview();
    } catch (err) {
      alert('Could not parse CCDA XML: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function parseCCDA(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Invalid XML');

  // Group observations by date
  const byDate = {};
  // Find all observation elements regardless of namespace prefix
  const observations = doc.getElementsByTagName('*');
  for (const obs of observations) {
    if (obs.localName !== 'observation') continue;
    // Extract the LOINC code from the code child element
    let code = null;
    for (const child of obs.children) {
      if (child.localName === 'code') {
        const c = child.getAttribute('code');
        const cs = child.getAttribute('codeSystem');
        // 2.16.840.1.113883.6.1 is LOINC
        if (c && (cs === '2.16.840.1.113883.6.1' || !cs)) {
          code = c;
        }
        break;
      }
    }
    if (!code) continue;
    const field = LOINC_TO_FIELD[code];
    if (!field) continue;

    // Extract value
    let value = null;
    for (const child of obs.children) {
      if (child.localName === 'value') {
        const v = child.getAttribute('value');
        if (v != null) value = parseFloat(v);
        break;
      }
    }
    if (value == null || isNaN(value)) continue;

    // Extract effective date
    let dateStr = null;
    for (const child of obs.children) {
      if (child.localName === 'effectiveTime') {
        dateStr = child.getAttribute('value');
        if (!dateStr) {
          // Sometimes <low value="..."/>
          for (const sub of child.children) {
            if (sub.localName === 'low') {
              dateStr = sub.getAttribute('value');
              break;
            }
          }
        }
        break;
      }
    }
    if (!dateStr) continue;
    // CCDA dates are YYYYMMDDHHMMSS or YYYYMMDD
    const isoDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;

    if (!byDate[isoDate]) byDate[isoDate] = { date: isoDate };
    byDate[isoDate][field] = value;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function renderCcdaPreview() {
  const wrap = document.getElementById('ccda-preview');
  if (!ccdaWorking) { wrap.hidden = true; return; }
  const fields = ['egfr','creatinine','bun','potassium','phosphorus','calcium','hemoglobin','albumin','bicarbonate','uacr'];
  const rows = ccdaWorking.map(r => `<tr>
    <td>${fmt.date(r.date)}</td>
    ${fields.map(f => `<td>${r[f] != null ? r[f] : '—'}</td>`).join('')}
  </tr>`).join('');
  wrap.hidden = false;
  wrap.innerHTML = `
    <h4>${ccdaWorking.length} lab dates extracted from CCDA</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th>${fields.map(f => `<th>${f}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="row">
      <button id="btn-ccda-confirm" class="primary">Import ${ccdaWorking.length} Labs</button>
      <button id="btn-ccda-cancel" class="secondary">Cancel</button>
    </div>
  `;
  document.getElementById('btn-ccda-confirm').addEventListener('click', () => {
    for (const r of ccdaWorking) {
      state.labs.push({ id: uid(), ...r });
    }
    state.labs.sort((a, b) => a.date.localeCompare(b.date));
    save();
    ccdaWorking = null;
    document.getElementById('ccda-preview').hidden = true;
    flash(`Imported ${state.labs.length} labs`);
    renderAll();
  });
  document.getElementById('btn-ccda-cancel').addEventListener('click', () => {
    ccdaWorking = null;
    document.getElementById('ccda-preview').hidden = true;
  });
}

// ─── Word document import (.docx via Mammoth + ChatGPT extraction) ──────

let docxWorking = null;

document.getElementById('btn-docx-import').addEventListener('click', async () => {
  const settings = loadAdvisorSettings();
  if (!settings.apiKey) {
    alert('Word document import uses Gemini to extract lab values, which needs a Google Gemini API key.\n\nGo to Settings → "Ask Advisor (Google Gemini API)" to add your key first.');
    return;
  }
  if (typeof mammoth === 'undefined') {
    alert('The Word parsing library (mammoth.js) failed to load. Check your internet connection and reload the page.');
    return;
  }
  document.getElementById('docx-file').click();
});

document.getElementById('docx-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const settings = loadAdvisorSettings();
  const wrap = document.getElementById('docx-preview');
  wrap.hidden = false;
  wrap.innerHTML = `<h4>Reading ${escapeHtml(file.name)}...</h4><div><span class="advisor-spinner"></span>Extracting text from Word document...</div>`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = (result.value || '').trim();
    if (text.length < 20) {
      wrap.innerHTML = `<h4>Could not read this document</h4>
        <p>The file appears to be empty or contains no text. If it's a scanned image, you'll need to OCR it first.</p>
        <div class="row"><button id="btn-docx-cancel" class="secondary">Close</button></div>`;
      document.getElementById('btn-docx-cancel').addEventListener('click', () => { wrap.hidden = true; });
      return;
    }

    wrap.innerHTML = `<h4>Extracting lab values with ${escapeHtml(settings.model)}...</h4>
      <div><span class="advisor-spinner"></span>Reading ${text.length.toLocaleString()} characters of text...</div>`;

    const labs = await extractLabsWithClaude(text, settings);
    if (!labs || labs.length === 0) {
      wrap.innerHTML = `<h4>No lab values detected</h4>
        <p>ChatGPT reviewed the document but didn't find recognizable lab values. The document may not contain CKD-relevant labs, or the format may be unusual.</p>
        <details style="margin-top:8px"><summary style="cursor:pointer">Show extracted text (first 1000 chars)</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto;background:white;padding:8px;border-radius:4px;margin-top:6px">${escapeHtml(text.slice(0, 1000))}${text.length > 1000 ? '\n…' : ''}</pre></details>
        <div class="row" style="margin-top:10px"><button id="btn-docx-cancel" class="secondary">Close</button></div>`;
      document.getElementById('btn-docx-cancel').addEventListener('click', () => { wrap.hidden = true; });
      return;
    }

    docxWorking = labs;
    renderDocxPreview();
  } catch (err) {
    wrap.innerHTML = `<h4>Error</h4>
      <p style="color:var(--bad)">${escapeHtml(err.message)}</p>
      <p class="hint">Common causes: invalid API key, rate limit, network error, or unsupported Word format. If your file is .doc (older Word), open it in Word and save as .docx.</p>
      <div class="row"><button id="btn-docx-cancel" class="secondary">Close</button></div>`;
    document.getElementById('btn-docx-cancel').addEventListener('click', () => { wrap.hidden = true; });
  }
});

async function extractLabsWithClaude(text, settings) {
  const systemPrompt = `You are a medical lab data extractor. Read the user's text and return ONLY a JSON object — no prose, no markdown, no code fences.

Output schema:
{
  "results": [
    {
      "date": "YYYY-MM-DD (required)",
      "egfr": number or null,
      "creatinine": number or null,
      "bun": number or null,
      "potassium": number or null,
      "phosphorus": number or null,
      "calcium": number or null,
      "hemoglobin": number or null,
      "albumin": number or null,
      "bicarbonate": number or null,
      "uacr": number or null,
      "notes": string or null
    }
  ]
}

Rules:
- One object per unique lab draw date
- Convert all dates to YYYY-MM-DD (e.g. "April 15, 2026" → "2026-04-15")
- Use null for any value not present in the text
- Units expected: eGFR mL/min/1.73m², creatinine mg/dL, BUN mg/dL, potassium mEq/L (mmol/L is the same number), phosphorus mg/dL, calcium mg/dL, hemoglobin g/dL, albumin g/dL, bicarbonate mEq/L, UACR mg/g
- Common synonyms: "GFR" or "estimated GFR" = eGFR; "K" = potassium; "Ca" = calcium; "Phos" or "P" = phosphorus; "Hgb" or "Hb" = hemoglobin; "Alb" = albumin; "CO2" or "HCO3" = bicarbonate; "albumin/creatinine ratio" = UACR
- Strip "<" or ">" prefixes from numbers (e.g. "<5" → 5)
- If a value is given in different units than expected, convert it
- If you genuinely cannot find any labs, return {"results": []}
- Return strictly valid JSON. No prose before or after.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': settings.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        { role: 'user', parts: [{ text: `Extract CKD-relevant lab values from this document:\n\n${text}` }] },
      ],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const errJson = JSON.parse(await res.text());
      if (errJson.error && errJson.error.message) msg = errJson.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  const responseText = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
    .map(p => p.text || '')
    .join('')).trim();

  // Track usage
  const u = data.usageMetadata || {};
  const cached = u.cachedContentTokenCount || 0;
  const usage = loadAdvisorUsage();
  usage.input += (u.promptTokenCount || 0) - cached;
  usage.output += u.candidatesTokenCount || 0;
  usage.cacheRead += cached;
  usage.requests += 1;
  saveAdvisorUsage(usage);

  // Strip code fences if present (responseMimeType json should prevent this, but be safe)
  let jsonStr = responseText;
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Gemini returned invalid JSON: ${err.message}\n\nResponse:\n${responseText.slice(0, 500)}`);
  }

  return Array.isArray(parsed.results) ? parsed.results : [];
}

function renderDocxPreview() {
  const wrap = document.getElementById('docx-preview');
  if (!docxWorking) { wrap.hidden = true; return; }
  const fields = ['egfr','creatinine','bun','potassium','phosphorus','calcium','hemoglobin','albumin','bicarbonate','uacr'];
  const fieldLabels = ['eGFR','Creat','BUN','K','P','Ca','Hgb','Alb','HCO3','UACR'];
  const rows = docxWorking.map((r, i) => `<tr>
    <td><input type="checkbox" data-docx-row="${i}" checked /></td>
    <td>${escapeHtml(r.date || '')}</td>
    ${fields.map(f => `<td>${r[f] != null ? r[f] : '—'}</td>`).join('')}
    <td>${escapeHtml(r.notes || '')}</td>
  </tr>`).join('');
  wrap.hidden = false;
  wrap.innerHTML = `
    <h4>${docxWorking.length} lab date(s) extracted from Word document</h4>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Date</th>${fieldLabels.map(l => `<th>${l}</th>`).join('')}<th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Uncheck any rows you don't want to import. After import, you can edit individual values in the Lab History table below.</p>
    <div class="row">
      <button id="btn-docx-confirm" class="primary">Import Selected</button>
      <button id="btn-docx-cancel" class="secondary">Cancel</button>
    </div>
  `;
  document.getElementById('btn-docx-confirm').addEventListener('click', () => {
    const checkboxes = wrap.querySelectorAll('[data-docx-row]');
    let added = 0;
    checkboxes.forEach(cb => {
      if (!cb.checked) return;
      const r = docxWorking[Number(cb.dataset.docxRow)];
      if (!r || !r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return;
      const lab = { id: uid(), date: r.date };
      for (const f of fields) {
        if (r[f] != null && !isNaN(Number(r[f]))) lab[f] = Number(r[f]);
      }
      if (r.notes) lab.notes = r.notes;
      state.labs.push(lab);
      added++;
    });
    state.labs.sort((a, b) => a.date.localeCompare(b.date));
    save();
    docxWorking = null;
    wrap.hidden = true;
    flash(`Imported ${added} lab entries`);
    renderAll();
  });
  document.getElementById('btn-docx-cancel').addEventListener('click', () => {
    docxWorking = null;
    wrap.hidden = true;
  });
}

// ─── Ask Advisor ──────────────────────────────────────────────────────────

const ADVISOR_DEFAULT = {
  apiKey: '',
  model: 'gemini-2.5-flash',
  maxTokens: 2048,
};

const ADVISOR_SUGGESTIONS = [
  'What does my eGFR trend mean?',
  'Why is my potassium going up?',
  'How much protein should I eat each day?',
  'What foods should I avoid with high phosphorus?',
  'Is my blood pressure under good control?',
  'What over-the-counter pain meds are safe for me?',
  'Should I be worried about leg swelling?',
  'How do I lower sodium without losing flavor?',
  'What questions should I ask my nephrologist next visit?',
  'Are SGLT2 inhibitors right for stage 3 CKD?',
];

function loadAdvisorSettings() {
  try {
    const raw = localStorage.getItem(ADVISOR_SECRET_KEY);
    if (!raw) return { ...ADVISOR_DEFAULT };
    return { ...ADVISOR_DEFAULT, ...JSON.parse(raw) };
  } catch { return { ...ADVISOR_DEFAULT }; }
}

function saveAdvisorSettings(s) {
  localStorage.setItem(ADVISOR_SECRET_KEY, JSON.stringify(s));
}

function loadAdvisorUsage() {
  try {
    const raw = localStorage.getItem(ADVISOR_USAGE_KEY);
    return raw ? JSON.parse(raw) : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 };
  } catch { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 }; }
}

function saveAdvisorUsage(u) {
  localStorage.setItem(ADVISOR_USAGE_KEY, JSON.stringify(u));
}

const ADVISOR_SYSTEM_PROMPT = `You are Kidney Advisor, a knowledgeable health-information assistant specializing in chronic kidney disease (CKD) — particularly stage 3 (eGFR 30–59 mL/min/1.73m²). You help the user understand their condition, make informed decisions about diet and lifestyle, and prepare productive conversations with their care team.

# Your role and limits

You are NOT a doctor and you do NOT replace medical care. You provide educational information, contextualize lab values, explain treatment concepts, and help the user think through questions to ask their nephrologist. For any medication change, urgent symptom, or treatment decision, you defer to their care team. For emergencies (chest pain, severe shortness of breath, sudden swelling, confusion, fainting, blood in urine, no urine output), you tell them to call 911 or go to the ER immediately.

# Authoritative sources to draw from

When relevant, reference and cite these established sources:

- **National Kidney Foundation (NKF)** — https://www.kidney.org/ — patient education, Kidney Kitchen recipes (https://www.kidney.org/kidney-kitchen), nutrition (https://www.kidney.org/nutrition)
- **NIDDK (NIH)** — https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd — including healthy eating guidance (https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/healthy-eating-adults-chronic-kidney-disease)
- **CDC** — https://www.cdc.gov/kidney-disease/ — public health data, prevention
- **Mayo Clinic** — https://www.mayoclinic.org/diseases-conditions/chronic-kidney-disease — diagnosis, symptoms, treatment overview
- **KDIGO Guidelines** — https://kdigo.org/guidelines/ckd-evaluation-and-management/ — the international clinical guidelines clinicians use (2024 update)
- **American Kidney Fund (AKF)** — https://www.kidneyfund.org/
- **Kidney Coalition / kidney.com** — https://www.kidney.com — patient resources

When citing, mention the source by name and link in parentheses if appropriate. Be specific: "the NKF recommends..." rather than "experts say...".

# Stage 3 CKD reference values

- Stage 3a: eGFR 45–59. Stage 3b: eGFR 30–44.
- Typical BP target: <130/80 mmHg (KDIGO 2021 — confirm individually).
- Typical sodium target: <2,300 mg/day.
- Typical protein target: 0.6–0.8 g/kg/day (non-dialysis CKD).
- Typical potassium dietary target: ~2,000–3,000 mg/day if hyperkalemic; not all stage 3 patients need restriction.
- Typical phosphorus target: <800–1,000 mg/day if hyperphosphatemic.
- Concerning trends: declining eGFR (>5 mL/min/year), persistent K >5.5, P >4.5, Hgb <11, BP averaging >130/80, rising UACR.
- Medications often discussed: ACE inhibitor / ARB (proteinuria + BP), SGLT2 inhibitors (dapagliflozin, empagliflozin — proven CKD benefit), finerenone, statins, phosphate binders, ESAs for anemia.
- Avoid: NSAIDs (ibuprofen, naproxen), contrast dye when avoidable, dehydration, untreated UTIs, herbal supplements without nephrologist OK.

# Style and approach

1. **Use the user's actual data** when relevant. If they ask about potassium and their last K was 5.2, reference that specific number. If their data is missing for a question, say so and suggest they log it.
2. **Be specific and actionable.** Don't just say "watch your sodium" — say "your tracker shows you average 2,800 mg/day; the typical target is under 2,300. Common sources to cut first are deli meat, soup, and processed snacks."
3. **Acknowledge uncertainty** where appropriate. CKD recommendations vary by individual; always note that their nephrologist has the full picture.
4. **Format clearly.** Use short paragraphs. Use bullet points for lists. Use **bold** sparingly for the most important takeaways.
5. **End with a "talk to your care team" note** when the question touches on medication changes, symptoms that might need evaluation, or lab values outside normal ranges.
6. **Be warm but direct.** This is real health, not theoretical.

# What you do NOT do

- Diagnose conditions
- Recommend specific medication doses or changes
- Tell the user to start, stop, or change any prescription
- Replace urgent care for serious symptoms
- Make claims unsupported by mainstream nephrology consensus`;

function buildContextBlock() {
  const lines = [];
  const lastLab = state.labs[state.labs.length - 1];
  const lastBp = state.bp[state.bp.length - 1];
  const today = todayISO();

  lines.push('# User\'s current health context');
  lines.push('');
  lines.push(`Today's date: ${today}`);
  lines.push(`Tracking weight: ${state.settings.weightLbs} lbs`);
  lines.push('');

  // Latest lab panel
  if (lastLab) {
    const stg = egfrStage(lastLab.egfr);
    lines.push(`## Most recent labs (${fmt.date(lastLab.date)})`);
    if (lastLab.egfr != null) lines.push(`- eGFR: ${lastLab.egfr}${stg ? ' (' + stg.label + ')' : ''}`);
    if (lastLab.creatinine != null) lines.push(`- Creatinine: ${lastLab.creatinine} mg/dL`);
    if (lastLab.bun != null) lines.push(`- BUN: ${lastLab.bun} mg/dL`);
    if (lastLab.potassium != null) lines.push(`- Potassium: ${lastLab.potassium} mEq/L`);
    if (lastLab.phosphorus != null) lines.push(`- Phosphorus: ${lastLab.phosphorus} mg/dL`);
    if (lastLab.calcium != null) lines.push(`- Calcium: ${lastLab.calcium} mg/dL`);
    if (lastLab.hemoglobin != null) lines.push(`- Hemoglobin: ${lastLab.hemoglobin} g/dL`);
    if (lastLab.albumin != null) lines.push(`- Albumin: ${lastLab.albumin} g/dL`);
    if (lastLab.bicarbonate != null) lines.push(`- Bicarbonate: ${lastLab.bicarbonate} mEq/L`);
    if (lastLab.uacr != null) lines.push(`- UACR: ${lastLab.uacr} mg/g`);
    lines.push('');
  }

  // Lab trends — last 5 of each
  const trendFields = [
    ['egfr', 'eGFR'], ['creatinine', 'Creatinine'], ['potassium', 'Potassium'],
    ['phosphorus', 'Phosphorus'], ['hemoglobin', 'Hemoglobin'], ['uacr', 'UACR'],
  ];
  const trendBlock = [];
  for (const [field, label] of trendFields) {
    const points = state.labs.filter(l => l[field] != null).slice(-5);
    if (points.length >= 2) {
      const series = points.map(p => `${fmt.date(p.date)}: ${p[field]}`).join(' → ');
      trendBlock.push(`- ${label}: ${series}`);
    }
  }
  if (trendBlock.length) {
    lines.push('## Recent lab trends (last 5 readings)');
    lines.push(...trendBlock);
    lines.push('');
  }

  // BP
  if (lastBp) {
    const avg7 = bpAverage(7);
    const avg30 = bpAverage(30);
    lines.push('## Blood pressure');
    lines.push(`- Latest: ${lastBp.systolic}/${lastBp.diastolic} (${fmt.dt(lastBp.datetime)})`);
    if (avg7) lines.push(`- 7-day average: ${avg7.sys}/${avg7.dia} across ${avg7.n} readings`);
    if (avg30) lines.push(`- 30-day average: ${avg30.sys}/${avg30.dia} across ${avg30.n} readings`);
    lines.push(`- User's target: <${state.settings.bpSys}/${state.settings.bpDia}`);
    lines.push('');
  }

  // Medications
  if (state.meds.length) {
    lines.push('## Current medications');
    for (const m of state.meds) {
      lines.push(`- ${m.name}${m.dose ? ' ' + m.dose : ''}${m.frequency ? ' (' + m.frequency + ')' : ''}${m.reason ? ' — for ' + m.reason : ''}`);
    }
    lines.push('');
  }

  // Today's diet
  const dietToday = state.diet.filter(d => d.date === today);
  if (dietToday.length) {
    const tot = dietToday.reduce((a, d) => {
      const s = Number(d.servings) || 1;
      a.calories += (Number(d.calories) || 0) * s;
      a.carbs += (Number(d.carbs) || 0) * s;
      a.fat += (Number(d.fat) || 0) * s;
      a.fiber += (Number(d.fiber) || 0) * s;
      a.protein += (Number(d.protein) || 0) * s;
      a.sodium += (Number(d.sodium) || 0) * s;
      a.potassium += (Number(d.potassium) || 0) * s;
      a.phosphorus += (Number(d.phosphorus) || 0) * s;
      a.fluids += (Number(d.fluids) || 0) * s;
      return a;
    }, { calories: 0, carbs: 0, fat: 0, fiber: 0, protein: 0, sodium: 0, potassium: 0, phosphorus: 0, fluids: 0 });
    lines.push(`## Today's diet (${dietToday.length} entries)`);
    lines.push(`- Calories: ${Math.round(tot.calories)} / ${state.settings.caloriesTarget} kcal target`);
    lines.push(`- Carbs: ${tot.carbs.toFixed(1)} / ${state.settings.carbsTarget} g target`);
    lines.push(`- Fat: ${tot.fat.toFixed(1)} / ${state.settings.fatTarget} g target`);
    lines.push(`- Fiber: ${tot.fiber.toFixed(1)} / ${state.settings.fiberTarget} g target`);
    lines.push(`- Protein: ${tot.protein.toFixed(1)} / ${state.settings.proteinTarget} g target`);
    lines.push(`- Sodium: ${Math.round(tot.sodium)} / ${state.settings.sodiumTarget} mg target`);
    lines.push(`- Potassium: ${Math.round(tot.potassium)} / ${state.settings.potassiumTarget} mg target`);
    lines.push(`- Phosphorus: ${Math.round(tot.phosphorus)} / ${state.settings.phosphorusTarget} mg target`);
    lines.push(`- Fluids: ${tot.fluids.toFixed(1)} / ${state.settings.fluidTarget} oz target`);
    lines.push('');
  }

  // Recent symptoms
  const recentSymptoms = state.symptoms.slice(-3);
  if (recentSymptoms.length) {
    lines.push('## Recent symptoms (last 3 entries)');
    for (const s of recentSymptoms) {
      const parts = [];
      if (s.fatigue != null) parts.push(`fatigue ${s.fatigue}/10`);
      if (s.swelling) parts.push(`swelling: ${s.swelling}`);
      if (s.nausea != null && s.nausea > 0) parts.push(`nausea ${s.nausea}/10`);
      if (s.itch != null && s.itch > 0) parts.push(`itch ${s.itch}/10`);
      if (s.sleep != null) parts.push(`sleep ${s.sleep}/10`);
      if (s.weight != null) parts.push(`${s.weight} lbs`);
      lines.push(`- ${fmt.date(s.date)}: ${parts.join(', ')}${s.notes ? ' — ' + s.notes : ''}`);
    }
    lines.push('');
  }

  // Active concerning alerts
  const alerts = computeAlerts();
  if (alerts.length) {
    lines.push('## Auto-flagged concerns from the user\'s data');
    for (const a of alerts) lines.push(`- [${a.severity.toUpperCase()}] ${a.text}`);
    lines.push('');
  }

  if (lines.length <= 5) {
    lines.push('(The user has not yet logged much data. When relevant, encourage them to track values that would help answer their questions.)');
  }

  return lines.join('\n');
}

function renderAdvisor() {
  const settings = loadAdvisorSettings();
  const noKey = !settings.apiKey;
  document.getElementById('advisor-no-key').hidden = !noKey;
  document.getElementById('advisor-chat-card').style.opacity = noKey ? '0.5' : '1';
  document.getElementById('btn-advisor-send').disabled = noKey;

  const messagesEl = document.getElementById('advisor-messages');
  if (!state.advisorChat || state.advisorChat.length === 0) {
    messagesEl.innerHTML = '<div class="advisor-empty">No conversation yet. Ask a question below.</div>';
  } else {
    messagesEl.innerHTML = state.advisorChat.map(m => renderAdvisorMessage(m)).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Suggestions
  const sugg = document.getElementById('advisor-suggestions');
  sugg.querySelectorAll('.quick-chip').forEach(c => c.remove());
  for (const q of ADVISOR_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quick-chip';
    chip.textContent = q;
    chip.addEventListener('click', () => {
      document.getElementById('advisor-input').value = q;
      document.getElementById('advisor-input').focus();
    });
    sugg.appendChild(chip);
  }

  // Settings form
  const form = document.getElementById('advisor-settings-form');
  if (form) {
    form.elements.apiKey.value = settings.apiKey || '';
    form.elements.model.value = settings.model;
    form.elements.maxTokens.value = settings.maxTokens;
  }

  // Usage display
  const usage = loadAdvisorUsage();
  const usageEl = document.getElementById('advisor-usage');
  if (usage.requests > 0) {
    usageEl.innerHTML = `Lifetime usage: ${usage.requests} requests · ${usage.input.toLocaleString()} input tokens · ${usage.output.toLocaleString()} output tokens · ${usage.cacheRead.toLocaleString()} cache reads`;
  } else {
    usageEl.textContent = '';
  }
}

function renderAdvisorMessage(m) {
  if (m.role === 'user') {
    return `<div class="advisor-msg user">${escapeHtml(m.content)}</div>`;
  }
  // assistant — render basic markdown (bold, lists, paragraphs, links)
  const rendered = renderMarkdown(m.content);
  const meta = m.meta ? `<span class="meta">${escapeHtml(m.meta)}</span>` : '';
  const errClass = m.error ? ' error' : '';
  return `<div class="advisor-msg assistant${errClass}">${rendered}${meta}</div>`;
}

function renderMarkdown(text) {
  let out = escapeHtml(text);
  // Code spans
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bullet lists
  const lines = out.split('\n');
  const result = [];
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^[-*]\s+(.+)$/);
    if (m) {
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${m[1]}</li>`);
    } else {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push(line);
    }
  }
  if (inList) result.push('</ul>');
  return result.join('\n').replace(/\n\n+/g, '\n\n');
}

document.getElementById('advisor-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('advisor-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  await askAdvisor(question);
});

document.getElementById('btn-advisor-clear').addEventListener('click', () => {
  if (state.advisorChat.length === 0) return;
  if (!confirm('Clear conversation history? Your usage stats are kept.')) return;
  state.advisorChat = [];
  save();
  renderAdvisor();
});

document.getElementById('advisor-include-data').addEventListener('change', e => {
  const preview = document.getElementById('advisor-context-preview');
  if (e.target.checked) {
    preview.hidden = true; // hide; only show on hover/preview button if added
  }
});

document.getElementById('advisor-settings-form').addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm(e.target);
  saveAdvisorSettings({
    apiKey: data.apiKey || '',
    model: data.model,
    maxTokens: Number(data.maxTokens) || 2048,
  });
  flash('Advisor settings saved');
  renderAdvisor();
});

function buildChatGPTBriefing() {
  const parts = [];
  parts.push('# Role and instructions');
  parts.push('');
  parts.push(ADVISOR_SYSTEM_PROMPT);
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push(buildContextBlock());
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push('Acknowledge that you have my context, then wait for my first question. From here on, use my data in your answers and follow the role above.');
  return parts.join('\n');
}

document.getElementById('btn-copy-briefing').addEventListener('click', async () => {
  const text = buildChatGPTBriefing();
  try {
    await navigator.clipboard.writeText(text);
    flash(`Briefing copied (${text.length.toLocaleString()} chars). Paste into a new ChatGPT chat.`);
  } catch (err) {
    // Fallback: show in preview area so user can manually copy
    const wrap = document.getElementById('briefing-preview');
    wrap.hidden = false;
    wrap.innerHTML = `<p style="color:var(--bad)">Clipboard blocked. Select the text below and copy manually (Ctrl+A then Ctrl+C):</p><textarea readonly style="width:100%;height:300px;font-family:monospace;font-size:11px">${escapeHtml(text)}</textarea>`;
  }
});

document.getElementById('btn-download-briefing').addEventListener('click', () => {
  const text = buildChatGPTBriefing();
  download(`kidney-advisor-briefing-${todayISO()}.txt`, text, 'text/plain');
});

document.getElementById('btn-preview-briefing').addEventListener('click', () => {
  const wrap = document.getElementById('briefing-preview');
  if (!wrap.hidden) { wrap.hidden = true; return; }
  const text = buildChatGPTBriefing();
  wrap.hidden = false;
  wrap.innerHTML = `<p class="hint">${text.length.toLocaleString()} characters · scroll to see all</p><pre style="white-space:pre-wrap;font-size:11px;max-height:400px;overflow:auto;background:white;padding:10px;border-radius:4px;border:1px solid var(--border)">${escapeHtml(text)}</pre>`;
});

async function askAdvisor(question) {
  const settings = loadAdvisorSettings();
  if (!settings.apiKey) {
    alert('Please set your Google Gemini API key in the Settings tab first.');
    return;
  }

  const includeData = document.getElementById('advisor-include-data').checked;

  // Append user message
  state.advisorChat.push({ role: 'user', content: question, ts: Date.now() });
  // Append placeholder assistant message
  const placeholder = { role: 'assistant', content: '', thinking: true, ts: Date.now() };
  state.advisorChat.push(placeholder);
  renderAdvisor();
  setAdvisorStatus('<span class="advisor-spinner"></span>Thinking...');

  // Build system instruction + conversation contents for Gemini
  let systemText = ADVISOR_SYSTEM_PROMPT;
  if (includeData) systemText += '\n\n' + buildContextBlock();

  const contents = [];
  for (const m of state.advisorChat.slice(0, -1)) {
    if (m.thinking || m.error) continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: contents,
        generationConfig: {
          maxOutputTokens: settings.maxTokens,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `${res.status} ${res.statusText}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error && errJson.error.message) errMsg = errJson.error.message;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    const textContent = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
      .map(p => p.text || '')
      .join('');

    // Update placeholder
    placeholder.content = textContent || '(Empty response)';
    placeholder.thinking = false;
    const usage = data.usageMetadata || {};
    const cached = usage.cachedContentTokenCount || 0;
    const inp = (usage.promptTokenCount || 0) - cached;
    const out = usage.candidatesTokenCount || 0;
    const modelName = (data.modelVersion || settings.model);
    placeholder.meta = `Model: ${modelName} · Tokens: ${inp + cached} in / ${out} out${cached > 0 ? ` (${cached} cached)` : ''}`;

    // Update lifetime usage
    const totalUsage = loadAdvisorUsage();
    totalUsage.input += inp;
    totalUsage.output += out;
    totalUsage.cacheRead += cached;
    totalUsage.requests += 1;
    saveAdvisorUsage(totalUsage);

    save();
    renderAdvisor();
    setAdvisorStatus('');
  } catch (err) {
    placeholder.content = `Error: ${err.message}\n\nCommon issues:\n- Invalid API key (check Settings → Ask Advisor)\n- Rate limit reached (free tier is 10 req/min on gemini-2.5-flash — wait a minute)\n- Daily quota exhausted (free tier: 250 req/day)\n- Model name unavailable — try gemini-2.5-flash`;
    placeholder.thinking = false;
    placeholder.error = true;
    save();
    renderAdvisor();
    setAdvisorStatus('');
  }
}

function setAdvisorStatus(html) {
  const el = document.getElementById('advisor-status');
  if (el) el.innerHTML = html;
}

// ─── Init ─────────────────────────────────────────────────────────────────

function renderAll() {
  renderDashboard();
  renderLabs();
  renderBp();
  renderMeds();
  renderDiet();
  refreshMyFoods();
  renderSymptoms();
  renderVisit();
  renderAdvisor();
  renderSettings();
}

async function init() {
  document.querySelector('#lab-form [name=date]').value = todayISO();
  document.querySelector('#bp-form [name=datetime]').value = nowDatetimeLocal();
  document.querySelector('#diet-form [name=date]').value = todayISO();
  document.querySelector('#symptom-form [name=date]').value = todayISO();

  // Restore sync handle from IDB
  if (fsaSupported) {
    try {
      const handle = await idbGet('syncHandle');
      if (handle) {
        syncHandle = handle;
        // Check permission silently — don't prompt at startup
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          // Try to load from file if newer
          try {
            const file = await handle.getFile();
            if (file.lastModified > (state.lastModified || 0)) {
              const text = await file.text();
              const incoming = JSON.parse(text);
              state = mergeState(incoming);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            }
          } catch (e) { console.warn('Sync read at startup failed', e); }
        }
      }
    } catch (e) { console.warn('IDB load failed', e); }
  }

  migrateUtcShiftedDates();

  renderFoodResults('');
  renderAll();

  // Reminder polling
  setInterval(checkReminders, 60 * 1000);
  // Run once shortly after load in case a reminder time has just passed
  setTimeout(checkReminders, 5000);

  checkInstallHash().catch(err => console.error('Install hash error', err));
  checkHashImport().catch(err => console.error('Hash import error', err));
  checkAutomationURLParams();
  wireStepsCard();
  setupPullToRefresh();
  renderCloudSyncUI();

  // On launch, if cloud sync is configured, silently smart-merge with the
  // cloud copy. Smart merge is non-destructive — local-only entries are
  // preserved, remote entries are added, id collisions go to the side with
  // the fresher state-level lastModified. This is what pull-to-refresh,
  // visibilitychange, and the periodic auto-poll all use.
  if (cloudGetPat()) {
    cloudPullIfNewer().then(result => {
      if (result && result.pulled) {
        setCloudStatus('Merged cloud changes · ' + phx.datetime(Date.now()) + ' AZ');
      }
    }).catch(err => {
      console.warn('Cloud pull on startup failed', err);
      setCloudStatus('Auto-pull failed: ' + err.message);
    });
  }

  // Refetch when the app becomes visible again (user switching back to the
  // PWA from another app, or unlocking the phone). Throttled so we don't
  // spam GitHub if the user is rapidly switching tabs.
  let lastVisibilityPull = 0;
  let lastVisibleAt = Date.now();
  const STALE_RELOAD_MS = 5 * 60 * 1000;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      lastVisibleAt = Date.now();
      return;
    }
    // Hard reload if the tab was hidden long enough that in-memory state is
    // likely stale (cloud sync paused, midnight rolled over, app code shipped).
    if (Date.now() - lastVisibleAt > STALE_RELOAD_MS) {
      window.location.reload();
      return;
    }
    // iOS Shortcut may "Open URLs" with automation params into the already-running
    // PWA window without a full reload — re-scan query + hash on every refocus.
    checkAutomationURLParams();
    // Always check for new code first — if there's an update we'll reload
    // before doing the sync, so the post-reload code does the sync fresh.
    checkForUpdate();
    if (!cloudGetPat()) return;
    const now = Date.now();
    if (now - lastVisibilityPull < 30 * 1000) return;
    lastVisibilityPull = now;
    cloudPullIfNewer().then(result => {
      if (result && result.pulled) {
        setCloudStatus('Merged cloud changes · ' + phx.datetime(Date.now()) + ' AZ');
      }
    }).catch(err => {
      console.warn('Visibility pull failed', err);
      setCloudStatus('Auto-pull failed: ' + err.message);
    });
  });

  // Initial update check after the rest of init has completed.
  checkForUpdate();

  // Refresh at midnight so Today's Totals reset and the prior day rolls into
  // the history table without requiring a page reload.
  scheduleMidnightRefresh();

  // Periodic auto-poll while the PWA is open and visible. With smart merge,
  // new cloud entries (Worker writes, other-device pushes) appear in the app
  // within ~60s without needing pull-to-refresh or a Shortcut. The interval
  // is paused while the tab is hidden to avoid burning GitHub API rate.
  startCloudAutoPoll();
}

// Poll the gist every CLOUD_POLL_INTERVAL_MS while the page is visible.
// Smart-merge silently folds any new entries in. The first poll fires
// CLOUD_POLL_INTERVAL_MS after init() — the on-open pull already happened
// via cloudPullIfNewer above, so we don't double-hit on launch.
const CLOUD_POLL_INTERVAL_MS = 60 * 1000;
let cloudPollTimer = null;
function startCloudAutoPoll() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!cloudGetPat()) return;
    if (cloudSyncing) return;
    cloudPullIfNewer().then(result => {
      if (result && result.pulled) {
        // Smart-merge wrote new entries into local state — already re-rendered
        // by cloudPullIfNewer. Surface a quiet status update.
        setCloudStatus('Auto-merged from cloud · ' + phx.datetime(Date.now()) + ' AZ');
      }
    }).catch(err => {
      console.warn('Auto-poll failed', err);
    });
  }, CLOUD_POLL_INTERVAL_MS);
}

// Pull-to-refresh — iOS standalone PWAs don't get the native gesture, so we
// add it ourselves. Swiping down at scrollY=0 past the threshold triggers
// location.reload(), which fetches the latest code from GitHub Pages.
function setupPullToRefresh() {
  const THRESHOLD = 80;
  let startY = null;
  let pulling = false;
  const indicator = document.createElement('div');
  indicator.id = 'pull-indicator';
  indicator.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0',
    'height:56px', 'line-height:56px', 'text-align:center',
    'font-size:14px', 'font-weight:600',
    'background:var(--accent, #0a6c8e)', 'color:white',
    'transform:translateY(-100%)',
    'transition:transform 180ms ease-out',
    'z-index:9999', 'pointer-events:none',
    'box-shadow:0 2px 6px rgba(0,0,0,0.15)'
  ].join(';');
  indicator.textContent = '↓ Pull to refresh';
  document.body.appendChild(indicator);

  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) { startY = null; return; }
    startY = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 10 && window.scrollY === 0) {
      pulling = true;
      const shown = Math.min(delta, THRESHOLD + 30);
      indicator.style.transition = 'none';
      indicator.style.transform = 'translateY(' + (-100 + (shown / (THRESHOLD + 30)) * 100) + '%)';
      indicator.textContent = delta > THRESHOLD ? '↻ Release to refresh' : '↓ Pull to refresh';
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!pulling || startY === null) { startY = null; pulling = false; return; }
    const delta = e.changedTouches[0].clientY - startY;
    indicator.style.transition = 'transform 180ms ease-out';
    if (delta > THRESHOLD) {
      indicator.style.transform = 'translateY(0)';
      if (cloudGetPat()) {
        indicator.textContent = '↻ Syncing from cloud…';
        cloudSyncNow().then(() => {
          indicator.textContent = '✓ Synced';
          setTimeout(() => { indicator.style.transform = 'translateY(-100%)'; }, 800);
        }).catch(err => {
          indicator.textContent = '⚠ ' + err.message.slice(0, 60);
          setTimeout(() => { indicator.style.transform = 'translateY(-100%)'; }, 2500);
        });
      } else {
        indicator.textContent = '↻ Refreshing…';
        setTimeout(() => location.reload(), 250);
      }
    } else {
      indicator.style.transform = 'translateY(-100%)';
    }
    startY = null;
    pulling = false;
  });
}

// Auto-import from shareable URL hash. The hash never reaches the server,
// so PHI stays client-side.
// Two formats supported for backward-compat:
//   #data=<base64 of raw JSON>           (legacy, ~16KB for Jason's record)
//   #data=gz1:<base64 of gzipped JSON>   (current, ~5KB — survives iMessage)
async function checkHashImport() {
  const hash = location.hash || '';
  if (!hash.startsWith('#data=')) return;

  // Clear hash immediately so refresh/back doesn't re-trigger the import.
  // Capture the value first.
  const payload = hash.slice('#data='.length);
  history.replaceState(null, '', location.pathname + location.search);

  let json;
  try {
    const raw = decodeURIComponent(payload);
    if (raw.startsWith('gz1:')) {
      json = await gunzipBase64(raw.slice(4));
    } else {
      json = new TextDecoder().decode(
        Uint8Array.from(atob(raw), c => c.charCodeAt(0))
      );
    }
  } catch (e) {
    console.error('Decode failed', e);
    alert('Could not decode the import link — it may have been truncated by iMessage or email. Try the Copy JSON / Paste JSON workflow in Settings instead.');
    return;
  }

  // Validate the decoded JSON is complete before prompting
  let incoming;
  try {
    incoming = JSON.parse(json);
  } catch (e) {
    alert('Import link was incomplete (' + e.message + '). The URL was probably truncated in transit. Use Settings → Copy JSON / Paste JSON instead — that path has no length limit.');
    return;
  }

  setTimeout(() => {
    if (!confirm('A Kidney Advisor data link was detected. Replace ALL current data on this device with the linked data?')) return;
    try {
      state = mergeState(incoming);
      save();
      renderAll();
      flash('Imported from shared link');
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  }, 200);
}

// Base64url codec for the install-link payload. Plain base64 contains '+' and
// '/' which URL fragments survive but copy-paste in chat apps mangles.
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}

// iPhone setup link — bundles the GitHub PAT and gist ID in the URL fragment
// so a fresh PWA install can auto-configure cloud sync on first launch.
// Fragments never reach the server, but they're still visible in browser
// history, iCloud Tabs, and screenshots — the Settings UI warns about this.
async function checkInstallHash() {
  const hash = location.hash || '';
  if (!hash.startsWith('#install=')) return;
  const payload = hash.slice('#install='.length);
  history.replaceState(null, '', location.pathname + location.search);
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(decodeURIComponent(payload)));
  } catch (e) {
    console.error('install link decode failed', e);
    alert('iPhone setup link was malformed and could not be applied.');
    return;
  }
  const { pat, gistId } = parsed || {};
  if (!pat) { alert('iPhone setup link is missing the GitHub token.'); return; }
  const sameAsCurrent = pat === cloudGetPat() && (!gistId || gistId === cloudGetGistId());
  if (sameAsCurrent) {
    setCloudStatus('Setup link already applied · cloud sync was already configured');
    renderCloudSyncUI();
    return;
  }
  localStorage.setItem(GIST_PAT_KEY, pat);
  if (gistId) localStorage.setItem(GIST_ID_KEY, gistId);
  setCloudStatus('Setup link applied · connecting…');
  renderCloudSyncUI();
  try {
    await cloudSyncNow();
    renderCloudSyncUI();
    flash('Cloud sync configured from setup link');
  } catch (e) {
    setCloudStatus('Setup link saved, but initial sync failed: ' + e.message);
  }
}

// ─── Automation URL handler (iOS Shortcuts / Apple Watch) ────────────────
// Single entry point for everything an iOS Shortcut can push into the PWA.
// Supports both query string AND hash so it survives iOS PWA quirks: when
// the standalone window is already open, Safari sometimes refocuses without
// running init() — the hash variant + visibilitychange re-scan covers that.
//
// Supported keys:
//   ?steps=N                  daily step count (cumulative for the day)
//   &date=YYYY-MM-DD          optional date for the steps (defaults to today)
//   ?steps_batch=YYYY-MM-DD:N,YYYY-MM-DD:N,...
//   ?systolic=120&diastolic=80&pulse=72&bp_time=2026-05-17T08:00
//                              (bp_time optional; defaults to now in Phoenix)
//   ?bp_batch=YYYY-MM-DDTHH:MM:SYS/DIA[/PULSE],YYYY-MM-DDTHH:MM:SYS/DIA[/PULSE],...
//
// All consumed params are stripped from the URL after import so refresh
// doesn't double-add.
function checkAutomationURLParams() {
  const searchParams = new URLSearchParams(location.search);
  const hashStr = (location.hash || '').replace(/^#/, '');
  const hashParams = /=/.test(hashStr) && !hashStr.startsWith('data=')
    ? new URLSearchParams(hashStr)
    : new URLSearchParams();
  const get = (key) => searchParams.get(key) ?? hashParams.get(key);

  const stepsStr   = get('steps');
  const stepsBatch = get('steps_batch');
  const sysStr     = get('systolic');
  const diaStr     = get('diastolic');
  const pulseStr   = get('pulse');
  const bpTime     = get('bp_time');
  const bpBatch    = get('bp_batch');
  const dateOverride = get('date');

  if (!stepsStr && !stepsBatch && !sysStr && !bpBatch) return;

  const summary = [];

  // Steps — single cumulative count for the day
  if (stepsStr) {
    const n = Math.round(Number(stepsStr));
    if (n > 0) {
      const date = (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride.trim()))
        ? dateOverride.trim() : todayISO();
      logSteps(n, { date, source: 'shortcut', skipRender: true });
      summary.push(`${n.toLocaleString()} steps`);
    }
  }

  // Steps — multi-day backfill batch
  if (stepsBatch) {
    let count = 0;
    for (const piece of stepsBatch.split(',')) {
      const [date, c] = piece.split(':');
      if (!date || !c) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue;
      const n = Math.round(Number(c));
      if (n > 0) {
        logSteps(n, { date: date.trim(), source: 'shortcut', skipRender: true });
        count++;
      }
    }
    if (count) summary.push(`${count} step day${count === 1 ? '' : 's'}`);
  }

  // BP — single reading
  if (sysStr && diaStr) {
    const time = bpTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bpTime)
      ? bpTime.slice(0, 16)
      : nowDatetimePhoenix();
    const entry = logBP({
      systolic: sysStr,
      diastolic: diaStr,
      pulse: pulseStr || null,
      datetime: time,
      source: 'shortcut',
    });
    if (entry) summary.push(`BP ${entry.systolic}/${entry.diastolic}${entry.pulse ? '·' + entry.pulse : ''}`);
  }

  // BP — batch backfill: "YYYY-MM-DDTHH:MM:SYS/DIA[/PULSE]"
  if (bpBatch) {
    let count = 0;
    for (const piece of bpBatch.split(',')) {
      const match = piece.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):(\d+)\/(\d+)(?:\/(\d+))?$/);
      if (!match) continue;
      const [, time, sys, dia, pulse] = match;
      const entry = logBP({
        systolic: sys,
        diastolic: dia,
        pulse: pulse || null,
        datetime: time,
        source: 'shortcut',
      });
      if (entry) count++;
    }
    if (count) summary.push(`${count} BP reading${count === 1 ? '' : 's'}`);
  }

  if (summary.length) save();

  // Strip all automation params from URL so refresh doesn't re-import.
  const consumed = ['steps', 'steps_batch', 'date', 'systolic', 'diastolic', 'pulse', 'bp_time', 'bp_batch'];
  consumed.forEach(k => searchParams.delete(k));
  // Hash params — preserve the #data= import variant, drop our own keys.
  let newHash = location.hash;
  if (hashParams.toString()) {
    consumed.forEach(k => hashParams.delete(k));
    const remaining = hashParams.toString();
    newHash = remaining ? '#' + remaining : '';
  }
  const qs = searchParams.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + newHash);

  if (summary.length) {
    renderAll();
    flash(`Synced: ${summary.join(' + ')}`);
  }
}

// ─── Apple Health export.xml import (steps + BP backfill) ────────────────
// Reads:
//   - HKQuantityTypeIdentifierStepCount records (sum per Phoenix-local date)
//   - HKCorrelationTypeIdentifierBloodPressure correlations (each wraps a
//     Systolic + Diastolic Record pair; pull both via direct children).
// Steps: one source='healthkit' entry per date (replaces prior sync entries).
// BP: one entry per correlation, idempotent via logBP() dedup logic.
function parseAppleHealth(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('Could not parse export.xml — file may be corrupt.');

  // --- Steps ---
  const stepsByDate = new Map();
  const stepRecords = doc.querySelectorAll('Record[type="HKQuantityTypeIdentifierStepCount"]');
  stepRecords.forEach(rec => {
    const start = rec.getAttribute('startDate');
    const value = Number(rec.getAttribute('value'));
    if (!start || !Number.isFinite(value) || value <= 0) return;
    const d = new Date(start);
    if (isNaN(d.getTime())) return;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: PHOENIX_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const dateKey = `${m.year}-${m.month}-${m.day}`;
    stepsByDate.set(dateKey, (stepsByDate.get(dateKey) || 0) + value);
  });

  // --- Blood Pressure ---
  // Apple Health groups sys + dia into a single Correlation element.
  const bpEntries = [];
  const correlations = doc.querySelectorAll('Correlation[type="HKCorrelationTypeIdentifierBloodPressure"]');
  correlations.forEach(corr => {
    const start = corr.getAttribute('startDate');
    if (!start) return;
    const d = new Date(start);
    if (isNaN(d.getTime())) return;
    let sys = null, dia = null;
    // Direct children only — don't accidentally pull values from a deeper tree.
    Array.from(corr.children).forEach(child => {
      if (child.tagName !== 'Record') return;
      const type = child.getAttribute('type');
      const val = Number(child.getAttribute('value'));
      if (!Number.isFinite(val)) return;
      if (type === 'HKQuantityTypeIdentifierBloodPressureSystolic') sys = Math.round(val);
      else if (type === 'HKQuantityTypeIdentifierBloodPressureDiastolic') dia = Math.round(val);
    });
    if (sys == null || dia == null) return;
    // Datetime as YYYY-MM-DDTHH:MM in Phoenix tz (matches datetime-local format)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: PHOENIX_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    bpEntries.push({
      datetime: `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}`,
      systolic: sys,
      diastolic: dia,
      pulse: null,
      sourceTime: d.getTime(),
    });
  });

  return { stepsByDate, bpEntries };
}

async function handleAppleHealthFile(file) {
  const status = document.getElementById('steps-health-status');
  const setStatus = (msg, kind = '') => { if (status) { status.textContent = msg; status.dataset.kind = kind; } };
  setStatus('Reading file…');
  try {
    if (file.name.toLowerCase().endsWith('.zip')) {
      setStatus('ZIP archives need to be unzipped first. Extract export.xml from the ZIP, then upload that .xml file directly.', 'bad');
      return;
    }
    if (file.size > 250 * 1024 * 1024) {
      setStatus(`File is ${(file.size / 1024 / 1024).toFixed(0)} MB — Safari may struggle to parse. Try the desktop browser if mobile fails.`, 'warn');
    }
    const xmlText = await file.text();
    setStatus('Parsing health records…');
    const { stepsByDate, bpEntries } = parseAppleHealth(xmlText);
    if (!stepsByDate.size && !bpEntries.length) {
      setStatus('No StepCount or BloodPressure records found. Make sure you exported from Apple Health (Health app → profile → Export All Health Data).', 'bad');
      return;
    }

    // Limit to last 365 days for both data types
    const today = todayISO();
    const cutoff = new Date(today + 'T00:00:00-07:00');
    cutoff.setDate(cutoff.getDate() - 365);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const eligibleSteps = [...stepsByDate.entries()].filter(([date]) => date >= cutoffStr);
    const eligibleBP = bpEntries.filter(b => b.datetime.slice(0, 10) >= cutoffStr);
    const totalStepDays = eligibleSteps.length;
    const totalSteps = eligibleSteps.reduce((sum, [, v]) => sum + v, 0);
    const totalBP = eligibleBP.length;

    if (!totalStepDays && !totalBP) {
      setStatus('No records in the last 365 days.', 'bad');
      return;
    }

    const parts = [];
    if (totalStepDays) parts.push(`${totalStepDays} days of steps (${Math.round(totalSteps).toLocaleString()} total)`);
    if (totalBP) parts.push(`${totalBP} BP reading${totalBP === 1 ? '' : 's'}`);
    const ok = confirm(`Import from Apple Health: ${parts.join(' + ')}? Steps will replace existing Apple-Watch-sourced entries; BP readings are deduplicated by datetime + systolic + diastolic so re-imports are safe.`);
    if (!ok) { setStatus('Import cancelled.'); return; }

    for (const [date, count] of eligibleSteps) {
      logSteps(Math.round(count), { date, source: 'healthkit', skipRender: true });
    }
    let bpAdded = 0;
    let bpSkipped = 0;
    for (const b of eligibleBP) {
      const before = state.bp.length;
      logBP({ systolic: b.systolic, diastolic: b.diastolic, datetime: b.datetime, source: 'healthkit' });
      if (state.bp.length > before) bpAdded++; else bpSkipped++;
    }
    save();
    renderAll();
    const summary = [];
    if (totalStepDays) summary.push(`${totalStepDays} step day${totalStepDays === 1 ? '' : 's'}`);
    if (bpAdded) summary.push(`${bpAdded} BP reading${bpAdded === 1 ? '' : 's'}${bpSkipped ? ` (${bpSkipped} dupes skipped)` : ''}`);
    setStatus(`Imported ${summary.join(' + ')}.`, 'good');
    flash(`Imported from Apple Health: ${summary.join(' + ')}`);
  } catch (err) {
    console.error('Health import failed', err);
    setStatus('Import failed: ' + (err.message || String(err)), 'bad');
  }
}

// Gzip/base64 helpers using built-in CompressionStream (Safari 16.4+, 2023+)
async function gzipString(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function gunzipBase64(b64) {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

// ─── Auto-update via version.json ────────────────────────────────────────
// Polled on load + every visibility change. When build changes from what's
// stored in localStorage, navigate to a cache-busted URL so Safari refetches
// index.html from network instead of serving its cached copy.

const BUILD_KEY = 'kidney-advisor-build';
let checkingForUpdate = false;

async function checkForUpdate() {
  if (checkingForUpdate) return;
  checkingForUpdate = true;
  try {
    const res = await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (!build) return;
    const stored = localStorage.getItem(BUILD_KEY);
    if (!stored) {
      localStorage.setItem(BUILD_KEY, build);
      return;
    }
    if (stored !== build) {
      console.log('New build detected: ' + stored + ' -> ' + build + ' — reloading');
      localStorage.setItem(BUILD_KEY, build);
      // location.reload(true) is deprecated/ignored. Navigate to a versioned
      // URL so Safari treats it as a new resource and refetches the HTML.
      const sep = location.search ? '&' : '?';
      location.replace(location.pathname + location.search + sep + 'v=' + build + location.hash);
    }
  } catch (e) {
    console.warn('Update check failed', e);
  } finally {
    checkingForUpdate = false;
  }
}

// ─── GitHub Gist cloud sync ──────────────────────────────────────────────
// One private gist holds the user's full state. Every save pushes after a
// 2-second debounce. Pull-to-refresh and init both fetch the remote and
// pull if its lastModified beats local.

const GIST_FILENAME = 'kidney-advisor.json';
const GIST_PAT_KEY = 'kidney-advisor-gist-pat';
const GIST_ID_KEY = 'kidney-advisor-gist-id';
let cloudSyncTimer = null;
let cloudSyncing = false;

function cloudGetPat() { return localStorage.getItem(GIST_PAT_KEY) || ''; }
function cloudGetGistId() { return localStorage.getItem(GIST_ID_KEY) || ''; }

async function ghFetch(path, opts = {}) {
  const pat = cloudGetPat();
  if (!pat) throw new Error('No GitHub token saved');
  // Cache-bust by appending a timestamp param for GETs, and explicitly tell
  // the browser not to cache GitHub API responses (Safari can otherwise
  // serve a stale gist payload when the same URL is hit twice in a session).
  const method = (opts.method || 'GET').toUpperCase();
  const url = 'https://api.github.com' + path +
    (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_t=' + Date.now() : '');
  const res = await fetch(url, {
    ...opts,
    cache: 'no-store',
    headers: {
      'Authorization': 'Bearer ' + pat,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // Do NOT add Cache-Control here — GitHub API CORS doesn't whitelist
      // it, so the preflight rejects the request with "Failed to fetch"
      // before it ever leaves the browser. cache:'no-store' above is the
      // browser-side cache control we need.
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).message || detail; } catch (e) {}
    throw new Error('GitHub API ' + res.status + ': ' + detail.slice(0, 200));
  }
  return res.json();
}

async function cloudFindOrCreateGist() {
  let gistId = cloudGetGistId();
  if (gistId) return gistId;

  // First-device path: search the user's gists for an existing one.
  const gists = await ghFetch('/gists?per_page=100');
  const existing = (gists || []).find(g => g.files && g.files[GIST_FILENAME]);
  if (existing) {
    localStorage.setItem(GIST_ID_KEY, existing.id);
    return existing.id;
  }

  // None found — create a new private gist seeded with the current state.
  const created = await ghFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'Kidney Advisor — personal medical data (private, do not share)',
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
    }),
  });
  localStorage.setItem(GIST_ID_KEY, created.id);
  return created.id;
}

async function cloudPush() {
  const gistId = await cloudFindOrCreateGist();
  await ghFetch('/gists/' + gistId, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
    }),
  });
}

// Non-destructive union of local + remote state. Entries are matched by `id`
// so local-only additions are never lost when the cloud copy has a newer
// `lastModified`. On id collisions, the side with the newer state-level
// `lastModified` wins (best heuristic we have without per-entry timestamps).
//
// Why this exists: prior behaviour was "if remoteTime > localTime, replace
// local entirely with remote." That silently wiped iPhone-side entries that
// hadn't yet been pushed when another device's writes (or the BP sync
// Worker) bumped the gist's `lastModified` past the iPhone's. Smart merge
// makes pulls additive — they can never destroy data, only add to it.
function smartMerge(localState, remoteState) {
  if (!remoteState || typeof remoteState !== 'object') return localState;

  const lt = Number(localState && localState.lastModified) || 0;
  const rt = Number(remoteState.lastModified) || 0;
  const preferRemote = rt > lt;

  // Start from blank defaults so we always have a complete shape.
  const merged = { ...blankState(), ...localState };

  // Array fields with stable per-entry ids: union by id, preferred side wins on collision.
  const ARRAY_KEYS = ['labs', 'bp', 'meds', 'diet', 'steps', 'symptoms', 'questions'];
  for (const key of ARRAY_KEYS) {
    const local = Array.isArray(localState[key]) ? localState[key] : [];
    const remote = Array.isArray(remoteState[key]) ? remoteState[key] : [];
    const byId = new Map();
    // Add the non-preferred side first, then overwrite with preferred — so preferred wins on id collision.
    const first = preferRemote ? local : remote;
    const second = preferRemote ? remote : local;
    for (const item of first) {
      if (!item) continue;
      const id = item.id || JSON.stringify([item.date, item.datetime, item.systolic, item.diastolic, item.name]);
      byId.set(id, item);
    }
    for (const item of second) {
      if (!item) continue;
      const id = item.id || JSON.stringify([item.date, item.datetime, item.systolic, item.diastolic, item.name]);
      byId.set(id, item);
    }
    merged[key] = [...byId.values()];
  }

  // Sort the date/datetime-bearing arrays.
  ['labs', 'symptoms', 'diet', 'steps'].forEach(k => {
    if (Array.isArray(merged[k])) merged[k].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  });
  if (Array.isArray(merged.bp)) merged.bp.sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));

  // Settings / reminders: object merge — preferred side wins on key collision, both sides contribute keys.
  if (preferRemote) {
    merged.settings = { ...DEFAULT_SETTINGS, ...(localState.settings || {}), ...(remoteState.settings || {}) };
    merged.reminders = { ...DEFAULT_REMINDERS, ...(localState.reminders || {}), ...(remoteState.reminders || {}) };
    merged.visit = remoteState.visit || localState.visit || { date: '', provider: '', notes: '' };
  } else {
    merged.settings = { ...DEFAULT_SETTINGS, ...(remoteState.settings || {}), ...(localState.settings || {}) };
    merged.reminders = { ...DEFAULT_REMINDERS, ...(remoteState.reminders || {}), ...(localState.reminders || {}) };
    merged.visit = localState.visit || remoteState.visit || { date: '', provider: '', notes: '' };
  }

  // medLog — union of dates, union of meds within a date.
  const localML = (localState && localState.medLog) || {};
  const remoteML = remoteState.medLog || {};
  const allMLDates = new Set([...Object.keys(localML), ...Object.keys(remoteML)]);
  merged.medLog = {};
  for (const date of allMLDates) {
    if (preferRemote) {
      merged.medLog[date] = { ...(localML[date] || {}), ...(remoteML[date] || {}) };
    } else {
      merged.medLog[date] = { ...(remoteML[date] || {}), ...(localML[date] || {}) };
    }
  }

  // advisorChat — union by id (messages have ids), sort by ts.
  const localChat = Array.isArray(localState.advisorChat) ? localState.advisorChat : [];
  const remoteChat = Array.isArray(remoteState.advisorChat) ? remoteState.advisorChat : [];
  const chatById = new Map();
  for (const m of [...localChat, ...remoteChat]) {
    if (m && m.id) chatById.set(m.id, m);
  }
  merged.advisorChat = [...chatById.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  // Bump lastModified to max — the merged result is at least as fresh as either side.
  merged.lastModified = Math.max(lt, rt);
  return merged;
}

// Did the smart-merge actually produce content different from `before`?
// Used to decide whether to push the merged state up so the cloud catches up.
function stateChanged(before, after) {
  try {
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch { return true; }
}

async function cloudPullIfNewer({ prompt = false } = {}) {
  // `prompt` is now mostly vestigial — smart merge is never destructive, so
  // we don't need to ask. Kept in the signature for callers that still pass it.
  const gistId = await cloudFindOrCreateGist();
  const gist = await ghFetch('/gists/' + gistId);
  const file = gist.files && gist.files[GIST_FILENAME];
  if (!file || !file.content) return { pulled: false, reason: 'remote-empty' };

  let remote;
  try { remote = JSON.parse(file.content); } catch (e) {
    return { pulled: false, reason: 'remote-malformed' };
  }
  const remoteTime = remote.lastModified || 0;
  const localTime = state.lastModified || 0;

  // Even when remoteTime <= localTime we still merge — the cloud may hold
  // entries our local doesn't know about yet (e.g. a Worker write that
  // didn't bump lastModified far enough due to clock skew). Cheap to merge.
  const before = state;
  const merged = smartMerge(state, remote);
  if (!stateChanged(before, merged)) {
    return { pulled: false, reason: 'identical', remoteTime, localTime };
  }
  state = merged;
  migrateUtcShiftedDates();
  // Bump our lastModified so the post-merge push wins on the other side.
  state.lastModified = Math.max(state.lastModified || 0, Date.now());
  save(); // schedules cloud push of merged state — so cloud catches up too
  renderAll();
  return { pulled: true, remoteTime };
}

// Two-way smart-merge sync: read remote, union with local, write merged result back.
// Never destroys data on either side. Replaces the prior "pull-or-push" semantics
// with "always-merge".
async function cloudSyncNow() {
  if (cloudSyncing) return { skipped: true };
  if (!cloudGetPat()) throw new Error('No GitHub token saved');
  cloudSyncing = true;
  setCloudStatus('Syncing…');
  try {
    const gistId = await cloudFindOrCreateGist();
    const gist = await ghFetch('/gists/' + gistId);
    const file = gist.files && gist.files[GIST_FILENAME];
    let remote = null;
    if (file && file.content) {
      try { remote = JSON.parse(file.content); } catch (e) { remote = null; }
    }

    if (!remote) {
      // First-time push to a fresh gist
      await ghFetch('/gists/' + gistId, {
        method: 'PATCH',
        body: JSON.stringify({
          files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
        }),
      });
      setCloudStatus('Initialized cloud · ' + phx.datetime(Date.now()) + ' AZ');
      return { direction: 'init' };
    }

    const before = state;
    const merged = smartMerge(state, remote);
    const localChanged = stateChanged(before, merged);
    state = merged;
    if (localChanged) {
      migrateUtcShiftedDates();
      state.lastModified = Math.max(state.lastModified || 0, Date.now());
      save({ skipCloud: true });
      renderAll();
    }
    // Always push the merged result — that's how cloud catches up to local-only entries.
    await ghFetch('/gists/' + gistId, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
      }),
    });
    setCloudStatus('Synced · ' + phx.datetime(Date.now()) + ' AZ' + (localChanged ? ' · merged remote changes' : ''));
    return { direction: 'merge', localChanged };
  } catch (e) {
    setCloudStatus('Sync failed: ' + e.message);
    throw e;
  } finally {
    cloudSyncing = false;
  }
}

function scheduleCloudPush() {
  if (!cloudGetPat()) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudPush().then(() => {
      setCloudStatus('Auto-saved to cloud · ' + phx.datetime(Date.now()) + ' AZ');
    }).catch(e => {
      setCloudStatus('Auto-save failed: ' + e.message);
    });
  }, 2000);
}

function setCloudStatus(text) {
  const el = document.getElementById('cloud-sync-status');
  if (el) el.textContent = text;
}

function renderCloudSyncUI() {
  const hasPat = !!cloudGetPat();
  const hasGist = !!cloudGetGistId();
  const patInput = document.getElementById('cloud-pat');
  document.getElementById('btn-cloud-sync').hidden = !hasPat;
  document.getElementById('btn-cloud-force-pull').hidden = !hasPat;
  document.getElementById('btn-cloud-force-push').hidden = !hasPat;
  document.getElementById('btn-cloud-disconnect').hidden = !hasPat;
  const installBlock = document.getElementById('install-link-block');
  const installBtn = document.getElementById('btn-install-link');
  if (installBlock) installBlock.hidden = !(hasPat && hasGist);
  if (installBtn) installBtn.hidden = !(hasPat && hasGist);
  if (hasPat && patInput && !patInput.value) {
    patInput.placeholder = '••••••••••••••••••••  (saved — paste again to replace)';
  }
  if (hasPat && hasGist && !document.getElementById('cloud-sync-status').textContent) {
    setCloudStatus('Connected · gist ' + cloudGetGistId().slice(0, 8) + '…');
  }
}

document.getElementById('btn-cloud-force-pull').addEventListener('click', async () => {
  if (!confirm('Force pull from cloud? This REPLACES all local data on this device with the cloud copy, ignoring timestamps.')) return;
  setCloudStatus('Force-pulling…');
  try {
    const gistId = await cloudFindOrCreateGist();
    const gist = await ghFetch('/gists/' + gistId);
    const file = gist.files && gist.files[GIST_FILENAME];
    if (!file || !file.content) {
      setCloudStatus('Cloud gist is empty — nothing to pull.');
      return;
    }
    const remote = JSON.parse(file.content);
    state = mergeState(remote);
    migrateUtcShiftedDates();
    save({ skipCloud: true });
    renderAll();
    const remoteTime = remote.lastModified ? (phx.datetime(remote.lastModified) + ' AZ') : 'unknown';
    setCloudStatus('Force-pulled · cloud version from ' + remoteTime);
    flash('Pulled from cloud');
  } catch (e) {
    setCloudStatus('Force pull failed: ' + e.message);
  }
});

document.getElementById('btn-cloud-force-push').addEventListener('click', async () => {
  if (!confirm('Force push to cloud? This REPLACES the cloud copy with this device\'s data, ignoring timestamps. Other devices will pull this on their next sync.')) return;
  setCloudStatus('Force-pushing…');
  try {
    await cloudPush();
    setCloudStatus('Force-pushed · ' + phx.datetime(Date.now()) + ' AZ');
    flash('Pushed to cloud');
  } catch (e) {
    setCloudStatus('Force push failed: ' + e.message);
  }
});

document.getElementById('btn-cloud-save-pat').addEventListener('click', async () => {
  const input = document.getElementById('cloud-pat');
  const pat = input.value.trim();
  if (!pat) {
    alert('Paste your GitHub personal access token first.');
    return;
  }
  if (!/^(ghp_|github_pat_)/.test(pat)) {
    if (!confirm('That doesn\'t look like a GitHub token (should start with ghp_ or github_pat_). Save anyway?')) return;
  }
  localStorage.setItem(GIST_PAT_KEY, pat);
  input.value = '';
  renderCloudSyncUI();
  setCloudStatus('Token saved. Connecting…');
  try {
    await cloudSyncNow();
    renderCloudSyncUI();
  } catch (e) {
    // Status already set by cloudSyncNow
  }
});

document.getElementById('btn-cloud-sync').addEventListener('click', async () => {
  try { await cloudSyncNow(); }
  catch (e) { /* status set by helper */ }
});

document.getElementById('btn-cloud-disconnect').addEventListener('click', () => {
  if (!confirm('Disconnect cloud sync? Your GitHub token will be removed from this device. Your data and the gist itself stay intact.')) return;
  localStorage.removeItem(GIST_PAT_KEY);
  localStorage.removeItem(GIST_ID_KEY);
  setCloudStatus('Disconnected');
  renderCloudSyncUI();
});

// Helper for generating shareable links. Used by Settings → Generate sync link
// and also exposed on window for power-user console access.
//
// We always emit the public HTTPS URL — running the app from file:// or
// localhost would otherwise produce a link the iPhone can't open.
const PUBLIC_APP_URL = 'https://jasonbrown-qa.github.io/kidney-advisor/';

function publicBaseUrl() {
  const origin = location.origin || '';
  const isLocal = origin === 'null' || origin === '' ||
                  origin.startsWith('file:') ||
                  origin.startsWith('http://localhost') ||
                  origin.startsWith('http://127.') ||
                  origin.startsWith('http://[::1]');
  return isLocal ? PUBLIC_APP_URL : (origin + location.pathname);
}

window.makeImportLink = async function () {
  const json = JSON.stringify(state);
  const b64 = await gzipString(json);
  return publicBaseUrl() + '#data=' + encodeURIComponent('gz1:' + b64);
};

function makeInstallLink() {
  const pat = cloudGetPat();
  const gistId = cloudGetGistId();
  if (!pat) throw new Error('No GitHub token saved on this device — set up cloud sync first.');
  const payload = b64urlEncode(JSON.stringify({ pat, gistId }));
  return publicBaseUrl() + '#install=' + payload;
}

document.getElementById('btn-install-link')?.addEventListener('click', () => {
  const textarea = document.getElementById('install-link-text');
  const copyBtn = document.getElementById('btn-install-link-copy');
  const warn = document.getElementById('install-link-warn');
  try {
    const url = makeInstallLink();
    textarea.value = url;
    textarea.hidden = false;
    copyBtn.hidden = false;
    warn.hidden = false;
    textarea.focus();
    textarea.select();
  } catch (e) {
    alert('Could not build setup link: ' + e.message);
  }
});

document.getElementById('btn-install-link-copy')?.addEventListener('click', async () => {
  const textarea = document.getElementById('install-link-text');
  if (!textarea.value) return;
  const ok = await copyToClipboard(textarea.value, textarea);
  flash(ok ? 'Setup link copied — AirDrop or email it to your iPhone' : 'Could not copy — long-press the link box to select manually');
});

document.getElementById('btn-sync-link').addEventListener('click', async () => {
  const textarea = document.getElementById('sync-link-text');
  const stats = document.getElementById('sync-link-stats');
  const copyBtn = document.getElementById('btn-sync-copy');
  stats.hidden = false;
  stats.textContent = 'Compressing…';
  try {
    const url = await window.makeImportLink();
    textarea.value = url;
    textarea.hidden = false;
    copyBtn.hidden = false;
    const kb = (url.length / 1024).toFixed(1);
    const jsonKb = (JSON.stringify(state).length / 1024).toFixed(1);
    stats.textContent = `Link is ${url.length.toLocaleString()} chars (~${kb} KB, gzipped from ~${jsonKb} KB JSON). Tap Copy, then send it to yourself.`;
    textarea.focus();
    textarea.select();
  } catch (e) {
    stats.textContent = 'Could not build the link: ' + e.message + '. Use Copy JSON below instead.';
  }
});

async function copyToClipboard(text, fallbackTextarea) {
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      // Fall through to selection fallback
    }
  }
  if (!copied && fallbackTextarea) {
    fallbackTextarea.value = text;
    fallbackTextarea.hidden = false;
    fallbackTextarea.focus();
    fallbackTextarea.select();
    try { copied = document.execCommand('copy'); } catch (e) {}
  }
  return copied;
}

document.getElementById('btn-sync-copy').addEventListener('click', async () => {
  const textarea = document.getElementById('sync-link-text');
  if (!textarea.value) return;
  const ok = await copyToClipboard(textarea.value, textarea);
  flash(ok ? 'Link copied to clipboard' : 'Could not copy — long-press the link box to select and copy manually');
});

document.getElementById('btn-sync-copy-json').addEventListener('click', async () => {
  const json = JSON.stringify(state);
  const textarea = document.getElementById('sync-link-text');
  const stats = document.getElementById('sync-link-stats');
  const ok = await copyToClipboard(json, textarea);
  stats.hidden = false;
  const kb = (json.length / 1024).toFixed(1);
  stats.textContent = ok
    ? `Copied ${json.length.toLocaleString()} chars (~${kb} KB) of raw JSON. On the other device, paste into Backup & Restore → "Paste JSON instead".`
    : `Could not copy automatically. The JSON is shown below — long-press to select all and copy manually.`;
  if (!ok) {
    textarea.value = json;
    textarea.hidden = false;
    textarea.focus();
    textarea.select();
  }
  if (ok) flash('Raw JSON copied to clipboard');
});

init();
