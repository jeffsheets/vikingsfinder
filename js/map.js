let map;
let markers = [];
let userMarker;
let coverageLayer; // estimated Good/Fair rings for the station whose popup is open
let popupSource = 'marker'; // how the next popup was opened, for analytics: 'marker' | 'list' | 'auto'
let selectedTower = null; // L.LatLng of the station whose popup is open — its list cards are highlighted
let selectedFreq = null;  // '960AM' when one frequency at that tower was picked from the list; null = the whole tower
let popupCloseTimer = null; // pending single-click popup close (cancelled by a double-click)
let homeView = null; // { center, zoom, popupStation } — the auto-zoomed view after a location lookup
// Sport filter is single-select: 'all' or one Sport name. currentFilters is
// derived from it so the marker/list filtering can stay boolean per sport.
let currentSport = 'all';
let currentFilters = {
  football: true,
  volleyball: true,
  mensBasketball: true,
  womensBasketball: true
};
let userLocation = null;
let currentSortBy = 'signal'; // 'signal' (sounds best) or 'distance'
// A spot the user chose on the map (right-click / long-press / pick mode)
// instead of their GPS position. Deliberately never written to the URL or
// sent anywhere: it stays in this tab. null while the list is ranked for the GPS fix.
let pinnedLocation = null;
let pickingSpot = false; // pick mode: the next map tap drops the pin
let pickButton = null;   // the 📌 control's anchor element
let displayBeforePick = null; // header HTML to restore if pick mode is cancelled

// Sport emojis for list cards and map popups (🏀 disambiguated with M/W)
const SPORT_EMOJI = {
  'Football': '🏈',
  'Volleyball': '🏐',
  "Men's Basketball": '🏀<sup>M</sup>',
  "Women's Basketball": '🏀<sup>W</sup>'
};

// Initialize the map centered on the Vikings Radio Network
function initMap() {
  // Popups close on a single map click ourselves (below), so a double-click
  // zoom doesn't close the open station and drop its selection
  map = L.map('map', { closePopupOnClick: false }).setView([45.8, -96.5], 6);

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  // Coverage rings sit under the markers and follow whichever popup is open —
  // marker click, list click, and the auto-opened nearest station all route
  // through popupopen, so this one hook covers every entry point
  coverageLayer = L.layerGroup().addTo(map);

  // The pinned-spot marker draws above popups (popupPane is 700) so a station
  // card opening over the pin never hides where the user tapped
  map.createPane('pinPane').style.zIndex = 750;
  map.on('popupopen', e => {
    const stationList = e.popup._source && e.popup._source.stationData;
    // A list click picks one frequency; a marker (or the auto popup) picks the whole tower
    if (popupSource !== 'list') selectedFreq = null;
    showCoverage(stationsForSelection(stationList || []));
    selectedTower = stationList ? e.popup._source.getLatLng() : null;
    markSelectedStation(popupSource === 'marker');
    if (stationList) {
      const s = stationList[0];
      track('station-popup', { station: `${s.Frequency}${s.Format} ${s.CallSign}`, source: popupSource });
    }
    popupSource = 'marker';
  });
  map.on('popupclose', () => {
    coverageLayer.clearLayers();
    selectedTower = null;
    selectedFreq = null;
    markSelectedStation(false);
  });

  // Add all station markers
  addStationMarkers();

  // Choose a listening spot on the map. Right-click (desktop) and long-press
  // (touch) both arrive as Leaflet's contextmenu event, so neither interferes
  // with drag or pinch-zoom. A plain click only pins while pick mode is on,
  // because click already closes popups and stray taps while panning are common.
  map.on('contextmenu', e => pinSpot(e.latlng, 'press'));
  map.on('click', e => {
    if (pickingSpot) {
      setPickMode(false);
      pinSpot(e.latlng, 'pick');
      return;
    }
    // Close the open popup on a single click only: wait out the double-click
    // window, and let a dblclick (zoom in) cancel it
    clearTimeout(popupCloseTimer);
    popupCloseTimer = setTimeout(() => map.closePopup(), 300);
  });
  map.on('dblclick', () => clearTimeout(popupCloseTimer));
  addPickControl();
  syncOptionsDisclosure();
  updateOptionsSummary();
  addFullscreenControl();
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (pickingSpot) setPickMode(false);
    else if (mapFullscreen) setMapFullscreen(false);
  });
}

