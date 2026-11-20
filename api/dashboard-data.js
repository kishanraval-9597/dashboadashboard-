// api/dashboard-data.js
//
// Fast data feed for the dashboard.
//
// WHY: the dashboard used to make every visitor's browser download the ENTIRE Google
// Sheet (every column, every row — tens of MB) and then crunch it. This function does
// that once on the server, keeps only the columns the dashboard needs, packs the rows
// into a few hundred KB, and lets Vercel's CDN hand the same small file to everyone.
//
//   GET /api/dashboard-data?company=ALL            -> the packed dataset  (cached 5 min at the CDN,
//                                                     served instantly while it refreshes in the background)
//   GET /api/dashboard-data?company=ALL&names=1&part=0&v=<version>
//                                                  -> restaurant names for the drill-down lists,
//                                                     pinned to a data version so they always line up
//
// DATES: the survey tab is read as the sheet's own displayed text (its CSV export), i.e. exactly
// what a person sees in the sheet. Google's query API silently turns text-typed cells in a
// date column into blanks, which is what made most visits "lose" their date. Every date-like
// column (Date, Timestamp, Visit Date, ...) is considered, and each row uses the first one
// that can be read — the dashboard reports which column supplied how many rows.
//
// TABS: tabs are found by NAME ("Survey Data", "New Restaurant") as well as by their numeric id, and every
// result is checked ("does this look like the survey tab, and does it have rows?"). An empty or wrong tab is
// reported as an error — it is never passed on as a successful "0 surveys" result.
//
// If this endpoint is ever unavailable, the dashboard automatically falls back to the
// older (slower) direct-from-Google loading, so it never goes blank.

'use strict';
const crypto = require('crypto');

const SHEET_ID = '1apR0AaWF5MrAryfJHv6iN4C4Vd_38JbHY-5AXczTBQk';
const GIDS = { survey: '0', restaurant: '1417791305' };

// Only these columns ever leave the server (same allow-list as api/sheet-data.js).
const SURVEY_COLS = ['Date', 'Employee Name', 'Res Available', 'Swiggy Live', 'Zomato Live', 'Ex Software', 'Region', 'Res Name'];
const REST_COLS   = ['Date', 'Employee Name', 'Live On Swiggy', 'Live On Zomato', 'Existing Software Final', 'Outlet Type', 'City', 'State'];

const KNOWN_COMPANIES = ['Petpooja', 'PAMAC', 'WPP'];   // keep in step with the dashboard
const TAB_NAMES = { survey: ['Survey Data'], restaurant: ['New Restaurant Data', 'New Restaurant'] };
const SURVEY_REQUIRED = ['Res Available', 'Region', 'Ex Software', 'Date'];           // a real survey tab has (nearly) all of these
const REST_REQUIRED = ['City', 'Existing Software Final', 'Live On Zomato', 'Live On Swiggy'];
// Column headers are matched ignoring capitals and extra spaces, plus a few harmless alternative names
// (used only when the sheet has no column with the proper name).
const ALIASES = {
  'res avail': 'Res Available', 'res availability': 'Res Available', 'restaurant available': 'Res Available', 'restaurant availability': 'Res Available',
  'swiggy': 'Swiggy Live', 'zomato': 'Zomato Live',
  'existing software': 'Ex Software', 'ex-software': 'Ex Software', 'existing billing software': 'Ex Software',
  'city': 'Region',
  'restaurant name': 'Res Name', 'employee': 'Employee Name', 'surveyor name': 'Employee Name',
};
const NAMES_CHUNK = 40000;                              // restaurant names per response
const SNAPSHOT_TTL_MS = 60 * 1000;                      // reuse a freshly built snapshot on a warm instance
const MAX_PAYLOAD_CHARS = 4200000;                      // Vercel limits a function response to ~4.5 MB
const MAX_BAD_DATE_SAMPLES = 50;

// ----------------------------------------------------------------------------- reading the sheet
const GVIZ_DATE_RE = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+)(?:,(\d+))?)?\)$/;
const pad2 = n => String(n).padStart(2, '0');

function isoFromGvizDate(raw){
  const m = typeof raw === 'string' ? raw.match(GVIZ_DATE_RE) : null;
  if(!m) return null;
  const datePart = `${m[1]}-${pad2(Number(m[2]) + 1)}-${pad2(m[3])}`;
  return m[4] === undefined ? datePart : `${datePart} ${pad2(m[4])}:${pad2(m[5] || '0')}`;
}

