/**
 * Compute each AM station's nighttime interference limit the way the FCC
 * computes its nighttime interference-free (NIF) limit, and store it per 5°
 * radial in js/stations.js as amNightLimit (mV/m). At night js/lib.js puts
 * the Fair floor at that limit: inside it the station is louder than the
 * interference by the FCC's protection ratio; outside it the channel fills
 * with skywave from distant stations.
 *
 * The FCC's NIF uses the interfering skywave exceeded 10% of the time — a
 * worst-case planning standard. Like the daytime tiers (calibrated to a car
 * radio, not FCC planning values), Fair uses the typical night: the same
 * calculation with 50% skywave values. The 10% (FCC) figure is logged for
 * reference; with the usual 12 dB tier spacing the Good floor lands at or
 * above it.
 *
 * Method (47 CFR 73.182, 73.190):
 *  - Interferers: every station on the same channel or ±10 kHz that operates
 *    at night (FCC AM query, all countries; US stations only if licensed),
 *    with its night antenna from the FCC CDBS files when available.
 *  - Each interferer's skywave field at a point: Formula 1 (Fc(50), for a
 *    characteristic field of 100 mV/m at 1 km; Formula 2 adds Δ for 10%), scaled by
 *    the interferer's radiation toward that point at the Figure 6a departure
 *    angle (tower vertical factors, directional array, FCC standard pattern).
 *  - Times the protection ratio: 26 dB (20:1) co-channel, 0 dB first adjacent
 *    (73.182(r): desired 50% skywave to undesired 10% skywave).
 *  - Root-sum-square with the 50% exclusion of 73.182(k)(1).
 *  - Evaluated on the limit itself: for each radial, find where the desired
 *    station's night groundwave falls to the RSS limit computed at that spot
 *    (two passes, starting from the limit at the tower).
 *
 * Assumptions (stated, not FCC data): stations without CDBS antenna records
 * (foreign stations, US licenses granted after CDBS froze in Jan 2024) are
 * treated as a non-directional quarter-wave tower radiating 300 mV/m·√kW;
 * departure angles use the 10% curve with K2; tower top-loading and pattern
 * augmentations are ignored.
 *
 * Usage: node scripts/build-am-night-limits.js <cdbs dir>
 *   (fetches the FCC AM query for each channel once into
 *    scripts/fcc-am-channel-cache.json)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const vm = require('vm');

const cdbsDir = process.argv[2];
if (!cdbsDir) { console.error('Usage: node scripts/build-am-night-limits.js <cdbs dir>'); process.exit(1); }

const RADIALS = 72;
const rad = Math.PI / 180, deg = 180 / Math.PI;
const CACHE = './scripts/fcc-am-channel-cache.json';

// --- app model (groundwave over M3, night patterns) -------------------------
const ctx = { Math, console, Date };
vm.createContext(ctx);
for (const f of ['js/stations.js', 'js/conductivity.js', 'js/lib.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8').replace(/^const (stations|M3_CONDUCTIVITY|AM_CURVATURE) =/mg, 'globalThis.$1 ='), ctx);
}
vm.runInContext('isNightAt = () => true', ctx);

// --- CDBS antenna systems ---------------------------------------------------
const readRows = file => fs.readFileSync(path.join(cdbsDir, file), 'latin1')
  .split('\n').filter(l => l.includes('|')).map(l => l.split('|'));
const sysByApp = new Map();
for (const f of readRows('am_ant_sys.dat')) {
  const row = { id: f[1], hours: f[11], q: parseFloat(f[20]) || null, power: parseFloat(f[22]),
    rms: parseFloat(f[25]), towerCount: parseInt(f[26], 10) || 1 };
  if (!sysByApp.has(f[2])) sysByApp.set(f[2], []);
  sysByApp.get(f[2]).push(row);
}
const towersBySys = new Map();
for (const f of readRows('am_towers.dat')) {
  const t = { height: parseFloat(f[2]) || 90, ratio: parseFloat(f[3]), orientation: parseFloat(f[8]) || 0,
    phase: parseFloat(f[9]) || 0, spacing: parseFloat(f[11]) || 0, refSwitch: f[12], number: parseInt(f[17], 10) || 0 };
  if (!towersBySys.has(f[0])) towersBySys.set(f[0], []);
  towersBySys.get(f[0]).push(t);
}

// --- antenna radiation at azimuth/elevation (mV/m at 1 km) ------------------
// Vertical factor of a uniform-current tower of electrical height G (73.160)
const vfac = (G, th) => {
  const g = G * rad, t = th * rad;
  const den = (1 - Math.cos(g)) * Math.cos(t);
  return Math.abs(den) < 1e-9 ? 0 : Math.abs((Math.cos(g * Math.sin(t)) - Math.cos(g)) / den);
};
const plausible = v => v >= 150 && v <= 500;
function perKwField(sys) {
  const atPower = sys.rms / Math.sqrt(sys.power);
  const [first, second] = sys.towerCount > 1 ? [atPower, sys.rms] : [sys.rms, atPower];
  return (!plausible(first) && plausible(second)) ? second : first;
}
function makeAntenna(sys, power) {
  const towers = sys ? (towersBySys.get(sys.id) || []) : [];
  if (!sys || !(sys.rms > 0) || towers.length === 0) {
    // No CDBS record: non-directional quarter-wave tower (assumption)
    const e = 300 * Math.sqrt(power);
    return (az, th) => e * vfac(90, th);
  }
  const sorted = [...towers].sort((a, b) => a.number - b.number);
  const pos = [];
  sorted.forEach((t, i) => {
    const base = (t.refSwitch === '1' && i > 0) ? pos[i - 1] : { x: 0, y: 0 };
    pos.push({ x: base.x + t.spacing * Math.sin(t.orientation * rad), y: base.y + t.spacing * Math.cos(t.orientation * rad),
      ratio: t.ratio, phase: t.phase, height: t.height });
  });
  const rmsAtPower = perKwField(sys) * Math.sqrt(sys.power);
  if (pos.length === 1) return (az, th) => rmsAtPower * vfac(pos[0].height, th);
  const raw = (az, th) => {
    let re = 0, im = 0;
    for (const t of pos) {
      const arg = (t.x * Math.sin(az * rad) + t.y * Math.cos(az * rad)) * Math.cos(th * rad) * rad + t.phase * rad;
      const a = t.ratio * vfac(t.height, th);
      re += a * Math.cos(arg); im += a * Math.sin(arg);
    }
    return Math.hypot(re, im);
  };
  let ss = 0; for (let i = 0; i < 360; i++) ss += raw(i, 0) ** 2;
  const k = rmsAtPower / Math.sqrt(ss / 360);
  const rss = k * Math.sqrt(pos.reduce((s, t) => s + t.ratio * t.ratio, 0));
  const q = sys.q || Math.max(0.025 * rss, 10 * Math.sqrt(sys.power));
  return (az, th) => 1.05 * Math.sqrt((k * raw(az, th)) ** 2 + (q * vfac(pos[0].height, th)) ** 2);
}

// --- FCC skywave (73.190 Formulas 1 & 2, Figure 6a) ------------------------
function skywave(aT, bT, aR, bR) {
  const dDeg = Math.acos(Math.min(1, Math.sin(aT * rad) * Math.sin(aR * rad) +
    Math.cos(aT * rad) * Math.cos(aR * rad) * Math.cos((bR - bT) * rad))) * deg;      // Eq. 5
  const d = 111.18 * dDeg;                                                             // Eq. 4
  const D = Math.sqrt(40000 + d * d);                                                  // Eq. 2
  const aM = 90 - Math.acos(Math.max(-1, Math.min(1, Math.sin(aR * rad) * Math.cos(dDeg / 2 * rad) +
    Math.cos(aR * rad) * Math.sin(dDeg / 2 * rad) *
    ((Math.sin(aT * rad) - Math.sin(aR * rad) * Math.cos(dDeg * rad)) / (Math.cos(aR * rad) * Math.sin(dDeg * rad)))))) * deg; // Eq. 6
  const k = bR > bT ? -1 : 1;
  const bM = bR + k * Math.acos(Math.max(-1, Math.min(1, (Math.cos(dDeg / 2 * rad) - Math.sin(aR * rad) * Math.sin(aM * rad)) /
    (Math.cos(aR * rad) * Math.cos(aM * rad))))) * deg;                                // Eq. 7
  let phiM = Math.asin(Math.sin(aM * rad) * Math.sin(78.5 * rad) +
    Math.cos(aM * rad) * Math.cos(78.5 * rad) * Math.cos((69 + bM) * rad)) * deg;     // Eq. 3
  if (Math.abs(phiM) > 60) phiM = 60;
  const fc50 = (97.5 - 20 * Math.log10(D)) - (2 * Math.PI + 4.95 * Math.tan(phiM * rad) ** 2) * Math.sqrt(D / 1000); // Eq. 1
  const a = Math.abs(phiM);
  const delta = a < 40 ? 6 : a > 60 ? 10 : 0.2 * a - 2;                                // Formula 2
  const x = d / 444.54;
  const theta = Math.atan(0.00938 / Math.tan(x * rad)) * deg - x;                       // Figure 6a (K2)
  return { db50: fc50, db10: fc50 + delta, theta: Math.max(0, theta), d };
}

// --- channel data from the FCC AM query -------------------------------------
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const get = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
  }).on('error', reject);
});
async function channelRows(freq) {
  const key = String(freq);
  if (!cache[key]) {
    const url = `https://transition.fcc.gov/fcc-bin/amq?call=&filenumber=&state=&city=&freq=${freq - 10}&fre2=${freq + 10}&serv=&status=&facid=&asrn=&class=&list=4&ThisTab=Results+to+This+Page%2FTab&dist=&dlat2=&mlat2=&slat2=&NS=N&dlon2=&mlon2=&slon2=&EW=W&size=9`;
    console.log(`Fetching FCC AM query ${freq - 10}–${freq + 10} kHz…`);
    cache[key] = (await get(url)).split('\n').filter(l => l.split('|').length > 30);
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    await new Promise(r => setTimeout(r, 1000));
  }
  return cache[key].map(line => {
    const f = line.split('|').map(s => s.trim());
    const lat = (f[19] === 'S' ? -1 : 1) * (+f[20] + f[21] / 60 + f[22] / 3600);
    const lon = (f[23] === 'W' ? -1 : 1) * (+f[24] + f[25] / 60 + f[26] / 3600);
    return { call: f[1].replace(/-AM$/, ''), freq: parseFloat(f[2]), hours: f[5], status: f[9], country: f[12],
      power: parseFloat(f[14]), lat, lon, facility: f[18], app: f[31] };
  });
}

function interferersFor(station, rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (!(r.hours === 'NIG' || r.hours === 'UNL') || !(r.power > 0) || !isFinite(r.lat)) continue;
    if (r.country === 'US' && r.status !== 'LIC') continue;
    if (Math.abs(r.freq - station.Frequency) < 1 && Math.abs(r.lat - station.latitude) < 0.02 && Math.abs(r.lon - station.longitude) < 0.02) continue; // the station itself
    // One entry per call sign per channel: the query lists some stations
    // more than once (pending and notified records); keep the most powerful
    const key = `${r.call}|${r.freq}|${r.country}`;
    if (seen.has(key)) {
      const prev = out.find(o => `${o.call}|${o.freq}|${o.country}` === key);
      if (prev && r.power <= prev.power) continue;
      if (prev) out.splice(out.indexOf(prev), 1);
    }
    seen.add(key);
    const systems = sysByApp.get(r.app) || [];
    const sys = systems.find(s => s.hours === 'N') || systems.find(s => s.hours === 'U') || null;
    out.push({ ...r, ratio: Math.abs(r.freq - station.Frequency) < 1 ? 20 : 1, antenna: makeAntenna(sys, r.power), cdbs: !!sys });
  }
  return out;
}

// RSS night limit (mV/m) at a point, with the 50% exclusion
function nightLimit(interferers, lat, lon, percent = 50) {
  const vals = interferers.map(I => {
    const s = skywave(I.lat, I.lon, lat, lon);
    const az = vm.runInContext(`bearingDegrees(${I.lat}, ${I.lon}, ${lat}, ${lon})`, ctx);
    const e = I.antenna(az, s.theta); // mV/m at 1 km toward the point
    if (s.d < 1) return 0; // co-located (a sister station on the same tower): not skywave
    const v = Math.pow(10, (percent === 10 ? s.db10 : s.db50) / 20) * (e / 100) * I.ratio / 1000; // mV/m
    return isFinite(v) ? v : 0;
  }).sort((a, b) => b - a);
  let sumSq = 0;
  for (const v of vals) {
    const rss = Math.sqrt(sumSq);
    if (sumSq > 0 && v < 0.5 * rss) continue;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq);
}

// Distance along a bearing where the station's night groundwave falls to `limit` mV/m
function reachTo(station, bearing, limit) {
  ctx.S = station;
  return vm.runInContext(`(() => { const now = amPowerNow(S); if (!now) return 0;
    const e1 = amFieldAt1Km(S, now, ${bearing}); let r = 0;
    walkAmPath(e1, S.Frequency, S.latitude, S.longitude, ${bearing}, 2000, (km, f) => { if (f < ${limit}) { r = km; return false; } r = km; });
    return r; })()`, ctx);
}

(async () => {
  const stations = ctx.stations;
  const done = new Map(); // freq@tower -> limits
  for (const s of stations) {
    if (s.Format !== 'AM' || !(s.powerNight > 0) || s.amClass === 'A') continue;
    const key = `${s.Frequency}@${s.latitude.toFixed(4)},${s.longitude.toFixed(4)}`;
    if (done.has(key)) continue;
    const interferers = interferersFor(s, await channelRows(s.Frequency));
    const limits = [];
    const fcc10 = nightLimit(interferers, s.latitude, s.longitude, 10);
    for (let i = 0; i < RADIALS; i++) {
      const b = i * 360 / RADIALS;
      let limit = nightLimit(interferers, s.latitude, s.longitude);
      for (let pass = 0; pass < 2; pass++) {
        const r = reachTo(s, b, limit);
        const p = vm.runInContext(`destinationPoint(${s.latitude}, ${s.longitude}, ${b}, ${r})`, ctx);
        limit = nightLimit(interferers, p.latitude, p.longitude);
      }
      limits.push(Math.round(limit * 100) / 100);
    }
    done.set(key, limits);
    const top = interferers.map(I => ({ I, v: nightLimit([I], s.latitude, s.longitude) })).sort((a, b) => b.v - a.v).slice(0, 3);
    console.log(`${s.CallSign.padEnd(5)} ${String(s.Frequency).padStart(4)} cls ${s.amClass}  night limit (50%) ${Math.min(...limits).toFixed(1)}–${Math.max(...limits).toFixed(1)} mV/m, FCC NIF (10%) at tower ${fcc10.toFixed(1)}  (${interferers.length} stations; top: ${top.map(t => `${t.I.call} ${t.I.freq} ${t.I.country}${t.I.cdbs ? '' : '*'} ${t.v.toFixed(1)}`).join(', ')})`);
  }
  const updated = stations.map(s => {
    const out = { ...s };
    delete out.amNightLimit;
    const key = `${s.Frequency}@${s.latitude.toFixed(4)},${s.longitude.toFixed(4)}`;
    if (s.Format === 'AM' && done.has(key)) out.amNightLimit = done.get(key);
    return out;
  });
  fs.writeFileSync('./js/stations.js', `const stations = ${JSON.stringify(updated, null, 2)};\n`);
  console.log(`\n✓ Night limits for ${done.size} AM frequencies (* = no CDBS antenna record, assumed non-directional)`);
})();
