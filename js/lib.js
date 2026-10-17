//Calculations modeled off of https://github.com/manuelbieh/geolib/blob/master/src/getDistance.ts
const normalizeACosArg = val => {
  if (val > 1) {
    return 1;
  }
  if (val < -1) {
    return -1;
  }
  return val;
};

const earthRadius = 6378137;
const toRad = value => (value * Math.PI) / 180;
const getDistance = (from, to, accuracy = 1) => {
  const fromLat = from.latitude;
  const fromLon = from.longitude;
  const toLat = to.latitude;
  const toLon = to.longitude;

  const distance =
    Math.acos(
      normalizeACosArg(
        Math.sin(toRad(toLat)) * Math.sin(toRad(fromLat)) +
        Math.cos(toRad(toLat)) *
        Math.cos(toRad(fromLat)) *
        Math.cos(toRad(fromLon) - toRad(toLon))
      )
    ) * earthRadius;

  return Math.round(distance / accuracy) * accuracy;
};

/**
 * Umami custom event. No-op when the analytics script is blocked or not yet
 * loaded. Payload is small, non-identifying UI state only — never coordinates.
 */
function track(name, data) {
  if (window.umami && typeof window.umami.track === 'function') {
    window.umami.track(name, data);
  }
}

let geoCoords = null; // last GPS fix, so "Use my location" after a pin needs no new prompt

// Header line for a GPS location; the coordinates re-center the map
function showLocationHeader(coords) {
  const coordsText = `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`;
  setDisplay(`📍 Your location: <a href="#" class="location-link" title="Center the map on your location"
    onclick="focusUserLocation(); return false;">${coordsText}</a>
    <a href="#" class="location-link refresh-link" title="Find my location again"
    onclick="track('find-click'); lookupByLocation(); return false;">↻ Refresh</a>`);
  // Phones swap the big Find button for the Refresh link once located
  document.body.classList.add('located');
  if (typeof refreshMapSize === 'function') refreshMapSize();
}

function lookupByLocation() {
  setDisplay('🔍 Finding your location...');
  setResults('<div style="text-align: center; color: #999; padding: 2rem;">Loading...</div>');

  // Check if geolocation is available
  if (!navigator.geolocation) {
    track('locate', { result: 'unsupported' });
    showFallbackStations();
    return;
  }

  navigator.geolocation.getCurrentPosition(function({coords}) {
      track('locate', { result: 'ok' });
      geoCoords = coords;
      sortByLocation(coords);
      showLocationHeader(coords);
    },
    (error) => {
      const reasons = { [error.PERMISSION_DENIED]: 'denied', [error.POSITION_UNAVAILABLE]: 'unavailable', [error.TIMEOUT]: 'timeout' };
      track('locate', { result: reasons[error.code] || 'error' });
      let errorMessage = 'Unable to get your location. ';
      switch(error.code) {
        case error.PERMISSION_DENIED:
          errorMessage += 'Showing all stations - click "Find Nearest Stations" to enable location access.';
          break;
        case error.POSITION_UNAVAILABLE:
          errorMessage += 'Showing all stations instead.';
          break;
        case error.TIMEOUT:
          errorMessage += 'Showing all stations instead.';
          break;
        default:
          errorMessage += 'Showing all stations instead.';
      }
      setDisplay(`ℹ️ ${errorMessage}`);
      showFallbackStations();
    });
}

function showFallbackStations() {
  // When location is unavailable, show helpful message and link to full list
  // This ensures crawlers and users without location access still have a path forward

  const html = `
    <div style="padding: 2rem; text-align: center;">
      <p style="color: #666; margin-bottom: 1rem;">
        <strong>Location access is required to find stations near you.</strong>
      </p>
      <p style="color: #666; margin-bottom: 1.5rem;">
        Click the "Find Nearest Stations" button above to enable location access,
        or view all stations by city.
      </p>
      <a href="stations.html" style="
        display: inline-block;
        background: #4F2683;
        color: white;
        padding: 0.75rem 1.5rem;
        border-radius: 4px;
        text-decoration: none;
        font-weight: 600;
      ">View Full Station List</a>
    </div>
  `;

  setResults(html);

  // Update the display message
  setDisplay('ℹ️ Location unavailable. Click "Find Nearest Stations" to enable location access.');
}

function setDisplay(text) {
  document.getElementById('display').innerHTML = text;
}
function setResults(text) {
  const stationList = document.getElementById('station-list');
  if (stationList) {
    stationList.innerHTML = text;
  } else {
    // Fallback for compatibility
    document.getElementById('results').innerHTML = text;
  }
}

/**
 * Convert meters to miles and round to 2 decimals
 */
function metersToMiles(meters) {
  return Math.round(meters / 1609.344 * 100) / 100;
}

/**
 * Convert meters to kilometers
 */
function metersToKm(meters) {
  return meters / 1000;
}