// ⛶ button (top-right) that expands the map to fill the screen. Done with a
// fixed-position class rather than the Fullscreen API so it works in iOS Safari.
let mapFullscreen = false;
let fullscreenButton = null;

function addFullscreenControl() {
  const FullscreenControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar fullscreen-control');
      const a = L.DomUtil.create('a', '', div);
      a.href = '#';
      a.setAttribute('role', 'button');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        setMapFullscreen(!mapFullscreen);
      });
      fullscreenButton = a;
      renderFullscreenButton();
      return div;
    }
  });
  new FullscreenControl({ position: 'topright' }).addTo(map);
}

function renderFullscreenButton() {
  const label = mapFullscreen ? 'Exit full-screen map' : 'Full-screen map';
  fullscreenButton.innerHTML = mapFullscreen ? '✕' : '⛶';
  fullscreenButton.title = label;
  fullscreenButton.setAttribute('aria-label', label);
  fullscreenButton.setAttribute('aria-pressed', String(mapFullscreen));
}

function setMapFullscreen(on) {
  if (on === mapFullscreen) return;
  mapFullscreen = on;
  track('map-fullscreen', { on: on ? 'on' : 'off' });
  document.body.classList.toggle('map-fullscreen', on);
  renderFullscreenButton();
  // The container's size changed under Leaflet; recompute, keeping the center
  const center = map.getCenter();
  map.invalidateSize({ animate: false });
  map.setView(center, map.getZoom(), { animate: false });
}

// 📌 button under the zoom control that arms pick mode
function addPickControl() {
  const PickControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar pick-spot-control');
      const a = L.DomUtil.create('a', '', div);
      a.href = '#';
      a.innerHTML = '📌';
      a.title = 'Pick a spot on the map to find stations near it (or right-click / long-press the map)';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', 'Pick a spot on the map to find stations near it');
      a.setAttribute('aria-pressed', 'false');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        setPickMode(!pickingSpot);
      });
      pickButton = a;
      return div;
    }
  });
  new PickControl({ position: 'topleft' }).addTo(map);
}

function setPickMode(on) {
  if (on === pickingSpot) return;
  pickingSpot = on;
  pickButton.setAttribute('aria-pressed', String(on));
  const toggle = on ? 'addClass' : 'removeClass';
  L.DomUtil[toggle](map.getContainer(), 'picking-spot');
  L.DomUtil[toggle](pickButton, 'active');
  if (on) {
    track('pick-spot', { action: 'start' });
    displayBeforePick = document.getElementById('display').innerHTML;
    setDisplay('📌 Tap the map where you want to listen · <a href="#" class="location-link" onclick="setPickMode(false); return false;">Cancel</a>');
  } else if (displayBeforePick != null) {
    setDisplay(displayBeforePick);
    displayBeforePick = null;
  }
}