const normLabel = x => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();

// Canonical header names: "res available ", "RES AVAILABLE" -> "Res Available"; known alternative names are used
// only when the proper column is absent. Duplicate columns keep their own names.
function canonLabels(rawLabels, canonList, aliases){
  const exact = new Map(canonList.map(c => [normLabel(c), c]));
  const present = new Set();
  rawLabels.forEach(l => { const c = exact.get(normLabel(l)); if(c) present.add(c); });
  const seen = new Set();
  return rawLabels.map(l => {
    const raw = String(l == null ? '' : l).trim();
    let c = exact.get(normLabel(l));
    if(!c && aliases){ const a = aliases[normLabel(l)]; if(a && canonList.includes(a) && !present.has(a)) c = a; }
    if(c && !seen.has(c)){ seen.add(c); present.add(c); return c; }
    return raw;
  });
}

async function fetchTimeout(url, ms){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try{ return await fetch(url, { signal: ac.signal }); }
  catch(e){ if(e && e.name === 'AbortError') throw new Error('timed out after ' + Math.round(ms / 1000) + ' s'); throw e; }
  finally { clearTimeout(timer); }
}

// target: a tab id ("0") or { gid } or { sheet: 'Tab name' }
function gvizUrl(target, query){
  const t = (target && typeof target === 'object') ? target : { gid: target };
  const which = t.sheet ? 'sheet=' + encodeURIComponent(t.sheet) : 'gid=' + encodeURIComponent(t.gid);
  let url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${which}&headers=1&tqx=out:json`;
  if(query) url += '&tq=' + encodeURIComponent(query);
  return url;
}

async function gviz(target, query){
  const res = await fetchTimeout(gvizUrl(target, query), 40000);
  if(!res.ok) throw new Error('Could not reach the sheet (HTTP ' + res.status + ')');
  const text = await res.text();
  const a = text.indexOf('('), b = text.lastIndexOf(')');
  if(a === -1 || b === -1) throw new Error('Unexpected response format from the sheet');
  const data = JSON.parse(text.slice(a + 1, b));
  if(data.status === 'error'){
    const e = data.errors && data.errors[0];
    throw new Error((e && (e.detailed_message || e.message)) || 'Query error');
  }
  return data.table;
}

// Ask Google for ONLY the columns we use (a fraction of the sheet's width). If that
// optimisation fails for any reason, fall back to downloading the whole tab.
async function fetchTable(target, wanted, aliases){
  const labelsOf = t => canonLabels(t.cols.map(c => (c.label || c.id || '').trim()), wanted, aliases);
  try{
    const head = await gviz(target, 'select * limit 1');
    const canon = labelsOf(head);
    const idByLabel = {};
    head.cols.forEach((c, i) => { const l = canon[i]; if(l && !(l in idByLabel)) idByLabel[l] = c.id; });
    const extra = wanted === SURVEY_COLS ? canon.filter(l => isDateLike(l) && !wanted.includes(l)) : [];
    const ids = wanted.concat(extra).map(l => idByLabel[l]).filter(Boolean);
    if(ids.length && ids.length < head.cols.length) return { table: await gviz(target, 'select ' + ids.join(',')), labels: canon };
  }catch(e){ /* fall through to the plain download */ }
  const table = await gviz(target, null);
  return { table, labels: labelsOf(table) };
}

// ---- find tabs by NAME (so a re-created tab with a new id is still found)
let TABS_CACHE = null;
const decodeEntities = t => t.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function discoverTabs(){
  if(TABS_CACHE && Date.now() - TABS_CACHE.at < 10 * 60 * 1000) return TABS_CACHE;
  const tabs = [];                                   // [{ name, gid }]
  let note = '';
  try{
    const res = await fetchTimeout(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`, 8000);
    if(!res.ok) note = 'tab list page answered HTTP ' + res.status;
    else {
      const html = await res.text();
      const re = /sheet-button-(\d+)/g; let m; const seen = new Set();
      while((m = re.exec(html))){
        if(seen.has(m[1])) continue;
        const gt = html.indexOf('>', m.index); if(gt === -1) continue;
        const rawText = html.slice(gt + 1, gt + 700).replace(/<[^>]*>/g, '\n').split('\n').filter(x => x.trim())[0];
        if(rawText){ seen.add(m[1]); tabs.push({ name: decodeEntities(rawText.trim()), exact: decodeEntities(rawText), gid: m[1] }); }
      }
      if(!tabs.length) note = 'the tab list could not be read from the sheet page';
    }
  }catch(e){ note = e.message; }
  TABS_CACHE = { at: Date.now(), tabs, note };
  return TABS_CACHE;
}
// Names to try when asking Google for a tab BY NAME: the exact name it reported, the configured name, and the same with a
// trailing space (tab names such as "Survey Data " often carry one).
const nameVariants = (found, configured) => Array.from(new Set([found && found.exact, found && found.name].concat(configured.reduce((a, n) => a.concat([n, n + ' ']), [])).filter(Boolean)));
const findTab = (tabs, names) => { for(const n of names){ const t = tabs.find(x => normLabel(x.name) === normLabel(n)); if(t) return t; } return null; };