/**
 * FCC F(50,50) FM propagation curve — predicted field strength in dBu for
 * 1 kW ERP. Rows = distance (km), columns = antenna HAAT (m). This is the
 * same curve family the FCC uses to compute station coverage contours
 * (47 CFR 73.333 Figure 1); values digitized from the FCC's TVFMFS code.
 * Beyond-horizon rolloff is baked into the table.
 */
const F5050_DIST_KM = [1.6, 3.2, 4.8, 6.4, 8, 16.1, 32.2, 48.3, 64.4, 80.5, 96.6, 112.7, 128.7, 144.8,
  160.9, 177, 193.1, 209.2, 225.3, 241.4, 257.5, 273.6, 289.7, 305.8, 321.9];
const F5050_HAAT_M = [30.5, 61, 121.9, 182.9, 243.8, 304.8, 381, 457.2, 533.4, 609.6, 914.4, 1219.2, 1524];
const F5050_DBU = [
  [92, 98, 100.6, 101.5, 101.9, 102, 102.1, 102.2, 102.3, 102.4, 102.5, 102.5, 102.5],
  [79.7, 85.9, 91, 93.4, 94.6, 95, 95.6, 95.9, 96, 96.1, 96.3, 96.5, 96.5],
  [72.7, 79, 84.8, 87.8, 89.4, 90.4, 91.2, 91.8, 92, 92.2, 92.5, 92.5, 92.5],
  [67.8, 73.8, 80, 83.3, 85.4, 86.8, 87.7, 88.3, 88.9, 89.2, 89.9, 90.1, 90.2],
  [64, 70, 76, 79.6, 82, 83.7, 85, 85.8, 86.3, 86.7, 87.6, 88, 88.1],
  [52, 58, 64, 67.6, 70, 72, 73.9, 75.4, 76.7, 77.9, 80.2, 81.3, 81.9],
  [39.4, 45.5, 51.5, 55, 57.6, 59.6, 61.7, 63.3, 64.9, 66.2, 70, 72.4, 74.2],
  [31, 37, 43, 46.7, 49, 51, 53.2, 55.1, 57, 58.5, 62.6, 65, 66.5],
  [25.3, 29.5, 35.5, 39, 41.5, 43.6, 45.9, 47.9, 50, 51.5, 55.4, 57.8, 59.6],
  [20.3, 23.5, 28.8, 32, 34.4, 36.7, 39.1, 41.5, 43.5, 45, 48.9, 51.2, 53],
  [16.2, 18.1, 22, 25.3, 27.7, 29.9, 32, 34.4, 36.7, 38.2, 42.5, 44.9, 46.4],
  [12.8, 14.5, 17.1, 19.8, 22, 23.9, 26, 28.3, 30.7, 32.4, 36.9, 39.1, 40.8],
  [9.8, 11, 13.4, 15.2, 17, 18.8, 21, 23.2, 25.2, 27, 31, 33.2, 35],
  [6.9, 8.2, 10.2, 11.8, 13.1, 14.7, 16.8, 18.8, 20.4, 22, 25.7, 28.1, 30],
  [4, 5.5, 7.4, 8.9, 10.1, 11.5, 13.1, 14.9, 16, 17.3, 21, 23.5, 25.5],
  [1.5, 2.9, 4.8, 6, 7.2, 8.4, 9.9, 11.1, 12.5, 13.7, 17.1, 19.8, 21.8],
  [-1.1, .3, 2.2, 3.7, 4.8, 5.7, 7, 8, 9.1, 10.1, 13.6, 16.1, 18.3],
  [-3.6, -2.2, -.3, 1, 2, 3, 4.1, 5.2, 6.2, 7.1, 10.3, 13, 15],
  [-5.8, -4.8, -3, -1.4, -.3, .6, 1.7, 2.7, 3.8, 4.6, 7.8, 10.4, 12.4],
  [-8.1, -7, -5.2, -3.9, -2.7, -1.8, -.7, .2, 1.1, 2, 5.1, 8, 10],
  [-10.6, -9.4, -7.6, -6.1, -5.1, -4.2, -3.2, -2.2, -1.3, -.4, 2.8, 5.5, 7.7],
  [-13, -11.7, -10, -8.7, -7.6, -6.6, -5.6, -4.6, -3.6, -2.7, .5, 3.1, 5.1],
  [-15.1, -14, -12.2, -11, -10, -9, -8, -7, -6.1, -5.1, -2.1, .6, 2.8],
  [-17.2, -16.1, -14.6, -13.2, -12.1, -11.2, -10.2, -9.2, -8.4, -7.6, -4.5, -2, .2],
  [-19.2, -18.3, -16.9, -15.6, -14.6, -13.6, -12.5, -11.6, -10.6, -10, -6.8, -4.1, -2]
];

