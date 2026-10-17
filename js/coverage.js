// Network-wide coverage map: draws every station's estimated Excellent /
// Good / Fair reach as one Leaflet tile layer, like a carrier coverage map.
// Each spot takes the best tier of any station that reaches it, so the
// picture answers "where can Vikings fans hear the game, and how clearly"
// rather than "which station".
//
// Field strength falls monotonically with distance along any path, so each
// station's tier regions are nested shapes: circles for FM, and for AM an
// outline per tier from coverageReach (reach along each radial over the M3
// ground). The outlines are filled as anti-aliased vector paths in every
// tile at the current zoom, so edges stay smooth however far in you zoom.

let coverageMapOverlay = null; // the L.GridLayer while the map is shown
let coverageMapLegend = null;  // L.control legend while the map is shown
let coverageBand = 'all';      // 'all' | 'FM' | 'AM' — which band(s) to paint
const coverageShapeCache = {}; // key: sport + band + day/night → shapes from buildCoverageShapes

const KM_PER_DEG_LAT = 111.2;
const COVERAGE_OUTLINE_POINTS = 360; // vertices per outline (every 1°)

// Tier fills, matching the signal bars and the per-station rings. Stronger
// tiers are a touch more solid.
const COVERAGE_TIERS = [
  { score: 2, rgba: [255, 165, 0, 80], label: 'Fair' },       // orange
  { score: 3, rgba: [120, 200, 110, 115], label: 'Good' },    // light green
  { score: 4, rgba: [0, 110, 0, 165], label: 'Excellent' }    // deep green
];

// Outline of every station's reach for each tier, in Web Mercator world
// pixels at zoom 0 (multiply by 2^zoom for any other zoom). Returns
// { tiers: [[{ pts, minX, minY, maxX, maxY }]] (one list per tier), bounds }.
function buildCoverageShapes(stationList) {
  // Distinct towers/frequencies only: the same frequency listed under two
  // sports paints the same shape twice
  const seen = new Set();
  const tierScores = COVERAGE_TIERS.map(t => t.score);
  const tiers = COVERAGE_TIERS.map(() => []);
  let bounds = null;
  stationList.forEach(station => {
    const key = `${station.Frequency}${station.Format}@${station.latitude},${station.longitude}`;
    if (seen.has(key) || !station.power) return;
    seen.add(key);
    const reach = coverageReach(station, tierScores);
    if (!reach) return;
    COVERAGE_TIERS.forEach((tier, j) => {
      const radial = reach.km.map(r => r[j]);
      if (!Math.max(...radial)) return;
      const pts = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < COVERAGE_OUTLINE_POINTS; k++) {
        const bearing = k * 360 / COVERAGE_OUTLINE_POINTS;
        // Reach at this bearing: interpolated between radials (AM), or the one radius
        let km = radial[0];
        if (radial.length > 1) {
          const pos = bearing / (360 / radial.length);
          const i = Math.floor(pos) % radial.length, t = pos - Math.floor(pos);
          km = radial[i] * (1 - t) + radial[(i + 1) % radial.length] * t;
        }
        const p = destinationPoint(station.latitude, station.longitude, bearing, km);
        const xy = L.CRS.EPSG3857.latLngToPoint(L.latLng(p.latitude, p.longitude), 0);
        pts.push(xy.x, xy.y);
        minX = Math.min(minX, xy.x); maxX = Math.max(maxX, xy.x);
        minY = Math.min(minY, xy.y); maxY = Math.max(maxY, xy.y);
        if (j === 0) bounds = bounds ? bounds.extend([p.latitude, p.longitude]) : L.latLngBounds([p.latitude, p.longitude], [p.latitude, p.longitude]);
      }
      tiers[j].push({ pts, minX, minY, maxX, maxY });
    });
  });
  return { tiers, bounds };
}

// Tile layer that fills the tier outlines per tile. Each tier is drawn as a
// union mask (so overlapping stations don't double-darken), then the masks
// are layered so a stronger tier covers a weaker one, blending only along
// the anti-aliased edges.
const CoverageLayer = L.GridLayer.extend({
  initialize(shapes, options) {
    this.shapes = shapes;
    L.GridLayer.prototype.initialize.call(this, options);
  },

  createTile(coords) {
    const size = this.getTileSize();
    const tile = document.createElement('canvas');
    tile.width = size.x; tile.height = size.y;
    const scale = Math.pow(2, coords.z);
    const ox = coords.x * size.x, oy = coords.y * size.y; // tile origin in world pixels at this zoom
    const x0 = ox / scale, y0 = oy / scale, x1 = (ox + size.x) / scale, y1 = (oy + size.y) / scale;

    const mask = document.createElement('canvas');
    mask.width = size.x; mask.height = size.y;
    const mctx = mask.getContext('2d', { willReadFrequently: true });
    const masks = this.shapes.tiers.map(shapes => {
      const hits = shapes.filter(s => s.maxX >= x0 && s.minX <= x1 && s.maxY >= y0 && s.minY <= y1);
      if (!hits.length) return null;
      mctx.clearRect(0, 0, size.x, size.y);
      mctx.fillStyle = '#000';
      mctx.beginPath();
      hits.forEach(({ pts }) => {
        mctx.moveTo(pts[0] * scale - ox, pts[1] * scale - oy);
        for (let i = 2; i < pts.length; i += 2) mctx.lineTo(pts[i] * scale - ox, pts[i + 1] * scale - oy);
        mctx.closePath();
      });
      mctx.fill('nonzero'); // nonzero: overlapping outlines union instead of cutting holes
      return mctx.getImageData(0, 0, size.x, size.y).data;
    });
    if (masks.every(m => !m)) return tile;

    const ctx = tile.getContext('2d');
    const image = ctx.createImageData(size.x, size.y);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      let pr = 0, pg = 0, pb = 0, pa = 0; // premultiplied
      for (let t = 0; t < masks.length; t++) {
        if (!masks[t]) continue;
        const cover = masks[t][i + 3] / 255;
        if (!cover) continue;
        const [r, g, b, a] = COVERAGE_TIERS[t].rgba;
        pr += (r * a - pr) * cover; pg += (g * a - pg) * cover; pb += (b * a - pb) * cover; pa += (a - pa) * cover;
      }
      if (pa > 0) { px[i] = pr / pa; px[i + 1] = pg / pa; px[i + 2] = pb / pa; px[i + 3] = pa; }
    }
    ctx.putImageData(image, 0, 0);
    return tile;
  }
});

