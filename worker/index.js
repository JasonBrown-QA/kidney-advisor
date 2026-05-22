// Cloudflare Worker — Smart BP / Apple Health → Kidney Advisor gist bridge.
//
// iOS Shortcuts can't write directly into the PWA (the PWA isn't a server).
// They can hit a URL silently in the background via "Get Contents of URL".
// This Worker is that URL: it accepts BP parameters, merges them into the
// kidney-advisor.json gist that the PWA already auto-syncs from, and then
// the PWA picks the new reading up on its next focus — no app-switch, no
// tap on the iPhone.
//
// Required Worker secrets (set via Cloudflare dashboard → Settings → Variables):
//   GIST_ID    — ID of the user's private kidney-advisor.json gist
//   GH_TOKEN   — GitHub PAT with `gist` scope (same one the PWA uses)
//   SYNC_TOKEN — opaque shared secret the Shortcut sends to authenticate
//
// Endpoint: GET /sync
//   ?token=<SYNC_TOKEN>             (required)
//   &systolic=120&diastolic=80      (both required)
//   &pulse=72                       (optional)
//   &bp_time=2026-05-17T08:00       (optional, defaults to "now" Phoenix)
//
// Returns 200 with { ok: true, synced: [...] } on success.

const GIST_FILENAME = 'kidney-advisor.json';
const PHX_OFFSET_MIN = -7 * 60; // Arizona is UTC-7 year-round (no DST).

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Format a Date as YYYY-MM-DDTHH:MM in Phoenix time.
function phoenixDatetimeLocal(d = new Date()) {
  const ms = d.getTime() + PHX_OFFSET_MIN * 60 * 1000;
  const dp = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${dp.getUTCFullYear()}-${pad(dp.getUTCMonth() + 1)}-${pad(dp.getUTCDate())}T${pad(dp.getUTCHours())}:${pad(dp.getUTCMinutes())}`;
}

const GH_HEADERS = (env) => ({
  'Authorization': `Bearer ${env.GH_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'kidney-advisor-sync-worker',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function readGistState(env) {
  const r = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    headers: GH_HEADERS(env),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`gist GET ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const gist = await r.json();
  const file = gist.files && gist.files[GIST_FILENAME];
  if (!file || !file.content) {
    // Fresh gist with no kidney-advisor.json yet — seed an empty state.
    return { labs: [], bp: [], meds: [], medLog: {}, diet: [],
             symptoms: [], questions: [], visit: { date: '', provider: '', notes: '' },
             advisorChat: [], settings: {}, reminders: {}, lastModified: 0 };
  }
  return JSON.parse(file.content);
}

async function writeGistState(env, state) {
  const body = JSON.stringify({
    files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
  });
  const r = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    headers: { ...GH_HEADERS(env), 'Content-Type': 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`gist PATCH ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// BP merge — idempotent on (datetime, systolic, diastolic).
function mergeBP(state, { systolic, diastolic, pulse, bp_time }) {
  const sys = Math.round(Number(systolic));
  const dia = Math.round(Number(diastolic));
  if (!Number.isFinite(sys) || sys <= 0) return null;
  if (!Number.isFinite(dia) || dia <= 0) return null;
  if (!Array.isArray(state.bp)) state.bp = [];
  const time = (bp_time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bp_time))
    ? bp_time.slice(0, 16) : phoenixDatetimeLocal();
  const dup = state.bp.find(e =>
    e.datetime === time &&
    Number(e.systolic) === sys &&
    Number(e.diastolic) === dia);
  if (dup) return { dup: true, entry: dup };
  const pulseN = Number(pulse);
  const entry = {
    id: uid(), datetime: time, systolic: sys, diastolic: dia,
    pulse: Number.isFinite(pulseN) && pulseN > 0 ? Math.round(pulseN) : null,
    position: 'seated', notes: '', source: 'shortcut',
  };
  state.bp.push(entry);
  state.bp.sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
  return { dup: false, entry };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function handleSync(url, env) {
  const params = url.searchParams;
  if (!env.SYNC_TOKEN || params.get('token') !== env.SYNC_TOKEN) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  const state = await readGistState(env);
  const synced = [];
  const skipped = [];

  if (params.has('systolic') && params.has('diastolic')) {
    const r = mergeBP(state, {
      systolic: params.get('systolic'),
      diastolic: params.get('diastolic'),
      pulse: params.get('pulse'),
      bp_time: params.get('bp_time'),
    });
    if (r && r.dup) skipped.push(`BP ${r.entry.systolic}/${r.entry.diastolic} already logged`);
    else if (r) synced.push(`BP ${r.entry.systolic}/${r.entry.diastolic}${r.entry.pulse ? '·' + r.entry.pulse : ''} @ ${r.entry.datetime}`);
  }

  if (!synced.length && !skipped.length) {
    return jsonResponse(400, { ok: false, error: 'no valid params (need systolic+diastolic)' });
  }

  if (synced.length) {
    state.lastModified = Date.now();
    await writeGistState(env, state);
  }

  return jsonResponse(200, { ok: true, synced, skipped });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/sync' || url.pathname === '/sync/') {
        return await handleSync(url, env);
      }
      if (url.pathname === '/' || url.pathname === '/health') {
        return jsonResponse(200, { ok: true, service: 'kidney-advisor-sync' });
      }
      return jsonResponse(404, { ok: false, error: 'not found' });
    } catch (e) {
      return jsonResponse(500, { ok: false, error: String(e && e.message || e) });
    }
  },
};