/**
 * FM predicted field strength in dBu at a distance, per the FCC F(50,50)
 * curves (bilinear interpolation in log distance / log height).
 *
 * @param {number} erpKw - Effective radiated power in kW
 * @param {number} haatM - Antenna height above average terrain in meters
 * @param {number} distanceKm - Distance from tower in km
 * @returns {number} Field strength in dBu
 */
function fmFieldStrengthDbu(erpKw, haatM, distanceKm) {
  // 47 CFR 73.313(e): HAAT below 30 m uses the 30 m curve
  const h = Math.min(Math.max(haatM || 100, 30.5), 1524);
  const d = Math.min(Math.max(distanceKm, 1.6), 321.9);

  const seg = (x, xs) => {
    let i = 0;
    while (i < xs.length - 2 && xs[i + 1] < x) i++;
    return [i, (Math.log(x) - Math.log(xs[i])) / (Math.log(xs[i + 1]) - Math.log(xs[i]))];
  };
  const [i, td] = seg(d, F5050_DIST_KM);
  const [j, th] = seg(h, F5050_HAAT_M);
  const nearRow = F5050_DBU[i][j] * (1 - th) + F5050_DBU[i][j + 1] * th;
  const farRow = F5050_DBU[i + 1][j] * (1 - th) + F5050_DBU[i + 1][j + 1] * th;
  return nearRow * (1 - td) + farRow * td + 10 * Math.log10(erpKw);
}

// Soil conductivity (mS/m) when no M3 grid is loaded or a point falls
// outside it: the Great Plains value from the FCC M3 map
const DEFAULT_CONDUCTIVITY = 15;

/**
 * AM daytime groundwave field strength in mV/m over uniform ground
 * (Norton/van der Pol flat-earth model — the physics behind the FCC 73.184
 * graphs). amPathFieldMvm handles paths that cross different soils.
 *
 * @param {number} e1km - Unattenuated field at 1 km in mV/m (from amFieldAt1Km)
 * @param {number} freqKhz - Frequency in kHz
 * @param {number} distanceKm - Distance from tower in km
 * @param {number} sigmaMSm - Ground conductivity in mS/m
 * @returns {number} Field strength in mV/m
 */
function amFieldStrengthMvm(e1km, freqKhz, distanceKm, sigmaMSm = DEFAULT_CONDUCTIVITY) {
  const d = Math.max(distanceKm, 0.5);
  const inverseDistance = e1km / d; // mV/m
  const fMhz = freqKhz / 1000;
  const p = 0.582 * fMhz * fMhz * d / sigmaMSm; // Norton "numerical distance"
  const groundLoss = (2 + 0.3 * p) / (2 + p + 0.6 * p * p);
  const curvatureLoss = Math.exp(-AM_CURVATURE.alpha * Math.pow(fMhz, AM_CURVATURE.beta) * d);
  return inverseDistance * groundLoss * curvatureLoss;
}

// Extra attenuation from the earth's curvature, which the flat-earth Norton
// formula leaves out (the FCC's 73.184 curves include it): exp(-alpha·f^beta·d),
// f in MHz, d in km. Fitted to the FCC's daytime 0.5 and 2 mV/m groundwave
// contours (12 bearings each, M3 ground, licensed antenna data) for WEBC 560,
// KTLK 1130, WJON 1240, KFYR 550, KFGO 790 and WNAX 570, then checked on
// KRVN 880, KLIN 1400 and WOW 590, which the fit never saw: median contour
// error 3.3%, 90th percentile 7% (was 6% / 22% without this term).
const AM_CURVATURE = { alpha: 0.0021, beta: 1.5 };

// Decoded FCC M3 grid (js/conductivity.js, built by scripts/build-conductivity.js),
// or null when the page doesn't load one
let m3Grid;
function getM3Grid() {
  if (m3Grid !== undefined) return m3Grid;
  if (typeof M3_CONDUCTIVITY === 'undefined') return (m3Grid = null);
  const g = M3_CONDUCTIVITY;
  const cells = new Uint8Array(g.rows * g.cols);
  g.rowData.forEach((row, r) => {
    let c = r * g.cols;
    for (const [, letter, run] of row.matchAll(/([A-Z])([0-9a-z]+)/g)) {
      cells.fill(letter.charCodeAt(0) - 65, c, c + parseInt(run, 36));
      c += parseInt(run, 36);
    }
  });
  return (m3Grid = { ...g, cells });
}

/**
 * Ground conductivity (mS/m) at a point from the FCC M3 map, or null where
 * the map has no value (outside the grid, or a non-conductivity code).
 */
function conductivityAt(lat, lon) {
  const g = getM3Grid();
  if (!g) return null;
  const r = Math.floor((lat - g.south) / g.step);
  const c = Math.floor((lon - g.west) / g.step);
  if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return null;
  return g.values[g.cells[r * g.cols + c]] || null;
}

/** Initial great-circle bearing in degrees (0 = north) from point 1 to point 2. */
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad)
    - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Point reached going `km` along a great circle from (lat, lon) at `bearing` degrees. */
