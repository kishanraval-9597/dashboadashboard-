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

async function gviz(gid, query){
  let url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${gid}&headers=1&tqx=out:json`;
  if(query) url += '&tq=' + encodeURIComponent(query);
  const res = await fetch(url);
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
async function fetchTable(gid, wanted){
  const labelsOf = t => t.cols.map(c => (c.label || c.id || '').trim());
  try{
    const head = await gviz(gid, 'select * limit 1');
    const idByLabel = {};
    head.cols.forEach(c => { const label = (c.label || c.id || '').trim(); if(label && !(label in idByLabel)) idByLabel[label] = c.id; });
    const extra = head.cols.map(c => (c.label || c.id || '').trim()).filter(l => isDateLike(l) && !wanted.includes(l));
    const ids = wanted.concat(wanted === SURVEY_COLS ? extra : []).map(l => idByLabel[l]).filter(Boolean);
    if(ids.length && ids.length < head.cols.length) return { table: await gviz(gid, 'select ' + ids.join(',')), labels: labelsOf(head) };
  }catch(e){ /* fall through to the plain download */ }
  const table = await gviz(gid, null);
  return { table, labels: labelsOf(table) };
}

function tableToObjects(table, keep){
  const keepSet = new Set(keep);
  const dateLikeKeep = l => keepSet.has(l) || (keep === SURVEY_COLS && isDateLike(l));
  const cols = table.cols.map(c => (c.label || c.id || '').trim());
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
  const labels = parseCsv(text.slice(bom, nl).replace(/\r$/, ''), null)[0].map(s => (s || '').trim());
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

async function fetchSurveyCsv(){
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GIDS.survey}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CSV export HTTP ' + res.status);
  const text = await res.text();
  if(/^\s*</.test(text.slice(0, 300))) throw new Error('CSV export returned a web page instead of data');
  const out = csvToRows(text);
  if(!out.rows.length || !out.labels.includes('Date') && !out.labels.some(isDateLike)) throw new Error('CSV export had no usable rows or date column');
  return out;
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
    names: { chunk: NAMES_CHUNK, parts: Math.ceil(survey.length / NAMES_CHUNK) },
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

async function loadSnapshot(company){
  const key = (company || 'ALL').toString().trim().toLowerCase();
  const hit = SNAPSHOTS.get(key);
  if(hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
  const promise = (async () => {
    // Survey tab: the sheet's own text (CSV) first; Google's query API only if that is unavailable.
    const surveyP = fetchSurveyCsv().then(c => ({ rows: c.rows, labels: c.labels, kind: 'csv' }))
      .catch(async () => {
        const g = await fetchTable(GIDS.survey, SURVEY_COLS);
        const rows = tableToObjects(g.table, SURVEY_COLS); rows.forEach((o, i) => { o.__row = i + 2; });
        return { rows, labels: g.labels, kind: 'gviz' };
      });
    const [s, r] = await Promise.all([ surveyP, fetchTable(GIDS.restaurant, REST_COLS) ]);
    return buildSnapshot(s.rows, tableToObjects(r.table, REST_COLS), company, s.labels, { kind: s.kind });
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
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400');
    res.setHeader('ETag', `"${snap.v}"`);
    if(req.headers && req.headers['if-none-match'] === `"${snap.v}"`){ res.status(304).end(); return; }
    res.status(200).send(text);
  }catch(err){
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: err.message });
  }
}

module.exports = handler;
module.exports._internals = { parseDate, detectDateOrder, pickDateColumns, buildSnapshot, tableToObjects, fetchTable, isoFromGvizDate, pack, parseCsv, csvToRows, fetchSurveyCsv, isDateLike, NAMES_CHUNK, SNAPSHOTS };