function tableToObjects(table, keep, aliases){
  const keepSet = new Set(keep);
  const dateLikeKeep = l => keepSet.has(l) || (keep === SURVEY_COLS && isDateLike(l));
  const cols = canonLabels(table.cols.map(c => (c.label || c.id || '').trim()), keep, aliases);
  return (table.rows || []).map(row => {
    const obj = {};
    (row.c || []).forEach((cell, i) => {
      const key = cols[i];
      if(!key || !dateLikeKeep(key)) return;
      if(cell){
        const iso = isoFromGvizDate(cell.v);              // a real date cell -> exact ISO text (no day/month guessing)
        if(iso){ obj[key] = iso; return; }
      }
      const v = cell ? ((cell.f !== undefined && cell.f !== null && cell.f !== '') ? cell.f : cell.v) : '';
      obj[key] = (v === null || v === undefined) ? '' : v;
    });
    return obj;
  });
}

// ----------------------------------------------------------------------------- date-like columns
const DATE_LIKE = /date|time|stamp|created|submitted|visit|day/i;
const NOT_A_VISIT_DATE = /birth|dob|expir|due|valid|renew|anniversar|opening|open ?time|close ?time|timing|hours?\b|duration/i;
const isDateLike = label => DATE_LIKE.test(label) && !NOT_A_VISIT_DATE.test(label);

// ----------------------------------------------------------------------------- CSV (the sheet as displayed)
// Fast reader that keeps only the columns it is told to keep. Handles quotes, "" escapes,
// line breaks inside quotes, \r\n, and a leading byte-order mark.
function parseCsv(text, wanted){
  const rows = []; const n = text.length;
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let cur = [], col = 0;
  while(i < n){
    const keep = !wanted || wanted[col];
    let val = '';
    if(text.charCodeAt(i) === 34){                                   // quoted field
      let j = i + 1;
      for(;;){
        const q = text.indexOf('"', j);
        if(q === -1){ if(keep) val += text.slice(j); i = n; break; }
        if(keep) val += text.slice(j, q);
        if(text.charCodeAt(q + 1) === 34){ if(keep) val += '"'; j = q + 2; continue; }
        i = q + 1; break;
      }
    } else {                                                          // plain field
      let j = i;
      while(j < n){ const d = text.charCodeAt(j); if(d === 44 || d === 10 || d === 13) break; j++; }
      if(keep) val = text.slice(i, j);
      i = j;
    }
    if(keep) cur[col] = val;
    const d = text.charCodeAt(i);
    if(d === 44){ col++; i++; continue; }
    if(d === 13 && text.charCodeAt(i + 1) === 10) i += 2; else if(d === 10 || d === 13) i++;
    if(!(cur.length <= 1 && (cur[0] === undefined || cur[0] === '') && col === 0)) rows.push(cur);   // skip fully blank lines
    cur = []; col = 0;
  }
  // a last row that ended at the end of the file without a newline, e.g. "1,2,"
  if(col > 0 || cur.length > 0){ if(cur[col] === undefined && (!wanted || wanted[col])) cur[col] = ''; rows.push(cur); }
  return rows;
}