function destinationPoint(lat, lon, bearing, km) {
  const rad = Math.PI / 180;
  const d = km / 6371;
  const lat1 = lat * rad, b = bearing * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon * rad + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: lat2 / rad, longitude: lon2 / rad };
}

// Kirke equivalent-distance method for groundwave over mixed ground, the
// FCC's prescribed method for nonuniform paths (47 CFR 73.183(c)): walk out
// from the tower; on entering ground of a new conductivity, jump to the
// distance on that ground's curve that gives the field already reached, and
// continue from there. Conductivity is sampled every AM_PATH_STEP_KM.
const AM_PATH_STEP_KM = 2;

// Distance (km) over uniform ground `sigma` at which the field equals `fieldMvm`
function amEquivalentDistanceKm(e1km, freqKhz, fieldMvm, sigma) {
  let lo = 0.5, hi = 20000;
  if (amFieldStrengthMvm(e1km, freqKhz, lo, sigma) <= fieldMvm) return lo;
  for (let i = 0; i < 50 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (amFieldStrengthMvm(e1km, freqKhz, mid, sigma) > fieldMvm) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Walk an AM groundwave path out from a tower along one bearing, calling
 * visit(distanceKm, fieldMvm) after each step until it returns false or
 * maxKm is reached. Where the M3 map has no value the previous ground
 * carries on (and uniform DEFAULT_CONDUCTIVITY is used if there is none at all).
 */
function walkAmPath(e1km, freqKhz, lat, lon, bearing, maxKm, visit) {
  let sigma = conductivityAt(lat, lon) || DEFAULT_CONDUCTIVITY;
  let equivalentKm = 0; // distance along the current ground's uniform curve
  for (let km = AM_PATH_STEP_KM; km <= maxKm + 1e-9; km += AM_PATH_STEP_KM) {
    // Ground under the middle of this step
    const mid = destinationPoint(lat, lon, bearing, km - AM_PATH_STEP_KM / 2);
    const next = conductivityAt(mid.latitude, mid.longitude) || sigma;
    if (next !== sigma) {
      if (equivalentKm > 0) {
        const field = amFieldStrengthMvm(e1km, freqKhz, equivalentKm, sigma);
        equivalentKm = amEquivalentDistanceKm(e1km, freqKhz, field, next);
      }
      sigma = next;
    }
    equivalentKm += AM_PATH_STEP_KM;
    if (visit(km, amFieldStrengthMvm(e1km, freqKhz, equivalentKm, sigma)) === false) return;
  }
}

/**
 * AM groundwave field (mV/m) at a distance along a bearing from the tower,
 * over the actual mix of soils on the FCC M3 map. Without a grid this is
 * the uniform-ground amFieldStrengthMvm.
 */
function amPathFieldMvm(e1km, freqKhz, lat, lon, bearing, distanceKm) {
  if (!getM3Grid() || bearing == null) return amFieldStrengthMvm(e1km, freqKhz, distanceKm);
  const whole = Math.floor(distanceKm / AM_PATH_STEP_KM) * AM_PATH_STEP_KM;
  if (whole < AM_PATH_STEP_KM) {
    return amFieldStrengthMvm(e1km, freqKhz, distanceKm, conductivityAt(lat, lon) || DEFAULT_CONDUCTIVITY);
  }
  let field = null, fieldNext = null;
  walkAmPath(e1km, freqKhz, lat, lon, bearing, whole + AM_PATH_STEP_KM, (km, f) => {
    if (km <= whole + 1e-9) field = f; else { fieldNext = f; return false; }
  });
  // Interpolate (in dB) between the two steps around distanceKm
  const t = (distanceKm - whole) / AM_PATH_STEP_KM;
  return Math.pow(10, (Math.log10(field) * (1 - t) + Math.log10(fieldNext) * t));
}

/**
 * Is the sun down at this location right now? AM stations must switch to
 * their (often much lower) licensed nighttime power from local sunset to
 * sunrise. NOAA solar position algorithm.
 */
function isNightAt(latitude, longitude, date = new Date()) {
  const rad = Math.PI / 180;
  const dayOfYear = (date - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000;
  const hourUtc = date.getUTCHours() + date.getUTCMinutes() / 60;
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (hourUtc - 12) / 24);
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const equationOfTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)); // minutes
  const trueSolarTime = (hourUtc * 60 + equationOfTime + 4 * longitude + 1440) % 1440;
  const hourAngle = (trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180) * rad;
  const cosZenith = Math.sin(latitude * rad) * Math.sin(declination)
    + Math.cos(latitude * rad) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.acos(Math.max(-1, Math.min(1, cosZenith))) > 90.833 * rad;
}

