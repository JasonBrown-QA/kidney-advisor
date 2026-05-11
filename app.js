// Kidney Advisor — local-first CKD stage 3 tracker
// All data lives in localStorage + an optional sync file. No telemetry.

const STORAGE_KEY = 'kidney-advisor-v1';
const FIRED_KEY = 'kidney-advisor-fired';
const ADVISOR_SECRET_KEY = 'kidney-advisor-secret';
const ADVISOR_USAGE_KEY = 'kidney-advisor-usage';

const DEFAULT_SETTINGS = {
  weightLbs: 180,
  sodiumTarget: 2300,
  potassiumTarget: 2500,
  phosphorusTarget: 900,
  proteinTarget: 55,
  fluidTarget: 64,
  caloriesTarget: 2000,
  carbsTarget: 250,
  fatTarget: 65,
  fiberTarget: 28,
  bpSys: 130,
  bpDia: 80,
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
    return mergeState(parsed);
  } catch (e) {
    console.error('Load failed', e);
    return blankState();
  }
}

function mergeState(incoming) {
  return {
    ...blankState(),
    ...incoming,
    settings: { ...DEFAULT_SETTINGS, ...(incoming.settings || {}) },
    reminders: { ...DEFAULT_REMINDERS, ...(incoming.reminders || {}) },
    questions: incoming.questions || [],
    visit: incoming.visit || { date: '', provider: '', notes: '' },
    advisorChat: incoming.advisorChat || [],
  };
}