// -> { rows: [ {label: text, ..., __row: <row number in the sheet>} ], labels: [every header] }
function csvToRows(text){
  const bom = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let nl = text.indexOf('\n', bom); if(nl === -1) nl = text.length;
  const labels = canonLabels(parseCsv(text.slice(bom, nl).replace(/\r$/, ''), null)[0].map(s => (s || '').trim()), SURVEY_COLS, ALIASES);
  const seen = new Set(), wanted = labels.map(l => { if(!l || seen.has(l) || !(SURVEY_COLS.includes(l) || isDateLike(l))) return false; seen.add(l); return true; });
  const arrs = parseCsv(text.slice(nl + 1), wanted);
  const idx = []; labels.forEach((l, c) => { if(wanted[c]) idx.push([l, c]); });
  const rows = new Array(arrs.length);
  for(let r = 0; r < arrs.length; r++){
    const a = arrs[r], o = { __row: r + 2 };                            // row 1 is the header
    for(let k = 0; k < idx.length; k++){ const v = a[idx[k][1]]; o[idx[k][0]] = v === undefined ? '' : v; }
    rows[r] = o;
  }
  return { rows, labels };
}

async function fetchSurveyCsv(gid){
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const res = await fetchTimeout(url, 45000);
  if(!res.ok) throw new Error('CSV export HTTP ' + res.status);
  const text = await res.text();
  if(/^\s*</.test(text.slice(0, 300))) throw new Error('CSV export returned a web page instead of data');
  return csvToRows(text);
}

// ----------------------------------------------------------------------------- reading the two tabs (with checks)
const missingOf = (labels, required) => required.filter(c => !labels.includes(c));
const looksLike = (labels, required, min) => required.length - missingOf(labels, required).length >= min;
const short = e => String(e && e.message || e).slice(0, 140);

// Try, in order: the tab found by NAME (CSV, then query API), the configured tab id (CSV, then query API), and
// finally the query API by tab name. The first result that has rows AND the survey columns wins.
async function readSurvey(tabs, attempts){
  const found = findTab(tabs, TAB_NAMES.survey);
  const gids = []; [found && found.gid, GIDS.survey].forEach(g => { if(g !== undefined && g !== null && !gids.includes(String(g))) gids.push(String(g)); });
  const steps = [];
  gids.forEach(g => { steps.push({ via: 'csv', gid: g }); steps.push({ via: 'gviz', gid: g }); });
  nameVariants(found, TAB_NAMES.survey).forEach(n => steps.push({ via: 'gviz', sheet: n }));
  for(const st of steps){
    const a = { via: st.via, tab: st.sheet ? 'name “' + st.sheet + '”' : 'id ' + st.gid, ok: false, rows: 0, ms: 0, error: '' };
    attempts.push(a); const t0 = Date.now();
    try{
      let r;
      if(st.via === 'csv') r = await fetchSurveyCsv(st.gid);
      else { const g = await fetchTable(st.sheet ? { sheet: st.sheet } : st.gid, SURVEY_COLS, ALIASES); const rows = tableToObjects(g.table, SURVEY_COLS, ALIASES); rows.forEach((o, i) => { o.__row = i + 2; }); r = { rows, labels: g.labels }; }
      a.rows = r.rows.length; a.ms = Date.now() - t0;
      if(!r.rows.length){ a.error = 'the tab has no rows'; continue; }
      if(!looksLike(r.labels, SURVEY_REQUIRED, 3)){ a.error = 'columns do not look like the survey tab (found: ' + r.labels.slice(0, 8).join(', ') + ')'; continue; }
      a.ok = true;
      return { rows: r.rows, labels: r.labels, kind: st.via === 'csv' ? 'csv' : 'gviz', tab: found && !st.sheet && String(found.gid) === st.gid ? found.name : (st.sheet || null), gid: st.gid || null };
    }catch(e){ a.error = short(e); a.ms = Date.now() - t0; }
  }
  const err = new Error('The “Survey Data” tab could not be read — every attempt failed or returned no survey rows. ' +
    attempts.filter(a => !a.ok).slice(0, 6).map(a => `${a.via} (${a.tab}): ${a.error}`).join('; '));
  err.attempts = attempts; throw err;
}