/**
 * Listenability tier floors, chosen so the same score means the same
 * real-world reception on a car radio in either band:
 *   score 4+ Excellent, 3 Good, 2 Fair, 1 Weak-but-listenable, <1 fringe/static.
 * FM floors are dBu. The FCC's 60 dBu service contour (47 CFR 73.215) was
 * defined for 1950s home sets with indoor antennas; a car radio with a whip
 * antenna on flat Plains terrain is full-quieting around 50 dBu and gives
 * clean, occasionally-fuzzy audio down to about 40, so the floors sit 10 dB
 * below the FCC's 50/60/70 planning values.
 * AM floors are dB(mV/m) for 0.15 / 0.5 / 2 / 5 mV/m (47 CFR 73.24/73.182).
 */
const SIGNAL_TIER_FLOORS = {
  FM: [30, 40, 50, 60],
  AM: [-16.5, -6, 6, 14]
};

/**
 * After sunset, AM reception is limited by skywave interference from distant
 * stations on the same and adjacent channels, not by the groundwave fading
 * into noise. scripts/build-am-night-limits.js computes each station's night
 * limit per 5° radial (amNightLimit, mV/m) with the FCC's NIF method — RSS of
 * every interferer's skywave times the protection ratio, 47 CFR 73.182/73.190
 * — using typical (50%) skywave; at night the Fair floor sits on that limit
 * and the other tiers keep their usual spacing above and below it.
 * Without computed limits, the fallback is the FCC's Class B night protection
 * level, 2.0 mV/m (73.182(a)(2)) versus 0.5 mV/m by day. Class A night
 * service is protected by skywave, so its floors stay put.
 */
const AM_NIGHT_FLOOR_SHIFT_DB = 20 * Math.log10(2.0 / 0.5);
const AM_DAY_FAIR_MVM = 0.5;

function amFloorShiftDb(station, night, bearing = null) {
  if (!night || station.amClass === 'A') return 0;
  const limits = station.amNightLimit;
  if (Array.isArray(limits) && limits.length) {
    let limit;
    if (bearing == null) limit = Math.max(...limits);
    else {
      const pos = ((bearing % 360) + 360) % 360 / (360 / limits.length);
      const i = Math.floor(pos) % limits.length, t = pos - Math.floor(pos);
      limit = limits[i] * (1 - t) + limits[(i + 1) % limits.length] * t;
    }
    return Math.max(0, 20 * Math.log10(limit / AM_DAY_FAIR_MVM));
  }
  return AM_NIGHT_FLOOR_SHIFT_DB;
}

/**
 * Sort key for the "Sounds best" ranking. Signal strength alone is not
 * what the listener hears: past the Excellent floor extra field strength
 * makes no audible difference, and at equal strength FM sounds better than
 * AM (15 kHz audio vs 5 kHz, and no static from power lines, ignition, or
 * lightning). So the rank saturates at Excellent for both bands, and FM
 * earns a one-tier fidelity bonus once it is at least Fair (fading in
 * across the Weak tier, so a fuzzy FM never outranks a clean AM).
 * Net effect: a Good FM outranks a strong local AM; a Weak FM does not.
 *
 * @param {object} station - Station record (Format)
 * @param {number} score - Cross-band tier score from estimateSignal
 * @returns {number} Sort key, higher = better listening
 */
function listeningRank(station, score) {
  if (score <= -50) return score; // off air / unknown
  const saturated = Math.min(score, 4);
  const fmBonus = station.Format === 'FM' ? Math.min(Math.max(score - 1, 0), 1) : 0;
  return saturated + fmBonus;
}

/**
 * Describe an AM station's nighttime behavior so users searching in the
 * afternoon know what to expect for an evening game — not just what the
 * signal is right now. Returns null for stations that don't change at night.
 * Keep in sync with the copies in stations.html and
 * scripts/generate-station-table.js.
 *
 * @param {object} station - Station record
 * @returns {object|null} { symbol, title } or null
 */
function nightBehavior(station) {
  if (station.Format !== 'AM' || station.powerNight == null || station.powerNight >= station.power) {
    return null;
  }
  if (station.powerNight <= 0) {
    return {
      symbol: '☀️',
      title: 'Daytime-only AM station — off the air from sunset to sunrise, so not available during night games'
    };
  }
  const fmt = kw => kw >= 1 ? `${kw} kW` : `${Math.round(kw * 1000)} watts`;
  return {
    symbol: '🌙',
    title: `Runs reduced power after sunset (${fmt(station.power)} day → ${fmt(station.powerNight)} night) — expect a weaker signal during night games`
  };
}

/**
 * Estimate signal at the listener's location for one station.
 *
 * @param {object} station - Station record (power, haat, powerNight, Format, Frequency, coords)
 * @param {number} distanceMeters - Distance from listener to tower
 * @returns {object} { strength, rank, category } - strength is a cross-band
 *   comparable signal score (drives the bars), rank is the sort key from
 *   listeningRank (adds the FM fidelity preference), category holds the
 *   display info (bars, color, description)
 */