function blankState() {
  return {
    labs: [],
    bp: [],
    meds: [],
    medLog: {},
    diet: [],
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

const todayISO = () => new Date().toISOString().slice(0, 10);

const fmt = {
  date: iso => iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString() : '',
  dt:   iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
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

function renderDietBars(container) {
  const today = todayISO();
  const todays = state.diet.filter(d => d.date === today);
  const totals = todays.reduce((a, d) => {
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
  ];

  container.innerHTML = bars.map(b => {
    const pct = b.target > 0 ? Math.min(100, (b.value / b.target) * 100) : 0;
    const cls = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
    return `<div class="diet-bar">
      <div class="diet-bar-label">${b.label}</div>
      <div class="diet-bar-track"><div class="diet-bar-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="diet-bar-value">${Math.round(b.value)} / ${b.target} ${b.unit}</div>
    </div>`;
  }).join('');
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

document.getElementById('food-search').addEventListener('input', e => renderFoodResults(e.target.value));

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

async function searchUSDA(query) {
  const wrap = document.getElementById('usda-results');
  if (!query || query.trim().length < 2) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = '<div style="padding:10px;color:var(--text-muted)"><span class="advisor-spinner"></span>Searching USDA…</div>';

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
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const errText = await res.text();
        try {
          const j = JSON.parse(errText);
          if (j.error && j.error.message) msg = j.error.message;
          else if (j.message) msg = j.message;
        } catch {
          if (errText) msg = errText.slice(0, 200);
        }
      } catch {}
      if (res.status === 429) msg = 'USDA rate limit hit. Get your own free key at fdc.nal.usda.gov/api-key-signup.html — adds 1000 requests/hour. Then paste it into Settings → USDA Food Database.';
      if (res.status === 403) msg = 'API key rejected (403). Check your key in Settings → USDA Food Database, or clear the field to use the shared demo key.';
      throw new Error(msg);
    }
    const data = await res.json();
    usdaLastResults = data.foods || [];
    renderUSDAResults(usdaLastResults);
  } catch (err) {
    clearTimeout(timeoutId);
    let display = err.message || String(err);
    let isRateLimit = false;
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
  if (!foods.length) {
    wrap.innerHTML = '<div style="padding:10px;color:var(--text-muted)">No matches. Try a simpler query.</div>';
    return;
  }
  wrap.innerHTML = foods.map((f, i) => {
    const n = extractUSDANutrients(f);
    const brand = f.brandOwner || f.brandName || '';
    const desc = f.description || '';
    const cal = n.calories != null ? `${Math.round(n.calories)} kcal` : '— kcal';
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
    return `<div class="food-card" data-usda-idx="${i}">
      <div class="name">${escapeHtml(desc)}${brand ? ` <span class="food-tag" style="background:#eef;color:#338">${escapeHtml(brand)}</span>` : ''}</div>
      <div class="serving">Per ${escapeHtml(n.servingText)} · ${cal}${macros ? ' · ' + macros : ''}</div>
      ${kidney ? `<div class="stats">${kidney}</div>` : ''}
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-usda-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const food = usdaLastResults[Number(card.dataset.usdaIdx)];
      if (!food) return;
      const n = extractUSDANutrients(food);
      const servings = parseFloat(prompt(`How many servings of "${food.description}"?\n(1 serving = ${n.servingText})`, '1'));
      if (!servings || isNaN(servings) || servings <= 0) return;
      const entry = { id: uid(), date: todayISO(), item: food.description, servings };
      for (const f of ['calories','carbs','fat','fiber','protein','sodium','potassium','phosphorus']) {
        if (n[f] != null) entry[f] = n[f];
      }
      state.diet.push(entry);
      save();
      flash(`Added ${food.description}`);
      renderAll();
    });
  });
}

document.getElementById('usda-search').addEventListener('input', e => {
  clearTimeout(usdaSearchTimer);
  usdaSearchTimer = setTimeout(() => searchUSDA(e.target.value), 400);
});

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

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Erase ALL Kidney Advisor data on this device? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Export first if you want a backup.')) return;
  state = blankState();
  save();
  renderAll();
  flash('All data cleared');
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
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c2733;color:white;padding:10px 18px;border-radius:6px;font-size:13px;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,.2)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
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

  renderFoodResults('');
  renderAll();

  // Reminder polling
  setInterval(checkReminders, 60 * 1000);
  // Run once shortly after load in case a reminder time has just passed
  setTimeout(checkReminders, 5000);

  checkHashImport().catch(err => console.error('Hash import error', err));
  setupPullToRefresh();
  renderCloudSyncUI();

  // On launch, if cloud sync is configured, silently pull if the cloud copy
  // is newer. Asks for confirmation before replacing local data.
  if (cloudGetPat()) {
    cloudPullIfNewer({ prompt: true }).catch(err => {
      console.warn('Cloud pull on startup failed', err);
      setCloudStatus('Auto-pull failed: ' + err.message);
    });
  }
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
        cloudSyncNow({ prompt: true }).then(() => {
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
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + pat,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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

async function cloudPullIfNewer({ prompt = true } = {}) {
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
  if (remoteTime <= localTime + 1000) {
    return { pulled: false, reason: 'local-up-to-date', remoteTime, localTime };
  }
  if (prompt) {
    const when = remoteTime ? new Date(remoteTime).toLocaleString() : 'unknown time';
    if (!confirm('Cloud has newer data (saved ' + when + '). Replace local data with the cloud copy?')) {
      return { pulled: false, reason: 'user-declined' };
    }
  }
  state = mergeState(remote);
  save({ skipCloud: true });
  renderAll();
  return { pulled: true, remoteTime };
}

// Two-way sync: pull if remote newer; otherwise push if local newer.
async function cloudSyncNow({ prompt = false } = {}) {
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
    const remoteTime = (remote && remote.lastModified) || 0;
    const localTime = state.lastModified || 0;

    if (remote && remoteTime > localTime + 1000) {
      if (!prompt || confirm('Cloud has newer data (' + new Date(remoteTime).toLocaleString() + '). Pull from cloud and replace local?')) {
        state = mergeState(remote);
        save({ skipCloud: true });
        renderAll();
        setCloudStatus('Pulled from cloud · ' + new Date(remoteTime).toLocaleString());
        return { direction: 'pull' };
      }
      setCloudStatus('Pull declined — local kept');
      return { direction: 'none' };
    }
    // Push local up
    await ghFetch('/gists/' + gistId, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
      }),
    });
    setCloudStatus('Pushed to cloud · ' + new Date(state.lastModified || Date.now()).toLocaleString());
    return { direction: 'push' };
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
      setCloudStatus('Auto-saved to cloud · ' + new Date().toLocaleString());
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
    save({ skipCloud: true });
    renderAll();
    const remoteTime = remote.lastModified ? new Date(remote.lastModified).toLocaleString() : 'unknown';
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
    setCloudStatus('Force-pushed · ' + new Date().toLocaleString());
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
    await cloudSyncNow({ prompt: true });
    renderCloudSyncUI();
  } catch (e) {
    // Status already set by cloudSyncNow
  }
});

document.getElementById('btn-cloud-sync').addEventListener('click', async () => {
  try { await cloudSyncNow({ prompt: true }); }
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