// Rank the list for a chosen spot and mark it with a draggable pin.
// source: 'press' | 'pick' | 'drag' — analytics gets only this word, never the point
function pinSpot(latlng, source, opts = {}) {
  const point = { latitude: latlng.lat, longitude: latlng.lng };
  track('pin-spot', { source: source });
  sortByLocation(point, false, { pinned: true, keepView: opts.keepView });
  const coordsText = `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
  setDisplay(`📌 Stations near pinned spot: <a href="#" class="location-link" title="Center the map on the pin"
    onclick="focusUserLocation(); return false;">${coordsText}</a>
    · <a href="#" class="location-link" onclick="clearPin(); return false;">Use my location instead</a>`);
}

// Drop the pin and go back to ranking for the GPS position
function clearPin() {
  pinnedLocation = null;
  if (geoCoords) {
    sortByLocation(geoCoords);
    showLocationHeader(geoCoords);
  } else {
    lookupByLocation();
  }
}

// Popup footer explaining the rings: estimated Good / Fair range per distinct
// frequency at this tower. Matches what showCoverage draws.
function coverageFooter(stationList) {
  const seen = new Set();
  const lines = [];
  stationList.forEach(station => {
    const key = `${station.Frequency}${station.Format}`;
    if (seen.has(key)) return;
    seen.add(key);
    const radii = coverageRadii(station);
    if (!radii) return;
    const mi = m => Math.round(metersToMiles(m));
    // AM over mixed ground reaches different distances by direction: show the span
    const span = (min, max) => mi(max) - mi(min) >= Math.max(3, 0.15 * mi(max))
      ? `${mi(min)}–${mi(max)} mi` : `~${mi(max)} mi`;
    lines.push({ key, text: `<span class="coverage-good">good</span> ${span(radii.goodMinMeters, radii.goodMeters)} · `
      + `<span class="coverage-fair">fair</span> ${span(radii.fairMinMeters, radii.fairMeters)}` });
  });
  if (lines.length === 0) return '';
  // Single frequency: one line. Several: label line, then one per frequency.
  const body = lines.length === 1
    ? `Est. range: ${lines[0].text}`
    : `Est. range<br>${lines.map(l => `<strong>${l.key}</strong> ${l.text}`).join('<br>')}`;
  return `<div class="coverage-legend" title="Rings on the map. Estimated from FCC license data; terrain and buildings will vary it">${body}</div>`;
}

// Draw estimated Good (inner) and Fair (outer) rings for each distinct
// frequency at a tower. Colors match the signal bars in the list.
function showCoverage(stationList) {
  coverageLayer.clearLayers();
  const seen = new Set();
  stationList.forEach(station => {
    const key = `${station.Frequency}${station.Format}`;
    if (seen.has(key)) return;
    seen.add(key);
    const radii = coverageRadii(station);
    if (!radii) return; // off air or no license data
    const center = [station.latitude, station.longitude];
    const dash = station.Format === 'AM' ? '6 6' : null;
    // AM over mixed ground draws its true outline; otherwise a circle
    const ring = (shape, radius, style) => (shape
      ? L.polygon(shape, style) : L.circle(center, { radius, ...style })).addTo(coverageLayer);
    ring(radii.fairShape, radii.fairMeters, { color: '#FFA500', weight: 1.5, dashArray: dash,
      fillColor: '#FFA500', fillOpacity: 0.08, interactive: false });
    ring(radii.goodShape, radii.goodMeters, { color: '#4CAF50', weight: 1.5, dashArray: dash,
      fillColor: '#4CAF50', fillOpacity: 0.12, interactive: false });
  });
}

// Create custom icons for different sports
function getStationIcon(sport) {
  const colors = {
    'Football': '#4F2683',
    'Volleyball': '#333333',
    "Men's Basketball": '#D2B48C',
    "Women's Basketball": '#FFB6D9'
  };

  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background: ${colors[sport] || '#666'};
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8]
  });
}

// Add all station markers to the map
function addStationMarkers() {
  // Clear existing markers
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];

  // Get unique stations (combine duplicates at same location)
  const locationMap = new Map();

  stations.forEach(station => {
    const key = `${station.latitude}-${station.longitude}`;
    if (!locationMap.has(key)) {
      locationMap.set(key, []);
    }
    locationMap.get(key).push(station);
  });

  // Add markers for each unique location
  locationMap.forEach(stationList => {
    const firstStation = stationList[0];

    // Check if this station should be shown based on filters
    const shouldShow = stationList.some(s =>
      (s.Sport === 'Football' && currentFilters.football) ||
      (s.Sport === 'Volleyball' && currentFilters.volleyball) ||
      (s.Sport === "Men's Basketball" && currentFilters.mensBasketball) ||
      (s.Sport === "Women's Basketball" && currentFilters.womensBasketball)
    );

    if (!shouldShow) return;

    // Use Vikings purple for all station markers
    const marker = L.marker(
      [firstStation.latitude, firstStation.longitude],
      { icon: getStationIcon('Football') } // Always use Football (red) color
    );

    // Create popup content
    let popupContent = `<div class="station-popup">`;
    popupContent += `<h3>${firstStation.City}, ${firstStation.State || ''}</h3>`;

    // One line per frequency, with the sports it carries as emojis (same
    // forms as the list cards) — a station on all four sports is one line
    const byFreq = new Map();
    stationList.forEach(s => {
      const key = `${s.Frequency}${s.Format}`;
      if (!byFreq.has(key)) byFreq.set(key, { station: s, sports: new Set() });
      byFreq.get(key).sports.add(s.Sport);
    });

    byFreq.forEach(({ station: s, sports }, key) => {
      const emojis = [...sports].map(sport =>
        `<span class="station-sport-emoji" role="img" title="${sport}" aria-label="${sport}">${SPORT_EMOJI[sport] || sport}</span>`).join('');
      const roleTag = s.role === 'secondary'
        ? ` <em class="popup-role" title="Overflow station — only carries a game when two Vikings games are on at the same time">overflow</em>`
        : '';
      const night = nightBehavior(s);
      const nightTag = night ? ` <span class="night-flag" role="img" title="${night.title}" aria-label="${night.title}">${night.symbol}</span>` : '';
      popupContent += `<div class="popup-station" data-freq="${key}"><strong>${key}</strong> ${s.CallSign} ${emojis}${roleTag}${nightTag}</div>`;
    });

    // Range footer is built at open time so AM night-power rings and text
    // reflect the current hour, not the hour the page loaded
    // (the picked frequency, if one was picked from the list, is marked)
    marker.bindPopup(() => {
      const html = selectedFreq
        ? popupContent.replace(`class="popup-station" data-freq="${selectedFreq}"`, `class="popup-station selected" data-freq="${selectedFreq}"`)
        : popupContent;
      return html + coverageFooter(stationsForSelection(stationList)) + `</div>`;
    });
    marker.stationData = stationList;
    marker.addTo(map);
    markers.push(marker);
  });
}

// The selected sport is mirrored into the URL as ?sport=<slug> so a filtered
// view can be shared (e.g. /?sport=football). Slugs are the shareable form;
// the values on the right are the Sport names used in stations.js.
const SPORT_SLUGS = {
  football: 'Football',
  volleyball: 'Volleyball',
  mbb: "Men's Basketball",
  wbb: "Women's Basketball"
};
const SPORT_SLUG_ALIASES = {
  'mens-basketball': 'mbb',
  'womens-basketball': 'wbb',
  basketball: 'mbb'
};

// Read the sport from the current URL; anything unrecognized means 'all'
function sportFromUrl() {
  const raw = (new URLSearchParams(window.location.search).get('sport') || '').toLowerCase();
  const slug = SPORT_SLUG_ALIASES[raw] || raw;
  return SPORT_SLUGS[slug] || 'all';
}

function slugForSport(sport) {
  return Object.keys(SPORT_SLUGS).find(slug => SPORT_SLUGS[slug] === sport) || null;
}

// Write the sport into the URL without reloading; 'all' clears the param
function syncSportToUrl(sport) {
  const url = new URL(window.location.href);
  const slug = slugForSport(sport);
  if (slug) {
    url.searchParams.set('sport', slug);
  } else {
    url.searchParams.delete('sport');
  }
  if (url.href !== window.location.href) {
    history.pushState(null, '', url);
  }
}

// Check the matching radio in the segmented control (used when the sport comes from the URL)
function setSportControl(sport) {
  const input = document.querySelector(`input[name="sport"][value="${sport}"]`);
  if (input) input.checked = true;
}

// Set the sport state without touching the map or list
function setSportState(sport) {
  currentSport = sport;
  const all = sport === 'all';
  currentFilters.football = all || sport === 'Football';
  currentFilters.volleyball = all || sport === 'Volleyball';
  currentFilters.mensBasketball = all || sport === "Men's Basketball";
  currentFilters.womensBasketball = all || sport === "Women's Basketball";
}

// Update filters when the sport segmented control changes (or the URL does).
// updateUrl is false when the change came from the URL itself (load / back button).
function updateSportFilter(sport, updateUrl = true) {
  setSportState(sport);
  if (updateUrl) {
    syncSportToUrl(sport);
    track('sport-filter', { sport: slugForSport(sport) || 'all' });
  }

  // Refresh markers
  addStationMarkers();

  // Redraw the network coverage map for the new sport, if it is showing
  if (coverageMapVisible()) {
    showCoverageMap();
  }

  // Refresh results if we have a location
  if (userLocation) {
    sortByLocation(userLocation);
  }
}

// Switch between sorting by distance and by predicted listening quality
// Phones fold Sort / Time / coverage map into one "Options" row (a
// <details>) whose summary shows the current choices, so the station list
// starts higher; wider screens always show the controls.
const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;

function syncOptionsDisclosure() {
  const details = document.getElementById('moreOptions');
  if (details) details.open = !(phoneQuery && phoneQuery.matches);
}

// The map flexes to fill what the panel above leaves, so tell Leaflet when
// that panel changes height (options folded/unfolded, Find button swapped out)
function refreshMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
document.addEventListener('toggle', e => { if (e.target.id === 'moreOptions') refreshMapSize(); }, true);
if (phoneQuery) {
  if (phoneQuery.addEventListener) phoneQuery.addEventListener('change', syncOptionsDisclosure);
  else if (phoneQuery.addListener) phoneQuery.addListener(syncOptionsDisclosure);
}

function updateOptionsSummary() {
  const el = document.getElementById('optionsSummary');
  if (!el) return;
  const time = { day: '☀️ Day', night: '🌙 Night' }[timeOfDayOverride] || '🕒 Now';
  const parts = [currentSortBy === 'distance' ? '📏 Nearest' : '📶 Sounds best', time];
  if (typeof coverageMapVisible === 'function' && coverageMapVisible()) parts.push('🗺️ Coverage');
  el.textContent = parts.join(' · ');
  // A forced Day/Night is easy to forget once folded away: make it stand out
  el.classList.toggle('changed', !!timeOfDayOverride);
}

// Time control (Now / Day / Night): re-rank and redraw AM for that time of
// day without moving the map, and refresh an open station's rings and ranges
function setTimeOfDay(mode) {
  timeOfDayOverride = mode === 'now' ? null : mode;
  track('time-of-day', { mode: mode });
  updateOptionsSummary();
  if (userLocation) sortByLocation(userLocation, false, { pinned: !!pinnedLocation, keepView: true });
  const popup = map && map._popup;
  if (popup && map.hasLayer(popup) && popup._source && popup._source.stationData) {
    popup.update(); // re-runs the content function, so the range footer follows
    showCoverage(stationsForSelection(popup._source.stationData));
  }
  if (coverageMapVisible()) showCoverageMap();
}

function updateSortBy(mode) {
  currentSortBy = mode;
  track('sort-by', { mode: mode });
  updateOptionsSummary();
  if (userLocation) {
    sortByLocation(userLocation);
  }
}

// opts.pinned: point was chosen on the map rather than from GPS (pin marker,
// pinnedLocation set). opts.keepView: don't re-zoom or auto-open a popup
// (used while dragging the pin).
function sortByLocation(point, isFallback = false, opts = {}) {
  userLocation = point;
  pinnedLocation = opts.pinned ? point : null;

  // Filter stations based on current sport filters
  let filteredStations = stations.filter(station =>
    (station.Sport === 'Football' && currentFilters.football) ||
    (station.Sport === 'Volleyball' && currentFilters.volleyball) ||
    (station.Sport === "Men's Basketball" && currentFilters.mensBasketball) ||
    (station.Sport === "Women's Basketball" && currentFilters.womensBasketball)
  );

  // Calculate distances and signal strength for all filtered stations
  const stationsWithData = filteredStations.map(station => {
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

  // Group stations by unique frequency/callsign/location combination
  const groupedStations = new Map();

  stationsWithData.forEach(station => {
    const key = `${station.CallSign}-${station.Frequency}${station.Format}-${station.City}`;

    if (!groupedStations.has(key)) {
      groupedStations.set(key, {
        CallSign: station.CallSign,
        Frequency: station.Frequency,
        Format: station.Format,
        City: station.City,
        State: station.State,
        latitude: station.latitude,
        longitude: station.longitude,
        distance: station.distance,
        power: station.power,
        powerNight: station.powerNight,
        signalStrength: station.signalStrength,
        signalRank: station.signalRank,
        signalCategory: station.signalCategory,
        role: station.role,
        secondaryOf: station.secondaryOf,
        backups: [],
        sports: []
      });
    }

    groupedStations.get(key).sports.push(station.Sport);
  });

  // Convert to array, then fold overflow stations (role "secondary" with a
  // secondaryOf link, e.g. KCRO 660 → WOW 590) into their primary's card so
  // the market reads as one entry instead of two competing ones
  let results = Array.from(groupedStations.values());
  results = results.filter(entry => {
    if (entry.role !== 'secondary' || !entry.secondaryOf) return true;
    const primary = results.find(p => p.role === 'primary'
      && p.CallSign === entry.secondaryOf && p.City === entry.City);
    if (!primary) return true; // primary filtered out — show the overflow station on its own
    primary.backups.push(entry);
    return false;
  });

  if (currentSortBy === 'signal') {
    // Sort by listening rank (signal tier, saturated at Excellent, plus an
    // FM fidelity bonus — see listeningRank in lib.js), then by distance
    results.sort((a, b) => (b.signalRank - a.signalRank) || (b.Format.localeCompare(a.Format)) || (a.distance - b.distance));
  } else {
    // Sort by distance (nearest first)
    results.sort((a, b) => a.distance - b.distance);
  }

  results = results.slice(0, 15);

  // Contextual legend in the controls panel (stays visible while the list
  // scrolls; tooltips don't exist on mobile) — shown only when a listed
  // station carries a day/night flag, with only the symbols actually shown
  const legendEl = document.getElementById('nightLegend');
  if (legendEl) {
    const flags = results.map(s => nightBehavior(s)).filter(Boolean);
    if (flags.length > 0) {
      const parts = [];
      if (flags.some(f => f.symbol === '☀️')) {
        parts.push('☀️ off air after sunset');
      }
      if (flags.some(f => f.symbol === '🌙')) {
        parts.push('🌙 weaker at night');
      }
      legendEl.innerHTML = parts.join(' &nbsp;·&nbsp; ');
      legendEl.style.display = 'block';
    } else {
      legendEl.style.display = 'none';
    }
  }

  // Update the display with enhanced HTML
  let html = '';
  results.forEach((station, index) => {
    const isNearest = index < 3;
    const uniqueSports = [...new Set(station.sports)];

    // Signal strength indicator (decorative glyphs; the card's aria-label
    // carries the tier in words)
    const signalIndicator = station.signalStrength > 0
      ? `<span class="signal-indicator" style="color: ${station.signalCategory.color};" title="${station.signalCategory.description}" aria-hidden="true">
           ${station.signalCategory.bars}
         </span>`
      : '';

    // Spoken name for the card: emoji, bars and the ↳ overflow line are noise
    // to a screen reader, so say the whole thing in words instead
    const night = nightBehavior(station);
    const ariaParts = [
      `${station.City}, ${station.Frequency} ${station.Format} ${station.CallSign}`,
      uniqueSports.length === Object.keys(SPORT_EMOJI).length ? 'all sports' : uniqueSports.join(' and '),
      station.signalStrength > 0 ? `${station.signalCategory.label} signal` : '',
      `${station.distance} miles`,
      night ? (night.symbol === '☀️' ? 'off air after sunset' : 'weaker at night') : '',
      station.role === 'secondary' ? 'overflow station' : ''
    ].filter(Boolean);

    html += `<div class="station-item ${isNearest ? 'nearest' : ''}" role="button" tabindex="0"
                  data-lat="${station.latitude}" data-lng="${station.longitude}"
                  aria-label="${ariaParts.join(', ')}. Show on map"
                  data-freq="${station.Frequency}${station.Format}"
                  onclick="focusStation(${station.latitude}, ${station.longitude}, '${station.Frequency}${station.Format}')"
                  onkeydown="activateOnKey(event)">`;
    html += `<div class="station-info">`;
    html += `<span class="station-location">${station.City}</span>`;
    html += `<span class="station-freq">${station.Frequency}${station.Format}</span>`;
    html += `<span class="station-call">${station.CallSign}</span>`;
    if (night) {
      html += `<span class="night-flag" title="${night.title}">${night.symbol}</span>`;
    }
    // The primary role is implied by the overflow line below, so only the
    // secondary badge is shown (when an overflow station is listed on its own)
    if (station.role === 'secondary') {
      html += `<span class="station-role secondary" title="Overflow station — only carries a game when two Vikings games are on at the same time">${station.role}</span>`;
    }
    html += `</div>`;

    // Overflow station(s) folded into this card: normally silent on Vikings
    // games, used only when two games overlap
    station.backups.forEach(backup => {
      const backupNight = nightBehavior(backup);
      const backupSports = [...new Set(backup.sports)];
      const backupTitle = `${backup.CallSign} ${backup.Frequency} ${backup.Format} is the overflow station for ${station.CallSign}: `
        + `it carries a Vikings game only when two games are on at the same time (${backupSports.join(', ')}). `
        + `Tune ${station.Frequency} ${station.Format} first.`;
      html += `<div class="station-backup" title="${backupTitle}">`;
      html += `<span class="backup-arrow">↳</span> `;
      html += `<span class="backup-freq">${backup.Frequency}${backup.Format}</span> `;
      html += `<span class="backup-call">${backup.CallSign}</span>`;
      if (backupNight) {
        html += ` <span class="night-flag" title="${backupNight.title}">${backupNight.symbol}</span>`;
      }
      html += ` <span class="backup-note">only when two games</span>`;
      html += `</div>`;
    });

    html += `<div class="station-meta">`;
    html += `<div class="station-sports">`;
    // Show all sports this station broadcasts (🏀 disambiguated with M/W)
    uniqueSports.forEach(sport => {
      html += `<span class="station-sport-emoji" title="${sport}">`;
      html += `${SPORT_EMOJI[sport] || sport}`;
      html += `</span>`;
    });
    html += `</div>`;
    html += `<div class="station-right">`;
    html += signalIndicator;
    html += `<span class="station-distance"><span class="distance-long">${station.distance} miles</span><span class="distance-short">${station.distance}mi</span></span>`;
    html += `</div>`;
    html += `</div>`;

    html += `</div>`;
  });

  setResults(html || '<div style="text-align: center; color: #999;">No stations found</div>');
  markSelectedStation(false);

  // Add or update user location marker
  if (userMarker) {
    map.removeLayer(userMarker);
  }

  if (opts.pinned) {
    // Draggable pin for a chosen spot; dragging re-ranks without moving the map
    userMarker = L.marker([point.latitude, point.longitude], {
      pane: 'pinPane',
      draggable: true,
      autoPan: true,
      title: 'Pinned spot — drag to move',
      icon: L.divIcon({
        className: 'pin-marker',
        html: '<div class="pin-head"></div>',
        iconSize: [30, 30],
        iconAnchor: [15, 29],
        popupAnchor: [0, -26]
      })
    });
    userMarker.on('dragend', () => pinSpot(userMarker.getLatLng(), 'drag', { keepView: true }));
    userMarker.bindPopup('<b>Pinned spot</b><br><small>Drag to move it</small>').addTo(map);
  } else {
  userMarker = L.marker([point.latitude, point.longitude], {
    icon: L.divIcon({
      className: 'user-marker',
      html: `<div style="
        background: #4285F4;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        position: relative;
      ">
        <div style="
          position: absolute;
          top: -4px;
          left: -4px;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          border: 2px solid #4285F4;
          opacity: 0.3;
          background: #4285F4;
        "></div>
      </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    })
  });

  userMarker.bindPopup('<b>Your Location</b>').addTo(map);
  }

  // Center on user location and zoom to show nearest stations
  if (results.length > 0) {
    let zoomLevel;
    let centerPoint;

    if (isFallback) {
      // For fallback location, show the whole network
      // Center on the network and zoom out to show all stations
      centerPoint = [45.8, -96.5]; // Center of the network (MN/ND/SD/IA/WI)
      zoomLevel = 6; // Network-wide view
    } else {
      // Calculate the maximum distance to the nearest 5 stations to adjust zoom
      const maxDistance = Math.max(...results.slice(0, 5).map(s => s.distance));

      // Adjust zoom level based on distance (closer stations = higher zoom)
      zoomLevel = 10; // default
      if (maxDistance < 25) zoomLevel = 11;      // Very close stations
      else if (maxDistance < 50) zoomLevel = 10; // Close stations
      else if (maxDistance < 100) zoomLevel = 9; // Medium distance
      else if (maxDistance < 200) zoomLevel = 8; // Far stations
      else {
        // For very far stations, calculate optimal zoom to fit both user and closest station
        const closestStation = results[0];
        const userLatLng = L.latLng(point.latitude, point.longitude);
        const stationLatLng = L.latLng(closestStation.latitude, closestStation.longitude);

        // Create bounds containing both points
        const bounds = L.latLngBounds([userLatLng, stationLatLng]);

        // Add some padding to the bounds (10% on each side)
        const paddedBounds = bounds.pad(0.1);

        // Calculate zoom level that fits both points
        zoomLevel = map.getBoundsZoom(paddedBounds);

        // Ensure zoom level is within reasonable limits
        zoomLevel = Math.max(4, Math.min(8, zoomLevel));
      }

      centerPoint = [point.latitude, point.longitude];
    }

    // Automatically open popup for closest station (skip for fallback to show more context).
    // Prefer the closest football station when the football filter is on — football is the
    // flagship sport, so a nearby volleyball/basketball-only station shouldn't win the popup.
    const popupStation = isFallback ? null : ((currentFilters.football &&
      results.find(s => s.sports.includes('Football'))) || results[0]);

    // Remember this view so clicking the coordinates in the header can reset to it
    homeView = { center: centerPoint, zoom: zoomLevel, popupStation: popupStation };
    // While the network coverage map is showing, leave the map where it is and
    // don't auto-open a station: the user is looking at the whole network, not
    // their nearest station. The coordinates link still jumps to the home view.
    if (!coverageMapVisible() && !opts.keepView) {
      showHomeView();
    }
  }
}

