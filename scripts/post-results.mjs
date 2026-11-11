// Posts race results to the league automatically.
//
// Runs on a schedule from .github/workflows/post-results.yml. Each run:
//   1. Reads the league state from Firestore.
//   2. If the next scheduled race's picks have locked, finds that race in
//      NASCAR's official feed (cf.nascar.com).
//   3. Once NASCAR lists a winner and post-race inspection is complete, scores
//      every pick exactly like "Save & Post Results" in the Admin tab, then
//      clears picks and advances the schedule.
//
// Usage:
//   node scripts/post-results.mjs              post for real
//   node scripts/post-results.mjs --dry-run    show what would be posted
//   node scripts/post-results.mjs --state s.json --now 2026-11-08T23:00:00Z
//        test against a local state file (plain JSON, never writes)

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROJECT = 'nascar-fantasy-app';
const API_KEY = 'AIzaSyAwOUsAovEOAxTQ5KP3RR6Xbg9uXGozphQ'; // same public web key as index.html
const DOC = process.env.LEAGUE_DOC || 'state'; // override only for testing against a copy
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/league/${DOC}`;
const FEED = 'https://cf.nascar.com/cacher';
const CUP = 1;

const WIN_BONUS = 10;            // league bonus when your driver wins
const MIN_HOURS_AFTER_LOCK = 2;  // don't bother NASCAR's feed before this
const INSPECTION_FALLBACK_HOURS = 12; // post anyway if inspection flag never flips
const MATCH_WINDOW_DAYS = 3;     // how far a NASCAR race date may sit from the picks deadline

// 2026 Cup finishing points (55 for the win, then 35, 34 ... 1). Only used for
// drivers who aren't Cup-points eligible, since NASCAR lists them at 0.
function finishPoints(pos) {
  if (!pos || pos < 1) return 0;
  if (pos === 1) return 55;
  return Math.max(1, 37 - pos);
}

/* ── Firestore value <-> plain JS ── */
export function decode(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  throw new Error('Unknown Firestore value: ' + JSON.stringify(v));
}
function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
}
export function encode(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, encode(v)])) } };
}

/* ── Names ── */
export function normName(n) {
  return String(n || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.']/g, '').replace(/[^a-z ]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ')
    .split(/\s+/).filter(Boolean).join(' ');
}
// Match two driver names: exact after normalizing ("Ricky Stenhouse Jr." = "Ricky Stenhouse Jr"),
// or same first and last name around a middle name ("John Nemechek" = "John Hunter Nemechek").
function sameDriver(a, b, loose) {
  const x = normName(a), y = normName(b);
  if (x === y) return true;
  if (!loose || !x || !y) return false;
  const p = x.split(' '), q = y.split(' ');
  return p[0] === q[0] && p[p.length - 1] === q[q.length - 1];
}
function findBy(list, name, nameOf) {
  const exact = list.filter(x => sameDriver(nameOf(x), name, false));
  if (exact.length) return exact[0];
  const loose = list.filter(x => sameDriver(nameOf(x), name, true));
  return loose.length === 1 ? loose[0] : null;
}
export const findResult = (results, pick) => findBy(results, pick, r => r.driver_fullname);

/* ── Times ── */
// NASCAR feed times are Eastern wall-clock with no offset ("2026-11-08T15:00:00").
export function easternToUtc(s) {
  const asUtc = new Date(s + 'Z');
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(asUtc).find(p => p.type === 'timeZoneName').value; // "GMT-5"
  const hours = Number(off.replace('GMT', '') || 0);
  return new Date(asUtc.getTime() - hours * 3600e3);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'nascar-fantasy-results-bot' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// Pick the NASCAR Cup race that the league's next scheduled race refers to.
export function matchRace(raceList, sched) {
  const lock = new Date(sched.deadline).getTime();
  const track = normName(sched.track);
  const scored = raceList
    .map(r => {
      const start = easternToUtc(r.race_date || r.date_scheduled).getTime();
      const days = Math.abs(start - lock) / 864e5;
      const trackHit = track && (normName(r.track_name).includes(track) || track.includes(normName(r.track_name)));
      return { r, start, days, score: days - (trackHit ? 2 : 0) - (r.race_type_id === 1 ? 1 : 0) };
    })
    .filter(x => x.days <= MATCH_WINDOW_DAYS)
    .sort((a, b) => a.score - b.score);
  return scored[0] || null;
}

// Score every player's pick from NASCAR's official results.
export function scoreRace(state, results) {
  const warnings = [];
  const entries = state.players.map(p => {
    const pick = state.picks?.[p.name];
    if (!pick) return { player: p.name, driver: '—', won: false, pts: 0 };
    const r = findResult(results, pick);
    if (!r) {
      warnings.push(`${p.name}'s pick ${pick} isn't in the results — scored 0`);
      return { player: p.name, driver: pick, won: false, pts: 0 };
    }
    const won = r.finishing_position === 1;
    let base = r.points_earned || 0;
    if (r.disqualified) base = 0;
    else if (!base) base = finishPoints(r.finishing_position); // not Cup-points eligible
    return { player: p.name, driver: pick, won, pts: base + (won ? WIN_BONUS : 0) };
  });
  return { entries, warnings };
}

function leagueDriverName(state, nascarName) {
  const d = findBy(state.drivers || [], nascarName, d => d.name || d);
  return d ? (d.name || d) : nascarName;
}

function syncNextRace(state) {
  const next = state.schedule[0];
  state.nextRace = next?.name || '';
  state.nextTrack = next?.track || '';
  state.deadline = next?.deadline || '';
  state.nextRaceType = next?.raceType || 'regular';
}

/* ── Main ── */
export async function run({ dryRun = false, stateFile = null, now = new Date() } = {}) {
  let state, updateTime = null;
  if (stateFile) {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
    dryRun = true;
  } else {
    const doc = await getJson(`${DOC_URL}?key=${API_KEY}`);
    state = decodeFields(doc.fields);
    updateTime = doc.updateTime;
  }
  state.schedule ||= []; state.races ||= []; state.picks ||= {};

  const sched = state.schedule[0];
  if (!sched) return { status: 'idle', message: 'No race on the league schedule.' };
  if (!sched.deadline) return { status: 'idle', message: `${sched.name} has no picks deadline, so it can't be matched to a NASCAR race.` };

  const hoursSinceLock = (now - new Date(sched.deadline)) / 3600e3;
  if (hoursSinceLock < MIN_HOURS_AFTER_LOCK)
    return { status: 'idle', message: `Next race: ${sched.name}, picks lock ${sched.deadline}. Nothing to post yet.` };

  const year = new Date(sched.deadline).getUTCFullYear();
  const list = (await getJson(`${FEED}/${year}/race_list_basic.json`))[`series_${CUP}`] || [];
  const m = matchRace(list, sched);
  if (!m) return { status: 'warn', message: `No NASCAR Cup race within ${MATCH_WINDOW_DAYS} days of the ${sched.name} picks deadline (${sched.deadline}). Check the deadline in Admin.` };
  const info = m.r;

  if (state.races.some(r => r.nascarRaceId === info.race_id))
    return { status: 'warn', message: `${info.race_name} (${info.race_id}) is already posted, but it's still first on the schedule. Remove it from the schedule in Admin.` };

  const feed = await getJson(`${FEED}/${year}/${CUP}/${info.race_id}/weekend-feed.json`);
  const race = feed.weekend_race?.[0];
  const results = race?.results || [];
  const winner = results.find(r => r.finishing_position === 1);
  const finished = winner && info.winner_driver_id && info.winner_driver_id === winner.driver_id;
  if (!finished) return { status: 'idle', message: `${info.race_name}: waiting for NASCAR to post a winner.` };
  const hoursSinceStart = (now - m.start) / 3600e3;
  if (!race.inspection_complete && hoursSinceStart < INSPECTION_FALLBACK_HOURS)
    return { status: 'idle', message: `${info.race_name}: ${winner.driver_fullname} won; waiting for post-race inspection to finish.` };

  const { entries, warnings } = scoreRace(state, results);
  const record = {
    name: sched.name,
    track: sched.track || info.track_name,
    raceType: sched.raceType || 'regular',
    entries,
    backfill: false,
    winnerDriver: leagueDriverName(state, winner.driver_fullname),
    winnerPts: winner.points_earned || 0,
    auto: true,
    nascarRaceId: info.race_id,
  };
  if (!race.inspection_complete) warnings.push(`NASCAR never marked inspection complete; posted ${Math.round(hoursSinceStart)}h after the start`);

  state.races.push(record);
  state.picks = {};
  state.schedule.shift();
  syncNextRace(state);

  const summary = `${record.name}: ${record.winnerDriver} won. ` +
    entries.map(e => `${e.player} ${e.driver} ${e.pts}${e.won ? ' 🏆' : ''}`).join(' · ');

  if (dryRun) return { status: 'dry-run', message: 'Would post → ' + summary, record, warnings, state };

  const fields = ['races', 'picks', 'schedule', 'nextRace', 'nextTrack', 'deadline', 'nextRaceType'];
  const params = new URLSearchParams({ key: API_KEY, 'currentDocument.updateTime': updateTime });
  fields.forEach(f => params.append('updateMask.fieldPaths', f));
  const body = { fields: Object.fromEntries(fields.map(f => [f, encode(state[f])])) };
  const r = await fetch(`${DOC_URL}?${params}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    // Someone saved in the app between our read and write; next run will retry with fresh data.
    if (r.status === 400 && /FAILED_PRECONDITION|precondition/i.test(text))
      return { status: 'idle', message: 'League changed while posting; will retry next run.' };
    throw new Error(`Firestore write failed: HTTP ${r.status} ${text.slice(0, 300)}`);
  }
  return { status: 'posted', message: 'Posted → ' + summary, record, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const res = await run({
    dryRun: args.includes('--dry-run') || process.env.DRY_RUN === 'true',
    stateFile: opt('--state'),
    now: opt('--now') ? new Date(opt('--now')) : new Date(),
  }).catch(e => ({ status: 'error', message: e.message }));

  console.log(res.message);
  for (const w of res.warnings || []) console.log(`::warning::${w}`);
  if (res.status === 'warn') console.log(`::warning::${res.message}`);
  // Fail the run (GitHub emails you) on errors, and once when a post needs a second look.
  // 'warn' (e.g. a deadline that matches no race) only annotates, so it can't email every 20 minutes.
  if (res.status === 'error' || res.warnings?.length) process.exit(1);
}