function estimateSignal(station, distanceMeters, point = null) {
  if (!station.power || !distanceMeters || distanceMeters <= 0) {
    return { strength: -99, rank: -99, category: getSignalCategory(-99) };
  }

  // AM depends on the ground along the path, so it needs the direction too
  const bearing = point
    ? bearingDegrees(station.latitude, station.longitude, point.latitude, point.longitude)
    : null;
  const at = signalScoreAt(station, metersToKm(distanceMeters), bearing);
  if (!at) {
    // Daytime-only license: the station signs off at sunset
    return {
      strength: -99,
      rank: -99,
      category: { label: 'Off air', emoji: '🌙', bars: '▱▱▱▱', color: '#999',
        description: 'Daytime-only AM station — off the air from sunset to sunrise' }
    };
  }

  const category = getSignalCategory(at.score, at.nightNote);
  return { strength: at.score, rank: listeningRank(station, at.score), category: category };
}

// The Time control: 'day' or 'night' previews AM reception for that time of
// day (checking a night game in the afternoon); null follows the real sun.
let timeOfDayOverride = null;

/** Whether AM stations at this spot are on night operation, honoring the Time control. */
function isNightForAm(latitude, longitude) {
  return timeOfDayOverride ? timeOfDayOverride === 'night' : isNightAt(latitude, longitude);
}

/**
 * An AM station's operation right now: after local sunset at the tower its
 * licensed nighttime power and antenna pattern, else daytime. Null for a
 * daytimer at night.
 */
function amPowerNow(station) {
  if (!isNightForAm(station.latitude, station.longitude)) {
    return { night: false, power: station.power, nightNote: '' };
  }
  const reduced = station.powerNight != null && station.powerNight < station.power;
  const power = reduced ? station.powerNight : station.power;
  if (power <= 0) return null;
  return {
    night: true, power,
    nightNote: (reduced ? ` (reduced nighttime power: ${power >= 1 ? power + ' kW' : (power * 1000) + ' watts'})` : '')
      + (station.amClass !== 'A' ? ' — after sunset, interference from distant stations limits AM range' : '')
  };
}

/**
 * Unattenuated AM field at 1 km (mV/m) toward a bearing: the station's FCC
 * antenna data when scripts/build-am-patterns.js found it — one value for a
 * non-directional antenna, or 72 values every 5° for a directional array —
 * else a typical 300 mV/m per √kW. With no bearing, a directional pattern's RMS.
 */
function amFieldAt1Km(station, now, bearing) {
  const field = now.night ? station.amFieldNight : station.amFieldDay;
  if (typeof field === 'number') return field;
  if (Array.isArray(field) && field.length) {
    if (bearing == null) return Math.sqrt(field.reduce((s, v) => s + v * v, 0) / field.length);
    const pos = ((bearing % 360) + 360) % 360 / (360 / field.length);
    const i = Math.floor(pos) % field.length, t = pos - Math.floor(pos);
    return field[i] * (1 - t) + field[(i + 1) % field.length] * t;
  }
  return 300 * Math.sqrt(now.power);
}

/**
 * Convert field strength to a tier score: 1.0 at the Weak floor, one unit
 * per tier, linear in dB between floors (comparable across AM and FM).
 * An integer score n sits exactly on floors[n - 1].
 */
function levelToScore(format, level, shiftDb = 0) {
  const floors = (SIGNAL_TIER_FLOORS[format] || SIGNAL_TIER_FLOORS.FM).map(f => f + shiftDb);
  if (level <= floors[0]) return 1 + (level - floors[0]) / (floors[1] - floors[0]);
  if (level >= floors[floors.length - 1]) return 4 + (level - floors[3]) / (floors[3] - floors[2]);
  let k = 0;
  while (k < floors.length - 2 && floors[k + 1] < level) k++;
  return 1 + k + (level - floors[k]) / (floors[k + 1] - floors[k]);
}

/**
 * Tier score for one station at a distance, right now (AM uses night power
 * after local sunset). Used by estimateSignal for the score at the listener.
 *
 * @param {object} station - Station record
 * @param {number} distanceKm - Distance from tower in km
 * @param {number|null} bearing - Degrees from the tower toward the listener
 *   (AM follows the M3 ground along it; FM ignores it)
 * @returns {object|null} { score, nightNote }, or null when the station is off air
 */
function signalScoreAt(station, distanceKm, bearing = null) {
  if (station.Format === 'AM') {
    const now = amPowerNow(station);
    if (!now) return null;
    const e1km = amFieldAt1Km(station, now, bearing);
    const field = amPathFieldMvm(e1km, station.Frequency, station.latitude, station.longitude, bearing, distanceKm);
    return { score: levelToScore('AM', 20 * Math.log10(field), amFloorShiftDb(station, now.night, bearing)), nightNote: now.nightNote };
  }
  const { haat, offsetDb } = fmRadialAt(station, bearing);
  return { score: levelToScore('FM', fmFieldStrengthDbu(station.power, haat, distanceKm) + offsetDb), nightNote: '' };
}