// Apply the auto-zoomed "home" view: center on the user, zoom to the nearest
// stations, and open the closest station's popup once the map settles
function showHomeView() {
  if (!homeView) return;
  map.closePopup();
  map.setView(homeView.center, homeView.zoom);
  if (homeView.popupStation) {
    const station = homeView.popupStation;
    // Small delay to ensure map has finished moving
    setTimeout(() => {
      popupSource = 'auto';
      openStationPopup(station.latitude, station.longitude);
    }, 500);
  }
}

// Enter / Space on a station card acts like a click (cards are divs with
// role="button", so the browser doesn't do this for us)
function activateOnKey(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.currentTarget.click();
  }
}

// Highlight the list cards for the station whose popup is open (every
// frequency at that tower). scroll: bring the first one into view, for
// selections made on the map.
function markSelectedStation(scroll) {
  let first = null;
  document.querySelectorAll('#station-list .station-item').forEach(card => {
    const on = !!selectedTower && Math.abs(+card.dataset.lat - selectedTower.lat) < 0.001
      && Math.abs(+card.dataset.lng - selectedTower.lng) < 0.001
      && (!selectedFreq || card.dataset.freq === selectedFreq);
    card.classList.toggle('selected', on);
    if (on) card.setAttribute('aria-current', 'true'); else card.removeAttribute('aria-current');
    if (on && !first) first = card;
  });
  if (scroll && first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// The stations at a tower that the current selection covers: just the
// picked frequency after a list click, else all of them
function stationsForSelection(stationList) {
  if (!selectedFreq) return stationList;
  const picked = stationList.filter(s => `${s.Frequency}${s.Format}` === selectedFreq);
  return picked.length ? picked : stationList;
}

// Focus on a specific station when clicked in the list. freq ('960AM')
// picks that one frequency when several share the tower.
function focusStation(lat, lng, freq = null) {
  const marker = markers.find(m => {
    const p = m.getLatLng();
    return Math.abs(p.lat - lat) < 0.001 && Math.abs(p.lng - lng) < 0.001;
  });
  // Close whatever popup is open first (its popupclose resets the pick), so
  // the popup, rings and highlight all switch to the new one
  map.closePopup();
  selectedFreq = freq;

  // Zoom to fit the station's Fair ring (and the user, if located) so the
  // estimated reach is visible; fixed zoom if there is nothing to draw. Never
  // zoom out past the state-wide view (7) — a 50 kW AM's Fair ring spans four
  // states and fitting it would lose all local context
  const fairMeters = marker ? Math.max(0, ...stationsForSelection(marker.stationData)
    .map(s => coverageRadii(s)).filter(Boolean).map(r => r.fairMeters)) : 0;
  if (fairMeters > 0) {
    const bounds = L.latLng(lat, lng).toBounds(fairMeters * 2);
    if (userLocation) bounds.extend([userLocation.latitude, userLocation.longitude]);
    const zoom = Math.max(7, Math.min(11, map.getBoundsZoom(bounds.pad(0.05))));
    map.setView(bounds.getCenter(), zoom);
  } else {
    map.setView([lat, lng], 10);
  }

  if (marker) {
    popupSource = 'list';
    marker.openPopup();
  }
}

// Reset the map to the view shown right after the location lookup (clicking
// the coordinates in the header): recentered on the user, re-zoomed to the
// nearest stations
function focusUserLocation() {
  showHomeView();
}

// Open popup for a specific station without changing the map view
function openStationPopup(lat, lng) {
  // Find and open the popup for this station
  markers.forEach(marker => {
    const markerLatLng = marker.getLatLng();
    if (Math.abs(markerLatLng.lat - lat) < 0.001 && Math.abs(markerLatLng.lng - lng) < 0.001) {
      marker.openPopup();
    }
  });
}

// Initialize map when page loads
window.addEventListener('DOMContentLoaded', () => {
  // Honor a shared ?sport= link before the first render
  const initialSport = sportFromUrl();
  setSportState(initialSport);
  setSportControl(initialSport);

  initMap();

  // Automatically try to get user location on page load
  setTimeout(() => {
    lookupByLocation();
  }, 500); // Small delay to ensure map is fully loaded
});

// Back/forward between sport views
window.addEventListener('popstate', () => {
  const sport = sportFromUrl();
  if (sport !== currentSport) {
    setSportControl(sport);
    updateSportFilter(sport, false);
  }
});
