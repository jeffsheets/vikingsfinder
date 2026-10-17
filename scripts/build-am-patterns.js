/**
 * Add FCC AM antenna data to js/stations.js: station class and, for day and
 * night, the unattenuated field at 1 km — one number for a non-directional
 * antenna, or 72 values (every 5° from true north) for a directional array.
 *
 * Source: FCC CDBS public database files am_ant_sys.dat and am_towers.dat
 * (https://transition.fcc.gov/ftp/Bureaus/MB/Databases/cdbs/am_ant_sys.zip,
 * am_towers.zip — CDBS was frozen in January 2024, so licenses granted since
 * then aren't in it and those stations keep the generic estimate). Rows are
 * linked by the application ID of the license in scripts/fcc-data-cache.json.
 *
 * am_ant_sys fields used (1-based): 2 ant_sys_id, 3 application_id,
 *   12 hours (D day / N night / U unlimited), 21 Q factor, 23 power (kW),
 *   26 RMS theoretical field (mV/m at 1 km), 27 tower count. (Field 1, the
 *   station's antenna mode, describes the station, not the row: a DAN
 *   station's daytime row is a single tower.)
 * am_towers fields used: 1 ant_sys_id, 3 electrical height (deg), 4 field ratio,
 *   9 orientation (deg true), 10 phasing (deg), 12 spacing (deg),
 *   13 tower-ref switch (0 = from the reference tower, 1 = from the previous
 *   tower), 18 tower number.
 *
 * RMS units differ by antenna type (checked across every record): directional
 * rows store the RMS at licensed power (250–450 mV/m per √kW), non-directional
 * rows store it per kW (above 5 kW nearly all would be < 150 per √kW
 * otherwise). If the expected reading gives an implausible efficiency
 * (outside 150–500 mV/m for 1 kW) and the other reading doesn't, use the other.
 *
 * Directional patterns are the FCC standard pattern in the horizontal plane
 * (47 CFR 73.150): E_th(φ) = k·|Σ Fᵢ·exp(j(Sᵢ·cos(φ − φᵢ) + ψᵢ))| scaled so its
 * RMS equals the licensed theoretical RMS, then E_std = 1.05·√(E_th² + Q²)
 * with Q = the licensed Q factor, else max(0.025·E_rss, 10·√P). Pattern
 * augmentations (am_augs) are not applied.
 *
 * Usage: node scripts/build-am-patterns.js <dir with am_ant_sys.dat and am_towers.dat>
 */

const fs = require('fs');
const path = require('path');

const cdbsDir = process.argv[2];
if (!cdbsDir) {
  console.error('Usage: node scripts/build-am-patterns.js <cdbs dir>');
  process.exit(1);
}

const RADIALS = 72;
const rad = Math.PI / 180;

const readRows = file => fs.readFileSync(path.join(cdbsDir, file), 'latin1')
  .split('\n').filter(l => l.includes('|')).map(l => l.split('|'));

const antSysByApp = new Map();
for (const f of readRows('am_ant_sys.dat')) {
  const row = {
    id: f[1], hours: f[11], q: parseFloat(f[20]) || null,
    power: parseFloat(f[22]), rms: parseFloat(f[25]), towerCount: parseInt(f[26], 10) || 1
  };
  if (!antSysByApp.has(f[2])) antSysByApp.set(f[2], []);
  antSysByApp.get(f[2]).push(row);
}

const towersBySys = new Map();
for (const f of readRows('am_towers.dat')) {
  const t = {
    ratio: parseFloat(f[3]), orientation: parseFloat(f[8]) || 0, phase: parseFloat(f[9]) || 0,
    spacing: parseFloat(f[11]) || 0, refSwitch: f[12], number: parseInt(f[17], 10) || 0
  };
  if (!towersBySys.has(f[0])) towersBySys.set(f[0], []);
  towersBySys.get(f[0]).push(t);
}

const plausible = perKw => perKw >= 150 && perKw <= 500;

// Field at 1 km for 1 kW from a stored RMS, resolving the per-kW / at-power ambiguity
function perKwField(sys) {
  const atPower = sys.rms / Math.sqrt(sys.power);
  const perKw = sys.rms;
  const directional = sys.towerCount > 1;
  const [first, second] = directional ? [atPower, perKw] : [perKw, atPower];
  return (!plausible(first) && plausible(second)) ? second : first;
}

