/**
 * Add per-direction FM antenna heights to js/stations.js from the FCC's FM
 * service contour data, so FM reach follows terrain (and directional FM
 * antennas) instead of one average antenna height for every direction.
 *
 * Source: FCC FM service contour data points
 * (https://www.fcc.gov/media/radio/fm-service-contour-data-points; zip at
 * https://transition.fcc.gov/bureaus/mb/databases/map/FM_service_contour_current.zip,
 * which the FCC regenerates daily). Each record is a station's predicted
 * service contour — 60 dBu for the stations here (Zone II commercial, NCE and
 * translators) — as 360 points, one per degree, computed by the FCC from the
 * F(50,50) curves with that direction's ERP and antenna height above that
 * radial's average terrain. Records are linked by the LMS application ID in
 * field 38 of the station's row in scripts/fcc-data-cache.json.
 *
 * For every 5° radial this solves fmFieldStrengthDbu(ERP, h, d) = 60 dBu for
 * the effective height h that puts the 60 dBu edge exactly where the FCC's
 * contour is. js/lib.js then uses that height for every tier on that radial,
 * the same way the FCC would compute any other contour for the station. Where
 * no height in the F(50,50) range (30–1524 m) reaches the FCC distance — a
 * directional antenna's deep null, or a hilltop translator — the height is
 * clamped and the remaining difference is stored as a dB offset.
 *
 * Usage: node scripts/build-fm-radials.js <FM_service_contour_current.txt>
 */

const fs = require('fs');
const vm = require('vm');

const contourFile = process.argv[2];
if (!contourFile) {
  console.error('Usage: node scripts/build-fm-radials.js <FM_service_contour_current.txt>');
  process.exit(1);
}

const RADIALS = 72;
const CONTOUR_DBU = 60;

// Use the app's own F(50,50) implementation so the inversion matches exactly
const ctx = { Math, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('./js/lib.js', 'utf8'), ctx);
const fmDbu = (erp, h, d) => vm.runInContext(`fmFieldStrengthDbu(${erp}, ${h}, ${d})`, ctx);

const fccData = JSON.parse(fs.readFileSync('./scripts/fcc-data-cache.json', 'utf8'));
const stationsSrc = fs.readFileSync('./js/stations.js', 'utf8');
const stations = JSON.parse(stationsSrc.replace(/^const stations = /, '').replace(/;\s*$/, ''));
const bare = c => c.replace(/-(AM|FM)$/, '');

// LMS application IDs of the FM/FX licenses we need
const wanted = new Map(); // lms id -> station keys
const lmsFor = station => {
  const call = station.translatorCallSign || station.fccCallSign || station.CallSign;
  let rows = fccData.filter(f => f.format === 'FM' && f.status === 'LIC' &&
    bare(f.callSign) === call && Math.abs(f.frequency - station.Frequency) < 0.05);
  // Display call sign differs from the license (KFAN is licensed KFXN-FM):
  // fall back to the license on this frequency at this tower
  if (!rows.length) {
    rows = fccData.filter(f => f.format === 'FM' && f.status === 'LIC' &&
      Math.abs(f.frequency - station.Frequency) < 0.05 &&
      Math.abs(f.latitude - station.latitude) < 0.01 && Math.abs(f.longitude - station.longitude) < 0.01);
  }
  return rows.map(r => (r.rawLine.split('|')[38] || '').trim()).filter(Boolean);
};
stations.forEach(s => { if (s.Format === 'FM') lmsFor(s).forEach(id => wanted.set(id, true)); });

// Stream the 200 MB contour file, keeping only our records
const contours = new Map();
const text = fs.readFileSync(contourFile, 'latin1');
let start = text.indexOf('\n') + 1;
while (start < text.length) {
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  const line = text.slice(start, end);
  start = end + 1;
  const f = line.split('|');
  const id = (f[2] || '').trim();
  if (!wanted.has(id)) continue;
  const [tlat, tlon] = f[4].split(',').map(Number);
  const pts = f.slice(5, 365).map(p => p.split(',').map(Number));
  contours.set(id, { tlat, tlon, pts });
}

const rad = Math.PI / 180;
const km = (aLat, aLon, bLat, bLon) => {
  const h = Math.sin((bLat - aLat) * rad / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin((bLon - aLon) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// Effective height (and leftover dB) giving CONTOUR_DBU at distance d
function solveHeight(erp, d) {
  let lo = 30.5, hi = 1524;
  if (fmDbu(erp, hi, d) < CONTOUR_DBU) return [hi, CONTOUR_DBU - fmDbu(erp, hi, d)];
  if (fmDbu(erp, lo, d) > CONTOUR_DBU) return [lo, CONTOUR_DBU - fmDbu(erp, lo, d)];
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fmDbu(erp, mid, d) < CONTOUR_DBU) lo = mid; else hi = mid;
  }
  return [(lo + hi) / 2, 0];
}

let done = 0;
const missing = [];
const updated = stations.map(station => {
  if (station.Format !== 'FM') return station;
  const out = { ...station };
  delete out.fmHaatRadials; delete out.fmOffsetRadials;
  const contour = lmsFor(station).map(id => contours.get(id)).find(Boolean);
  if (!contour || !station.power) {
    missing.push(`${station.CallSign} ${station.Frequency}${station.translatorCallSign ? ` (${station.translatorCallSign})` : ''}`);
    return out;
  }
  const heights = [], offsets = [];
  for (let i = 0; i < RADIALS; i++) {
    const [lat, lon] = contour.pts[i * 360 / RADIALS];
    const [h, off] = solveHeight(station.power, km(contour.tlat, contour.tlon, lat, lon));
    heights.push(Math.round(h));
    offsets.push(Math.round(off * 10) / 10);
  }
  out.fmHaatRadials = heights;
  if (offsets.some(o => Math.abs(o) >= 0.5)) out.fmOffsetRadials = offsets;
  done++;
  return out;
});

// Report a few stations so the spread is visible
updated.filter(s => s.fmHaatRadials).slice(0, 400).forEach(s => {
  const h = s.fmHaatRadials;
  console.log(`${(s.translatorCallSign || s.CallSign).padEnd(7)} ${String(s.Frequency).padStart(5)}  licensed HAAT ${String(Math.round(s.haat)).padStart(4)} m  radial ${Math.min(...h)}–${Math.max(...h)} m${s.fmOffsetRadials ? `  offsets ${Math.min(...s.fmOffsetRadials)}..${Math.max(...s.fmOffsetRadials)} dB` : ''}`);
});

fs.writeFileSync('./js/stations.js', `const stations = ${JSON.stringify(updated, null, 2)};\n`);
console.log(`\n✓ ${done} FM entries got FCC per-radial heights`);
if (missing.length) console.log(`⚠️  No FCC contour (kept the single licensed HAAT): ${[...new Set(missing)].join(', ')}`);
