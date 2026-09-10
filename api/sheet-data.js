// Vercel serverless function — runs on Vercel's own servers, not Google's.
// This is the Vercel port of netlify/functions/sheet-data.js — same logic,
// just Vercel's (req, res) handler signature instead of Netlify's
// exports.handler(event) returning {statusCode, headers, body}.
//
// Two modes:
// 1. sheet=survey / sheet=restaurant: fetches via gviz JSON, filters rows by
//    company server-side, returns a whitelist of columns as row objects.
// 2. sheet=summary: serves a static snapshot (see note below) as a plain
//    grid (array of arrays of strings) for the dashboard to parse.

const KEEP_COLUMNS = {
  survey: ['Date', 'Employee Name', 'Res Available', 'Swiggy Live', 'Zomato Live', 'Ex Software', 'Region', 'Res Name'],
  restaurant: ['Date', 'Employee Name', 'Live On Swiggy', 'Live On Zomato', 'Existing Software Final', 'Outlet Type', 'City', 'State'],
};

// TEMPORARY FALLBACK — the Survey Summary tab this used to read from was
// deleted from the spreadsheet. Until a new tab is recreated and a working
// gid is provided, this static snapshot (from the file provided on
// 2026-09-02) is served instead — Tab 3 stays visible, just not
// auto-updating, until that's done. Once a new gid is available, restore a
// live gviz-CSV fetch here (see the Netlify version's git history for the
// fetch-with-fallback pattern), keeping this static data as the fallback.
const STATIC_SUMMARY_CSV = `Restaurant Survey Summary - 02-09-2026,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
Status,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,
Total Outlets,"3,12,448",100%,"54,699",100%,"20,868",100%,"34,819",100%,"34,675",100%,"95,256",100%,"45,999",100%,"26,132",100%,
Restaurant Visit,"51,811",16.60%,"25,782",47.10%,"10,800",51.80%,"11,696",33.60%,368,1.10%,2032,2.10%,848,1.80%,285,1.10%,
Not Available Restaurant,"26,975",52%,"11,495",45%,"5,803",54%,"7,073",60%,288,78%,1477,72.70%,658,77.60%,181,63.50%,
Available Restaurant,"24,836",48%,"14,287",55%,"4,997",46%,"4,623",40%,80,22%,555,27.30%,190,22.40%,104,36.50%,
Visit Pending,"2,60,637",83%,"28,917",53%,"10,068",48%,"23,123",66%,"34,307",99%,93224,97.90%,45151,98.20%,"25,847",98.90%,
,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
Zomato Presence,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,
Live on Zomato,"21,245",86%,"12,722",89%,"4,474",89.50%,"4,049",88%,63,79%,413,74%,167,88%,62,60%,
Not Live on Zomato,"2,662",11%,"1,565",11%,523,10.50%,574,12%,17,21.30%,142,26%,23,12%,42,40%,
,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
Swiggy Presence,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,
Live on Swigyy,"20,349",82%,"12,326",86%,"4,261",85%,"3,762",81%,58,73%,371,67%,167,88%,61,59%,
Not Live on Swiggy,"3,558",14%,"1,961",14%,736,15%,861,19%,22,27.50%,184,33%,23,12%,43,41%,
,,,,,,,,,,,,,,,,,
Total Live Restaurants,Total,,Mumbai,,Kolkata,,Pune,,Hyderabad,,Delhi - NCR,,Bangalore,,Chennai,,
Available Restaurant,"24,836",,"14,287",,"4,997",,"4,623",,80,,555,,190,,104,,
New Restaurants,821,,222,,101,,370,,16,,111,,0,,1,,
Total Live Restaurants,"25,657",,"14,509",,"5,098",,"4,993",,96,,666,,190,,105,,
,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
Existing Data Summary,,,,,,,,,,,,,,,,,
Billing System Usage,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,Cloud/Offline
Manual Billing,9183,37.00%,4704,32.90%,2135,42.70%,1697,36.70%,34,42.50%,437,78.70%,116,61.10%,60,57.70%,Offline
Declined to Share,6447,26.00%,"5,204",36.40%,527,10.50%,650,14.10%,7,8.80%,29,5.20%,14,7.40%,16,15.40%,
Petpooja,3551,14.30%,"1,432",10.00%,"1,051",21.00%,981,21.20%,16,20.00%,37,6.70%,23,12.10%,11,10.60%,Cloud
Rista POS/ Dotpe,1436,5.80%,857,6.00%,369,7.40%,196,4.20%,0,0.00%,5,0.90%,8,4.20%,1,1.00%,Cloud
TM Bill,475,1.90%,177,1.20%,264,5.30%,32,0.70%,0,0.00%,2,0.40%,0,0.00%,0,0.00%,Cloud
EZO,405,1.60%,164,1.10%,215,4.30%,24,0.50%,1,1.30%,1,0.20%,0,0.00%,0,0.00%,Cloud
Own Software,1302,5.20%,379,2.70%,379,7.60%,510,11.00%,7,8.80%,14,2.50%,7,3.70%,6,5.80%,Cloud
Menson,714,2.87%,644,4.50%,0,0.00%,70,2%,0,0%,0,0.00%,0,0.00%,0,0.00%,Offline
PRIME,203,0.80%,161,1.10%,1,0.00%,38,0.80%,1,1.30%,0,0.00%,0,0.00%,2,1.90%,Offline
Posist (Restroworks),103,0.40%,48,0.30%,14,0.30%,41,0.90%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,Cloud
Aaryan,33,0.10%,2,0.00%,0,0.00%,31,0.70%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,Offline
Others,984,4.00%,515,3.60%,42,0.80%,353,7.60%,14,17.50%,30,5.40%,22,11.60%,8,7.70%,
Total,24836,,14287,,4997,,4623,,80,,555,,190,,104,,
,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
Billing System Usage,Total,,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,
Petpooja Presence,"3,551",,"1,432",10%,"1,051",21%,981,21%,16,20%,37,7%,23,12%,11,,
"Manual Billling + Offline(menson , prime , aryan)","10,133",,"5,511",39%,"2,136",43%,"1,836",40%,35,44%,437,79%,116,61%,62,,
Cloud Software Competition,"4,705",,"2,140",15%,"1,283",26%,"1,156",25%,22,28%,52,9%,37,19%,15,,
Not Answered,"6,447",,"5,204",36%,527,11%,650,14%,7,9%,29,5%,14,7%,16,,
Total,"24,836",,"14,287",,"4,997",,"4,623",,80,,555,,190,,104,,
,,,,,,,,,,,,,,,,,
Software Usage,%,,,,,,,,,,,,,,,,
Cloud,29.30%,,,,,,,,,,,,,,,,
Offline,40.80%,,,,,,,,,,,,,,,,
Not Answered,26.00%,,,,,,,,,,,,,,,,
Other Local Software,4.00%,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,
New Restaurants Summary,,,,,,,,,,,,,,,,,
Billing System Usage,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,Cloud/Offline
Manual Billing,243,29.60%,75,33.80%,76,75.20%,76,20.50%,11,68.80%,5,4.50%,0,,0,,Offline
Declined to Share,129,15.70%,63,28.40%,2,2.00%,35,9.50%,0,0.00%,28,25.20%,0,,1,100.00%,
Petpooja,200,24.40%,21,9.50%,17,16.80%,91,24.60%,2,12.50%,69,62.20%,0,,0,,Cloud
Rista POS/ Dotpe,14,1.70%,6,2.70%,0,0.00%,8,2.20%,0,0.00%,0,0.00%,0,,0,,Cloud
TM Bill,8,1.00%,3,1.40%,0,0.00%,5,1.40%,0,0.00%,0,0.00%,0,,0,,Cloud
EZO,5,0.60%,1,0.50%,1,1.00%,3,0.80%,0,0.00%,0,0.00%,0,,0,,Cloud
Own Software,37,4.50%,5,2.30%,1,1.00%,30,8.10%,0,0.00%,1,0.90%,0,,0,,Cloud
Menson,33,4.02%,20,9.00%,0,0.00%,13,4%,0,0%,0,0.00%,0,,0,,Offline
PRIME,0,0.00%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,0,,0,,Offline
Posist (Restroworks),4,0.50%,0,0.00%,0,0.00%,4,1.10%,0,0.00%,0,0.00%,0,,0,,Cloud
Aaryan,2,0.20%,0,0.00%,0,0.00%,1,0.30%,0,0.00%,1,0.90%,0,,0,,Offline
Others,146,17.80%,28,12.60%,4,4.00%,104,28.10%,3,18.80%,7,6.30%,0,,0,,
Total,821,,222,,101,,370,,16,,111,,0,,1,,
,,,,,,,,,,,,,,,,,
Final Available Restaurants,,,,,,,,,,,,,,,,,
Billing System Usage,Total,%,Mumbai,%,Kolkata,%,Pune,%,Hyderabad,%,Delhi - NCR,%,Bangalore,%,Chennai,%,Cloud/Offline
Manual Billing,9426,36.70%,4342,29.90%,2040,40.00%,1536,30.80%,22,22.90%,442,66.40%,116,61.10%,60,57.10%,Offline
Declined to Share,6576,25.60%,"5,129",35.40%,506,9.90%,667,13.40%,8,8.30%,57,8.60%,14,7.40%,16,15.20%,
Petpooja,3751,14.60%,"1,311",9.00%,"1,008",19.80%,781,15.60%,8,8.30%,106,15.90%,23,12.10%,11,10.50%,Cloud
Rista POS/ Dotpe,1450,5.70%,822,5.70%,359,7.00%,165,3.30%,0,0.00%,5,0.80%,8,4.20%,1,1.00%,Cloud
TM Bill,483,1.90%,177,1.20%,263,5.20%,29,0.60%,0,0.00%,2,0.30%,0,0.00%,0,0.00%,Cloud
EZO,410,1.60%,163,1.10%,214,4.20%,25,0.50%,0,0.00%,1,0.20%,0,0.00%,0,0.00%,Cloud
Own Software,1339,5.20%,329,2.30%,365,7.20%,337,6.70%,6,6.30%,15,2.30%,7,3.70%,6,5.70%,Cloud
Menson,747,2.91%,586,4.00%,0,0.00%,62,1.20%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,Offline
PRIME,203,0.80%,161,1.10%,0,0.00%,1,0.00%,0,0.00%,0,0.00%,0,0.00%,2,1.90%,Offline
Posist (Restroworks),107,0.40%,38,0.30%,13,0.30%,40,0.80%,0,0.00%,0,0.00%,0,0.00%,0,0.00%,Cloud
Aaryan,35,0.10%,2,0.00%,0,0.00%,23,0.50%,0,0.00%,1,0.20%,0,0.00%,0,0.00%,Offline
Others,1130,4.40%,557,3.80%,55,1.10%,427,8.60%,23,24.00%,37,5.60%,22,11.60%,8,7.60%,
`;