// Tower positions in the horizontal plane (electrical degrees, x east / y north)
function towerPositions(towers) {
  const sorted = [...towers].sort((a, b) => a.number - b.number);
  const pos = [];
  sorted.forEach((t, i) => {
    const base = (t.refSwitch === '1' && i > 0) ? pos[i - 1] : { x: 0, y: 0 };
    pos.push({
      x: base.x + t.spacing * Math.sin(t.orientation * rad),
      y: base.y + t.spacing * Math.cos(t.orientation * rad),
      ratio: t.ratio, phase: t.phase
    });
  });
  return pos;
}

// Standard-pattern field at 1 km, every 360/RADIALS degrees, at licensed power
function directionalPattern(sys, towers) {
  const pos = towerPositions(towers);
  const raw = [];
  for (let i = 0; i < RADIALS; i++) {
    const az = i * 360 / RADIALS * rad;
    let re = 0, im = 0;
    for (const t of pos) {
      // Path-length phase toward azimuth az: projection of the tower position on that direction
      const arg = (t.x * Math.sin(az) + t.y * Math.cos(az)) * rad + t.phase * rad;
      re += t.ratio * Math.cos(arg);
      im += t.ratio * Math.sin(arg);
    }
    raw.push(Math.hypot(re, im));
  }
  const rawRms = Math.sqrt(raw.reduce((s, v) => s + v * v, 0) / raw.length);
  const rmsAtPower = perKwField(sys) * Math.sqrt(sys.power);
  const k = rmsAtPower / rawRms;
  const rss = k * Math.sqrt(pos.reduce((s, t) => s + t.ratio * t.ratio, 0));
  const q = sys.q || Math.max(0.025 * rss, 10 * Math.sqrt(sys.power));
  return raw.map(v => Math.round(1.05 * Math.sqrt((k * v) ** 2 + q * q)));
}

function fieldFor(sys) {
  if (!sys || !(sys.rms > 0) || !(sys.power > 0)) return null;
  const towers = towersBySys.get(sys.id) || [];
  if (sys.towerCount < 2 || towers.length < 2) {
    return Math.round(perKwField(sys) * Math.sqrt(sys.power));
  }
  return directionalPattern(sys, towers);
}

const fccData = JSON.parse(fs.readFileSync('./scripts/fcc-data-cache.json', 'utf8'));
const stationsSrc = fs.readFileSync('./js/stations.js', 'utf8');
const stations = JSON.parse(stationsSrc.replace(/^const stations = /, '').replace(/;\s*$/, ''));
const bare = c => c.replace(/-(AM|FM)$/, '');

let matched = 0;
const missing = [];
const describe = f => f == null ? '—' : Array.isArray(f) ? `DA ${Math.min(...f)}–${Math.max(...f)}` : `ND ${f}`;
const updated = stations.map(station => {
  if (station.Format !== 'AM') return station;
  const rows = fccData.filter(fcc => fcc.format === 'AM' && fcc.status === 'LIC' &&
    bare(fcc.callSign) === (station.fccCallSign || station.CallSign) &&
    Math.abs(fcc.frequency - station.Frequency) < 0.5);
  const out = { ...station };
  delete out.amClass; delete out.amFieldDay; delete out.amFieldNight;
  if (!rows.length) { missing.push(`${station.CallSign} ${station.Frequency} (no FCC row)`); return out; }
  const raw = rows[0].rawLine.split('|');
  out.amClass = raw[7].trim() || undefined;
  const appIds = [...new Set(rows.map(r => r.rawLine.split('|')[31].trim()))];
  const systems = appIds.flatMap(id => antSysByApp.get(id) || []);
  const day = systems.find(s => s.hours === 'D') || systems.find(s => s.hours === 'U');
  const night = systems.find(s => s.hours === 'N') || systems.find(s => s.hours === 'U');
  const fDay = fieldFor(day), fNight = fieldFor(night);
  if (fDay != null) out.amFieldDay = fDay;
  if (fNight != null && station.powerNight > 0) out.amFieldNight = fNight;
  if (fDay == null) missing.push(`${station.CallSign} ${station.Frequency} (app ${appIds.join(',')} not in CDBS)`);
  else matched++;
  console.log(`${station.CallSign.padEnd(5)} ${String(station.Frequency).padStart(4)} class ${out.amClass || '?'}  day ${describe(fDay)}  night ${describe(out.amFieldNight)}  (generic day ${Math.round(300 * Math.sqrt(station.power))})`);
  return out;
});

fs.writeFileSync('./js/stations.js', `const stations = ${JSON.stringify(updated, null, 2)};\n`);
console.log(`\n✓ ${matched} AM stations got FCC antenna data`);
if (missing.length) console.log(`⚠️  Generic estimate kept for:\n  ${missing.join('\n  ')}`);