/**
 * FM antenna height (and leftover dB) toward a bearing. scripts/build-fm-radials.js
 * derives a height per 5° radial from the FCC's own service contour, which
 * folds in that direction's terrain and any directional antenna; without
 * that data (or a bearing) it's the single licensed HAAT.
 */
function fmRadialAt(station, bearing) {
  const heights = station.fmHaatRadials;
  if (bearing == null || !Array.isArray(heights) || !heights.length) return { haat: station.haat, offsetDb: 0 };
  const interp = arr => {
    const pos = ((bearing % 360) + 360) % 360 / (360 / arr.length);
    const i = Math.floor(pos) % arr.length, t = pos - Math.floor(pos);
    return arr[i] * (1 - t) + arr[(i + 1) % arr.length] * t;
  };
  return { haat: interp(heights), offsetDb: station.fmOffsetRadials ? interp(station.fmOffsetRadials) : 0 };
}

// How far out to look for a tier edge. FM stops where the F(50,50) table
// ends (nothing is listenable on FM that far). AM has no real limit — a big
// low-frequency signal on good ground holds 0.5 mV/m past 400 km (WNAX's FCC
// contour reaches 388 km) — so this is only a guard against a runaway walk.
const FM_MAX_KM = 321.9;
const AM_MAX_KM = 2000;
const AM_RADIALS = 72;       // every 5 degrees

/**
 * How far out a station holds each target tier score, right now. FM (and AM
 * without an M3 grid) reaches the same distance in every direction; AM with
 * the grid gets one distance per radial, since the ground differs by direction.
 * Field strength falls monotonically with distance along any path, so each
 * tier is crossed once.
 *
 * @param {object} station - Station record
 * @param {number[]} targetScores - Integer tier scores (2 = Fair, 3 = Good, 4 = Excellent)
 * @returns {object|null} { bearings, km } where bearings is null (uniform) or
 *   the radial bearings, and km[i][j] is radial i's reach for targetScores[j];
 *   null when off air or no license data
 */
function coverageReach(station, targetScores) {
  if (!station.power) return null;

  if (station.Format === 'AM' && getM3Grid()) {
    const now = amPowerNow(station);
    if (!now) return null;
    const near = conductivityAt(station.latitude, station.longitude) || DEFAULT_CONDUCTIVITY;
    const bearings = [], km = [];
    for (let i = 0; i < AM_RADIALS; i++) {
      const bearing = i * 360 / AM_RADIALS;
      const shift = amFloorShiftDb(station, now.night, bearing);
      const levels = targetScores.map(s => SIGNAL_TIER_FLOORS.AM[s - 1] + shift);
      const e1km = amFieldAt1Km(station, now, bearing);
      const startDb = 20 * Math.log10(amFieldStrengthMvm(e1km, station.Frequency, 0.5, near));
      const reach = levels.map(level => startDb < level ? 0 : null);
      let prevKm = 0.5, prevDb = startDb;
      walkAmPath(e1km, station.Frequency, station.latitude, station.longitude, bearing, AM_MAX_KM, (d, field) => {
        const db = 20 * Math.log10(field);
        levels.forEach((level, j) => {
          if (reach[j] === null && db < level) reach[j] = prevKm + (d - prevKm) * (prevDb - level) / (prevDb - db);
        });
        prevKm = d; prevDb = db;
        return reach.some(r => r === null);
      });
      bearings.push(bearing);
      km.push(reach.map(r => r === null ? AM_MAX_KM : r));
    }
    return { bearings, km };
  }

  const MIN_KM = 0.5;
  const maxKm = station.Format === 'AM' ? AM_MAX_KM : FM_MAX_KM;
  const radiusKm = (targetScore, bearing) => {
    const atMax = signalScoreAt(station, maxKm, bearing);
    if (!atMax) return null;
    if (atMax.score >= targetScore) return maxKm;
    if (signalScoreAt(station, MIN_KM, bearing).score < targetScore) return 0;
    let lo = MIN_KM, hi = maxKm;
    for (let i = 0; i < 40 && hi - lo > 0.1; i++) {
      const mid = (lo + hi) / 2;
      if (signalScoreAt(station, mid, bearing).score >= targetScore) lo = mid; else hi = mid;
    }
    return lo;
  };
  // FM with FCC per-radial heights: one reach per radial, like AM
  if (station.Format === 'FM' && Array.isArray(station.fmHaatRadials) && station.fmHaatRadials.length) {
    const bearings = station.fmHaatRadials.map((_, i) => i * 360 / station.fmHaatRadials.length);
    return { bearings, km: bearings.map(b => targetScores.map(t => radiusKm(t, b))) };
  }
  const radii = targetScores.map(t => radiusKm(t, null));
  if (radii.some(r => r == null)) return null;
  return { bearings: null, km: [radii] };
}