const DATE_COLUMNS = new Set(['Date']);
const GVIZ_DATE_RE = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+)(?:,(\d+))?)?\)$/;

function pad2(n){ return String(n).padStart(2, '0'); }

function isoFromGvizDate(raw){
  if (typeof raw !== 'string') return null;
  const m = raw.match(GVIZ_DATE_RE);
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const datePart = `${y}-${pad2(Number(mo) + 1)}-${pad2(d)}`;
  if (hh === undefined) return datePart;
  return `${datePart} ${pad2(hh)}:${pad2(mi || '0')}`;
}

const SHEET_ID = '1apR0AaWF5MrAryfJHv6iN4C4Vd_38JbHY-5AXczTBQk';
const SHEETS = {
  survey:     { gid: '0' },
  restaurant: { gid: '1417791305' },
  summary:    { gid: '1686804958' },
};
const EMPLOYEE_NAME_COLUMN = 'Employee Name';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else { field += ch; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const query = req.query || {};
    const company = (query.company || 'ALL').toString().trim();
    const sheetKey = (query.sheet || 'survey').toString().trim().toLowerCase();
    const sheetInfo = SHEETS[sheetKey] || SHEETS.survey;

    // ---- Summary tab: static snapshot, see note above ----
    if (sheetKey === 'summary') {
      const grid = parseCSV(STATIC_SUMMARY_CSV);
      res.status(200).json({ grid, usedFallback: true });
      return;
    }

    // ---- Survey / Restaurant tabs: gviz JSON + company filter ----
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${sheetInfo.gid}&headers=1&tqx=out:json`;

    const sheetRes = await fetch(url);
    if (!sheetRes.ok) {
      res.status(502).json({ error: 'Could not reach the sheet (HTTP ' + sheetRes.status + ')' });
      return;
    }
    const text = await sheetRes.text();

    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start === -1 || end === -1) {
      res.status(502).json({ error: 'Unexpected response format from the sheet' });
      return;
    }
    const data = JSON.parse(text.substring(start + 1, end));

    if (data.status === 'error') {
      const msg = (data.errors && data.errors[0] && data.errors[0].detailed_message) || 'Query error';
      res.status(502).json({ error: msg });
      return;
    }

    const table = data.table;
    const cols = table.cols.map(c => (c.label || c.id || '').trim());
    const keep = KEEP_COLUMNS[sheetKey] || KEEP_COLUMNS.survey;
    const keepSet = new Set(keep);

    let rows = (table.rows || []).map(row => {
      const obj = {};
      (row.c || []).forEach((cell, i) => {
        const key = cols[i];
        if (!key || !keepSet.has(key)) return;
        if (DATE_COLUMNS.has(key) && cell) {
          const iso = isoFromGvizDate(cell.v);
          if (iso) { obj[key] = iso; return; }
        }
        const v = cell ? ((cell.f !== undefined && cell.f !== null && cell.f !== '') ? cell.f : cell.v) : '';
        obj[key] = (v === null || v === undefined) ? '' : v;
      });
      return obj;
    });

    if (company.toUpperCase() !== 'ALL') {
      const needle = company.toLowerCase();
      rows = rows.filter(r => (r[EMPLOYEE_NAME_COLUMN] || '').toString().toLowerCase().indexOf(needle) !== -1);
    }

    res.status(200).json({ rows, company, sheet: sheetKey });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