// The restaurant-leads tab is smaller and never blocks the survey numbers: if it cannot be read the dashboard says so.
async function readLeads(tabs, attempts){
  const found = findTab(tabs, TAB_NAMES.restaurant);
  const gids = []; [found && found.gid, GIDS.restaurant].forEach(g => { if(g !== undefined && g !== null && !gids.includes(String(g))) gids.push(String(g)); });
  const steps = gids.map(g => ({ gid: g })).concat(nameVariants(found, TAB_NAMES.restaurant).map(n => ({ sheet: n })));
  for(const st of steps){
    const a = { via: 'gviz', tab: st.sheet ? 'name “' + st.sheet + '”' : 'id ' + st.gid, ok: false, rows: 0, ms: 0, error: '' };
    attempts.push(a); const t0 = Date.now();
    try{
      const g = await fetchTable(st.sheet ? { sheet: st.sheet } : st.gid, REST_COLS);
      const rows = tableToObjects(g.table, REST_COLS);
      a.rows = rows.length; a.ms = Date.now() - t0;
      if(!looksLike(g.labels, REST_REQUIRED, 2)){ a.error = 'columns do not look like the restaurant-leads tab'; continue; }
      a.ok = true;
      return { rows, labels: g.labels, tab: st.sheet || (found && String(found.gid) === st.gid ? found.name : null), gid: st.gid || null };
    }catch(e){ a.error = short(e); a.ms = Date.now() - t0; }
  }
  return { rows: [], labels: [], failed: true, error: Array.from(new Set(attempts.filter(a => !a.ok).map(a => a.error))).slice(0, 2).join('; ') };
}

// ----------------------------------------------------------------------------- dates
// This is a copy of the dashboard's own date reader (parseDate / detectDateOrder) so a
// date means exactly the same thing on the server as it did in the browser. The test
// suite compares the two on hundreds of formats.
const MONTH_NUM = { jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3, may:4, jun:5, june:5,
  jul:6, july:6, aug:7, august:7, sep:8, sept:8, september:8, oct:9, october:9, nov:10, november:10, dec:11, december:11 };