/**
 * Estimated coverage rings for a station: how far out the signal stays at
 * least Good (score 3) and at least Fair (score 2). Reflects the current
 * time of day for AM, so night rings shrink after sunset.
 *
 * @param {object} station - Station record
 * @returns {object|null} { goodMeters, fairMeters, goodMinMeters, fairMinMeters,
 *   goodShape, fairShape } — the max/min reach over all directions, and for
 *   AM over mixed ground the ring outlines as [lat, lng] lists (null for a
 *   plain circle); null when off air / no license data
 */
function coverageRadii(station) {
  const reach = coverageReach(station, [3, 2]);
  if (!reach) return null;
  const meters = j => reach.km.map(r => r[j] * 1000);
  const shape = j => reach.bearings && reach.bearings.map((b, i) => {
    const p = destinationPoint(station.latitude, station.longitude, b, reach.km[i][j]);
    return [p.latitude, p.longitude];
  });
  return {
    goodMeters: Math.max(...meters(0)), fairMeters: Math.max(...meters(1)),
    goodMinMeters: Math.min(...meters(0)), fairMinMeters: Math.min(...meters(1)),
    goodShape: shape(0), fairShape: shape(1)
  };
}

/**
 * Get signal strength display category from a tier score.
 *
 * @param {number} score - Cross-band tier score from estimateSignal
 * @param {string} nightNote - Optional note appended to the description
 * @returns {object} Category info with label, emoji, bars, color, description
 */
function getSignalCategory(score, nightNote = '') {
  let category;
  if (score >= 4) {
    category = { label: 'Excellent', emoji: '📶', bars: '▰▰▰▰', color: '#00aa00', description: 'Excellent — strong local-grade signal' };
  } else if (score >= 3) {
    category = { label: 'Good', emoji: '📡', bars: '▰▰▰▱', color: '#4CAF50', description: 'Good — solid reception' };
  } else if (score >= 2) {
    category = { label: 'Fair', emoji: '📻', bars: '▰▰▱▱', color: '#FFA500', description: 'Fair — fine in a car, some noise possible' };
  } else if (score >= 1) {
    category = { label: 'Weak', emoji: '📉', bars: '▰▱▱▱', color: '#ff6b6b', description: 'Weak — listenable but noisy' };
  } else {
    category = { label: 'Fringe', emoji: '⚠️', bars: '▱▱▱▱', color: '#999', description: 'Fringe — likely static' };
  }
  category.description += nightNote;
  return category;
}

/**
 {
     "City": "Alliance",
     "State": "NE",
     lat: 42.09302,
     lng: -102.8702,
     "CallSign": "KCOW",
     "Format": "AM",
     "Frequency": 1400,
     "Sport": "Football",
     "Year": 2019
   }
 */
function sortByLocation(point, sortBy = 'signal') {
  // Calculate distance and signal strength for each station
  const stationsWithData = stations.map(station => {
    const distanceMeters = getDistance(point, station);
    const distanceMiles = metersToMiles(distanceMeters);

    const signal = estimateSignal(station, distanceMeters, point);

    return {
      ...station,
      distance: distanceMiles,
      distanceMeters: distanceMeters,
      signalStrength: signal.strength,
      signalRank: signal.rank,
      signalCategory: signal.category
    };
  });

  // Filter to stations within reasonable range
  const filtered = stationsWithData.filter(it => it.distance < 150);
  const results = filtered.length > 0 ? filtered : stationsWithData.slice(0, 15);

  // Sort by distance or predicted listening quality
  if (sortBy === 'signal') {
    // Sort by listening rank (signal + FM fidelity bonus), then by distance
    results.sort((a, b) => (b.signalRank - a.signalRank) || (b.Format.localeCompare(a.Format)) || (a.distance - b.distance));
  } else {
    // Sort by distance (nearest first), then by format (FM before AM)
    results.sort((a, b) => (a.distance - b.distance) || (b.Format.localeCompare(a.Format)));
  }

  // Take top 15
  const top15 = results.slice(0, 15);

  // Generate HTML with signal indicators
  const html = top15.map(station => {
    const signalIndicator = station.signalStrength > 0
      ? `<span style="color: ${station.signalCategory.color}; font-size: 0.9em;" title="${station.signalCategory.description}">
           ${station.signalCategory.bars}
         </span>`
      : '';

    const powerInfo = station.power
      ? `<span style="color: #666; font-size: 0.85em;">${station.power} kW</span>`
      : '';

    return `
      <div style="padding: 0.5rem 0; border-bottom: 1px solid #eee;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="flex: 1;">
            <strong>${station.Frequency}${station.Format}</strong>
            ${station.CallSign} - ${station.City}, ${station.State}
            ${powerInfo}
          </div>
          <div style="text-align: right; margin-left: 1rem;">
            ${signalIndicator}
            <div style="font-size: 0.9em; color: #666;">${station.distance} mi</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  setResults(html);
}