// Stations to include for the current sport filter (same predicate as the
// markers), narrowed to one band when the FM/AM option is set
function coverageStations() {
  return stations.filter(s =>
    (coverageBand === 'all' || s.Format === coverageBand) && (
      (s.Sport === 'Football' && currentFilters.football) ||
      (s.Sport === 'Volleyball' && currentFilters.volleyball) ||
      (s.Sport === "Men's Basketball" && currentFilters.mensBasketball) ||
      (s.Sport === "Women's Basketball" && currentFilters.womensBasketball)
    )
  );
}

// Whether AM stations are on night power right now (judged at the center of
// the network; sunset sweeps across the state in ~20 minutes)
function coverageIsNight() {
  return isNightForAm(45.8, -96.5);
}

function coverageLegendHtml() {
  const rows = [...COVERAGE_TIERS].reverse().map(t =>
    `<div><span class="coverage-swatch" style="background: rgba(${t.rgba[0]}, ${t.rgba[1]}, ${t.rgba[2]}, ${(t.rgba[3] / 255).toFixed(2)})"></span>${t.label}</div>`
  ).join('');
  const title = coverageBand === 'all' ? 'Estimated reception' : `Estimated ${coverageBand} reception`;
  if (coverageBand === 'FM') return `<strong>${title}</strong>${rows}`; // day/night only matters for AM
  const night = coverageIsNight();
  const noteText = night ? 'AM stations at nighttime power' : 'AM stations at daytime power';
  return `<strong>${title}</strong>${rows}`
    + `<div class="coverage-note" title="${noteText}">${night ? '🌙' : '☀️'}<span class="coverage-note-text"> ${noteText}</span></div>`;
}

// Draw (or redraw) the overlay for the current sport filter and band
function showCoverageMap() {
  if (!map) return;
  const night = coverageIsNight();
  const key = `${currentSport}|${coverageBand}|${night ? 'night' : 'day'}`;
  if (!coverageShapeCache[key]) {
    coverageShapeCache[key] = buildCoverageShapes(coverageStations());
  }
  const shapes = coverageShapeCache[key];

  if (coverageMapOverlay) {
    coverageMapOverlay.shapes = shapes;
    coverageMapOverlay.redraw();
  } else {
    coverageMapOverlay = new CoverageLayer(shapes, { pane: 'overlayPane', interactive: false }).addTo(map);
  }

  if (!coverageMapLegend) {
    coverageMapLegend = L.control({ position: 'bottomleft' });
    coverageMapLegend.onAdd = () => {
      const div = L.DomUtil.create('div', 'coverage-map-legend');
      div.innerHTML = coverageLegendHtml();
      return div;
    };
    coverageMapLegend.addTo(map);
  } else {
    coverageMapLegend.getContainer().innerHTML = coverageLegendHtml();
  }
}

function hideCoverageMap() {
  if (coverageMapOverlay) {
    map.removeLayer(coverageMapOverlay);
    coverageMapOverlay = null;
  }
  if (coverageMapLegend) {
    map.removeControl(coverageMapLegend);
    coverageMapLegend = null;
  }
}

function coverageMapVisible() {
  return coverageMapOverlay !== null;
}

// Band radio handler (All / FM / AM). The outlines for each band are cached
// separately, so flipping between them is quick after the first build.
function setCoverageBand(band) {
  coverageBand = band;
  track('coverage-band', { band: band.toLowerCase() });
  if (coverageMapVisible()) showCoverageMap();
}

// Checkbox handler. Turning it on zooms out to the whole network the first
// time so the user sees the full picture; the coordinates link in the header
// still returns to their located view.
function toggleCoverageMap(on) {
  track('coverage-map', { on: on ? 'on' : 'off' });
  const bandRow = document.getElementById('coverageBand');
  if (bandRow) bandRow.hidden = !on;
  if (!on) {
    hideCoverageMap();
    updateOptionsSummary();
    return;
  }
  showCoverageMap();
  updateOptionsSummary();
  map.closePopup();
  map.fitBounds(L.latLngBounds(stations.map(s => [s.latitude, s.longitude])).pad(0.1));
}