function detectDateOrder(rows, cols){
  let dmy = false, mdy = false;
  const keys = cols && cols.length ? cols : ['Date'];
  for(let i = 0; i < rows.length && !(dmy && mdy); i++){
    for(let k = 0; k < keys.length; k++){
      const v = rows[i][keys[k]];
      if(typeof v !== 'string') continue;
      const m = v.match(/^\s*(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{4}/);
      if(!m) continue;
      if(+m[1] > 12) dmy = true; else if(+m[2] > 12) mdy = true;
    }
  }
  return (mdy && !dmy) ? 'MDY' : 'DMY';
}

// Which columns can supply a visit date, best first: "Date" itself, then the others by how much of
// the sheet they can actually be read for.
function pickDateColumns(rows, labels){
  const present = (labels || []).filter(l => isDateLike(l) && rows.length && (l in rows[0]));
  if(!present.length) return [];
  const order = detectDateOrder(rows, present);
  const share = {};
  present.forEach(c => {
    const memo = new Map(); let ok = 0;
    for(let i = 0; i < rows.length; i++){
      const raw = rows[i][c]; const t = (raw === undefined || raw === null) ? '' : String(raw).trim();
      if(!t) continue;
      let good = memo.get(t); if(good === undefined){ good = !!parseDate(t, order); memo.set(t, good); }
      if(good) ok++;
    }
    share[c] = ok;
  });
  const primary = present.find(c => c.toLowerCase() === 'date');
  const rest = present.filter(c => c !== primary).sort((a, b) => share[b] - share[a]);
  return (primary ? [primary] : []).concat(rest).filter(c => share[c] > 0 || c === primary);
}

function parseDate(s, order){
  if(s === null || s === undefined || s === '') return null;
  if(typeof s === 'number' || /^\d{5}(\.\d+)?$/.test(String(s).trim())){
    const v = Number(s);
    if(v >= 20000 && v <= 80000){
      const days = Math.floor(v), secs = Math.round((v - days) * 86400);
      return new Date(1899, 11, 30 + days, Math.floor(secs / 3600), Math.floor(secs % 3600 / 60));
    }
    return null;
  }
  const str = String(s).trim()
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '')
    .replace(/\s+at\s+/i, ' ');
  const fixYear = yy => yy < 100 ? 2000 + yy : yy;
  let y, m, d, rest, mt;
  if((mt = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T\s]+(.*))?$/))){
    y = +mt[1]; m = +mt[2]; d = +mt[3]; rest = mt[4];
  } else if((mt = str.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?!\d)(?:[T\s,]+(.*))?$/))){
    const a = +mt[1], b = +mt[2]; y = fixYear(+mt[3]); rest = mt[4];
    if(a > 12){ d = a; m = b; } else if(b > 12){ m = a; d = b; }
    else if(order === 'MDY'){ m = a; d = b; } else { d = a; m = b; }
  } else if((mt = str.match(/^(\d{1,2})[-\s\/]([A-Za-z]{3,9})\.?,?[-\s\/]+(\d{4}|\d{2})(?!\d)(?:[T\s,]+(.*))?$/))){
    const mo = MONTH_NUM[mt[2].toLowerCase()]; if(mo === undefined) return null;
    d = +mt[1]; m = mo + 1; y = fixYear(+mt[3]); rest = mt[4];
  } else if((mt = str.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[T\s,]+(.*))?$/))){
    const mo = MONTH_NUM[mt[1].toLowerCase()]; if(mo === undefined) return null;
    m = mo + 1; d = +mt[2]; y = +mt[3]; rest = mt[4];
  } else return null;
  let hh = 0, mi = 0;
  if(rest){
    const tm = rest.match(/(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?\s*([AaPp][Mm])?/);
    if(tm){
      hh = +tm[1]; mi = +tm[2];
      const ap = (tm[3] || '').toLowerCase();
      if(ap === 'pm' && hh < 12) hh += 12;
      if(ap === 'am' && hh === 12) hh = 0;
    }
  }
  const dt = new Date(y, m - 1, d, hh, mi);
  if(isNaN(dt.getTime()) || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

// ----------------------------------------------------------------------------- packing
function dictionary(){
  const map = new Map(), arr = [];
  return { arr, id(v){ let i = map.get(v); if(i === undefined){ i = arr.length; map.set(v, i); arr.push(v); } return i; } };
}

// Fixed-width base-36 numbers glued into one string: tiny, and fast for the browser to unpack.
function pack(ints, maxVal){
  const w = Math.max(1, maxVal.toString(36).length);
  const out = new Array(ints.length);
  for(let i = 0; i < ints.length; i++) out[i] = ints[i].toString(36).padStart(w, '0');
  return { w, s: out.join('') };
}

function detectCompany(name){
  const n = (name || '').toString().toLowerCase();
  for(const c of KNOWN_COMPANIES){ if(n.indexOf(c.toLowerCase()) !== -1) return c; }
  return null;
}

function buildSnapshot(surveyRows, restRows, company, sheetLabels, opts){
  opts = opts || {};
  const needle = (company || 'ALL').toString().trim();
  const filtering = needle.toUpperCase() !== 'ALL';
  const keepRow = r => !filtering || (r['Employee Name'] || '').toString().toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  const survey = surveyRows.filter(keepRow), rest = restRows.filter(keepRow);

  const labelsForDates = sheetLabels || Object.keys(surveyRows[0] || {});
  const dateCols = pickDateColumns(survey, labelsForDates);
  const order = detectDateOrder(survey, dateCols.length ? dateCols : ['Date']);
  const D = { region: dictionary(), avail: dictionary(), zom: dictionary(), swg: dictionary(), sw: dictionary(), date: dictionary() };
  const ints = { region: [], avail: [], zom: [], swg: [], sw: [], date: [] };
  const names = new Array(survey.length);
  const badSeen = new Map();
  const str = v => (v === undefined || v === null) ? '' : String(v);
  const dayMemo = new Map();                    // date text -> 'YYYY-MM-DD' or '' (unreadable)
  const toDay = txt => {
    let d = dayMemo.get(txt);
    if(d === undefined){ const dt = parseDate(txt, order); d = dt ? `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}` : ''; dayMemo.set(txt, d); }
    return d;
  };
  const sources = {}; let unresolved = 0;
  const exFirst = [], exLast = [];

  survey.forEach((r, i) => {
    ints.region.push(D.region.id(str(r['Region'])));
    ints.avail.push(D.avail.id(str(r['Res Available'])));
    ints.zom.push(D.zom.id(str(r['Zomato Live'])));
    ints.swg.push(D.swg.id(str(r['Swiggy Live'])));
    ints.sw.push(D.sw.id(str(r['Ex Software'])));
    // Date: the first date-like column that can be read; only the DAY is kept (the dashboard never uses time of day).
    let value = null, firstText = '';
    for(let k = 0; k < dateCols.length; k++){
      const raw = r[dateCols[k]]; const txt = (raw === undefined || raw === null) ? '' : String(raw).trim();
      if(!txt) continue;
      if(!firstText) firstText = txt;
      const day = toDay(txt);
      if(day){ value = day; sources[dateCols[k]] = (sources[dateCols[k]] || 0) + 1; break; }
    }
    if(value === null){
      unresolved++;
      if(!firstText) value = '';                                           // every date column empty
      else if(badSeen.has(firstText) || badSeen.size < MAX_BAD_DATE_SAMPLES){ badSeen.set(firstText, 1); value = firstText; }
      else value = '(other unreadable text)';
      const ex = { row: r.__row || (i + 2), name: str(r['Res Name']), region: str(r['Region']), avail: str(r['Res Available']),
        values: Object.fromEntries(dateCols.map(c => [c, str(r[c])])) };
      if(exFirst.length < 6) exFirst.push(ex); else { exLast.push(ex); if(exLast.length > 6) exLast.shift(); }
    }
    ints.date.push(D.date.id(value));
    names[i] = str(r['Res Name']);
  });

  const max = k => Math.max(0, D[k].arr.length - 1);
  const packed = {};
  Object.keys(D).forEach(k => { packed[k] = pack(ints[k], max(k)); });

  const restCols = Object.keys(rest.reduce((a, r) => Object.assign(a, r), {}));
  const restRowsOut = rest.map(r => restCols.map(c => str(r[c])));

  const companies = KNOWN_COMPANIES.filter(c => {
    const found = new Set();
    survey.forEach(r => { const x = detectCompany(r['Employee Name']); if(x) found.add(x); });
    rest.forEach(r => { const x = detectCompany(r['Employee Name']); if(x) found.add(x); });
    return found.has(c);
  });

  const body = {
    n: survey.length,
    dateOrder: order,
    dict: Object.fromEntries(Object.keys(D).map(k => [k, D[k].arr])),
    w: Object.fromEntries(Object.keys(D).map(k => [k, packed[k].w])),
    cols: Object.fromEntries(Object.keys(D).map(k => [k, packed[k].s])),
    // a short fingerprint of every chunk of names: the browser keeps chunks it already has and only fetches those that changed
    names: { chunk: NAMES_CHUNK, parts: Math.ceil(survey.length / NAMES_CHUNK),
      hashes: Array.from({ length: Math.ceil(survey.length / NAMES_CHUNK) }, (_, k) => crypto.createHash('sha1').update(names.slice(k * NAMES_CHUNK, (k + 1) * NAMES_CHUNK).join('\n')).digest('hex').slice(0, 12)) },
    dateColumns: dateCols,                       // which columns can supply a date, best first
    dateSources: sources,                        // how many rows each one supplied
    dateUnresolved: unresolved,                  // rows where none could be read
    undatedExamples: exFirst.concat(exLast),     // a few such rows, with their sheet row numbers
    readAs: opts.kind || 'unknown',              // 'csv' (sheet text) or 'gviz'
    companies,
    // column NAMES only, and only the ones the dashboard reads plus date-like ones (shown in "Check the date data");
    // other column names (phone, owner, address ...) are never sent
    sheetColumns: (sheetLabels || Object.keys(surveyRows[0] || {})).filter(c => SURVEY_COLS.includes(c) || (!filtering && isDateLike(c))),
    rest: { cols: restCols, rows: restRowsOut },
  };
  const v = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { v, payload: Object.assign({ v, generatedAt: new Date().toISOString(), company: filtering ? needle : 'ALL' }, body), names };
}

// ----------------------------------------------------------------------------- the handler
const SNAPSHOTS = new Map();   // company -> { at, promise }   (reused only on a warm instance)

async function loadSnapshot(company, opts){
  const key = (company || 'ALL').toString().trim().toLowerCase();
  const hit = SNAPSHOTS.get(key);
  if(!(opts && opts.fresh) && hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
  const promise = (async () => {
    const t0 = Date.now();
    const tabInfo = await discoverTabs();
    const sAttempts = [], rAttempts = [];
    const timed = p => p.then(x => { x._ms = Date.now() - t0; return x; });
    let s, r;
    try{ [s, r] = await Promise.all([ timed(readSurvey(tabInfo.tabs, sAttempts)), readLeads(tabInfo.tabs, rAttempts) ]); }
    catch(e){ e.attempts = { survey: sAttempts, restaurant: rAttempts }; e.tabs = tabInfo.tabs; e.tabsNote = tabInfo.note; throw e; }
    const snap = buildSnapshot(s.rows, r.rows, company, s.labels, { kind: s.kind });
    snap.payload.timing = { surveyMs: s._ms, totalMs: Date.now() - t0 };
    // what was read from where (shown in the dashboard's "Data service details")
    snap.payload.sources = {
      survey: { tab: s.tab || null, id: s.gid || null, via: s.kind, rows: s.rows.length },
      restaurant: r.failed ? { failed: true } : { tab: r.tab || null, id: r.gid || null, rows: r.rows.length },
    };
    const warnings = [];
    if(r.failed) warnings.push('The restaurant-leads tab (“New Restaurant”) could not be read, so New Leads show as 0. ' + (r.error || ''));
    const miss = missingOf(s.labels, SURVEY_REQUIRED);
    snap.payload.missingColumns = miss;
    if(miss.length) warnings.push('The survey tab has no column named ' + miss.map(c => '“' + c + '”').join(', ') + ', so numbers that depend on it will be missing or zero.');
    snap.payload.warnings = warnings;
    snap.attempts = { survey: sAttempts, restaurant: rAttempts }; snap.tabs = tabInfo.tabs; snap.tabsNote = tabInfo.note;
    return snap;
  })();
  SNAPSHOTS.set(key, { at: Date.now(), promise });
  promise.catch(() => { if(SNAPSHOTS.get(key) && SNAPSHOTS.get(key).promise === promise) SNAPSHOTS.delete(key); });
  return promise;
}

async function handler(req, res){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try{
    const q = req.query || {};
    const company = (q.company || 'ALL').toString().trim() || 'ALL';

    // ---- ?debug=1 : a plain report of what was tried and what came back (counts and names only — no survey data)
    if(q.debug){
      const out = { ok: false };
      try{
        const snap = await loadSnapshot(company, { fresh: true });
        Object.assign(out, { ok: true, rows: snap.payload.n, readAs: snap.payload.readAs, sources: snap.payload.sources, warnings: snap.payload.warnings,
          missingColumns: snap.payload.missingColumns, timing: snap.payload.timing, dateSources: snap.payload.dateSources, dateUnresolved: snap.payload.dateUnresolved,
          attempts: snap.attempts, tabsFound: snap.tabs, tabListNote: snap.tabsNote || '' });
      }catch(e){ Object.assign(out, { error: e.message, attempts: e.attempts || null, tabsFound: e.tabs || null, tabListNote: e.tabsNote || '' }); }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(out);
      return;
    }

    const snap = await loadSnapshot(company);

    // ---- restaurant names, pinned to one data version (so they can never be mismatched)
    if(q.names){
      if(q.v !== snap.v){
        res.setHeader('Cache-Control', 'no-store');
        res.status(409).json({ error: 'stale', v: snap.v });
        return;
      }
      const part = Math.max(0, parseInt(q.part, 10) || 0);
      const from = part * NAMES_CHUNK;
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.status(200).json({ v: snap.v, part, from, names: snap.names.slice(from, from + NAMES_CHUNK) });
      return;
    }

    // ---- the packed dataset
    const text = JSON.stringify(snap.payload);
    if(text.length > MAX_PAYLOAD_CHARS){
      res.setHeader('Cache-Control', 'no-store');
      res.status(413).json({ error: 'dataset too large for the fast feed' });
      return;
    }
    // max-age=0: the BROWSER always asks again (a cheap 304 when nothing changed). The CDN shares one copy for
    // 2 minutes and may serve it up to 15 more while it refreshes in the background; beyond that a failing
    // refresh shows up as an error instead of the dashboard silently showing days-old data.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=900');
    res.setHeader('ETag', `"${snap.v}"`);
    if(req.headers && req.headers['if-none-match'] === `"${snap.v}"`){ res.status(304).end(); return; }
    res.status(200).send(text);
  }catch(err){
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}

module.exports = handler;
module.exports._internals = { fetchTimeout, canonLabels, discoverTabs, readSurvey, readLeads, loadSnapshot, resetCaches: () => { SNAPSHOTS.clear(); TABS_CACHE = null; }, parseDate, detectDateOrder, pickDateColumns, buildSnapshot, tableToObjects, fetchTable, isoFromGvizDate, pack, parseCsv, csvToRows, fetchSurveyCsv, isDateLike, NAMES_CHUNK, SNAPSHOTS };
