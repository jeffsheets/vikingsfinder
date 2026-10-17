# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vikings Radio Finder (VikingsFinder) is a vanilla JavaScript web application that helps users find radio stations broadcasting Minnesota Vikings games near their location. It is a spin-off of Husker Radio Finder (`../huskerfinder`) and shares its map, signal model, and coverage code; the two are copies, not a shared library, so fixes to `js/lib.js` / `js/coverage.js` / `js/map.js` may be worth porting between them.

**Live site**: https://vikingsfinder.sheetsj.com/ (GitHub Pages behind Cloudflare, like huskerfinder)

## Development Commands

```bash
npx serve .
# Visit http://localhost:3000
```

Repo: https://github.com/jeffsheets/vikingsfinder (default branch `main`). Deploys to GitHub Pages from `main` once Pages is enabled.

## Code Architecture

- **index.html** - Map view and location-based search
- **about.html** - About page, signal-model explainer, FAQ
- **stations.html** - Complete station list (table pre-rendered by `scripts/generate-station-table.js`; no client-side filtering)
- **styles.css** - Global styles (Vikings purple `#4F2683`, gold `#FFC62F`)
- **js/stations.js** - Generated station data (74 frequencies). Do not hand-edit; edit `scripts/affiliates.txt` and rebuild
- **js/lib.js** - Geolocation, distance, signal estimation (`estimateSignal`, `listeningRank`, `coverageRadii`)
- **js/map.js** - Leaflet map, markers, list, pick-a-spot pin, full-screen
- **js/coverage.js** - Network-wide coverage raster overlay
- **scripts/affiliates.txt** - Hand-maintained list from https://www.vikings.com/audio/radio-network
- **scripts/fetch-fcc-bulk.js** - Fetch FCC FM/AM data for MN, ND, SD, IA, WI into `scripts/fcc-data-cache.json`
- **scripts/build-stations.js** - Match affiliates to FCC licenses, write `js/stations.js` (coords, power, powerNight, haat, translator fields)
- **scripts/generate-station-table.js** - Render the static table into stations.html
- **scripts/m3.seq** - FCC M3 ground-conductivity boundary data (from https://www.fcc.gov/media/radio/m3-ground-conductivity-map; the site blocks automated downloads, so fetch it in a browser)
- **scripts/build-conductivity.js** - Rasterize m3.seq into **js/conductivity.js** (0.05° grid covering every tower + 800 km). Re-run if the station footprint grows

### Key Technical Details

The FM model, ranking, pick-a-spot, and full-screen behavior are unchanged from Husker Radio Finder. See `../huskerfinder/CLAUDE.md` for the detailed write-up.

**AM over real ground (differs from huskerfinder)**: AM groundwave follows the path from tower to listener across the FCC M3 conductivity grid (`conductivityAt`), combining soils with Kirke's equivalent-distance method (`walkAmPath` / `amPathFieldMvm` in `js/lib.js`, 47 CFR 73.183). `estimateSignal` takes the listener point so it knows the bearing. `coverageReach` returns AM reach per 5° radial, so popup rings are polygons (`goodShape`/`fairShape`), the popup footer shows a min–max range, and `js/coverage.js` paints each AM station's outline. FM and stations without a grid still use circles. In m3.seq the two value columns are east-side / west-side conductivity (verified by scanline consistency); codes 102/199 are not conductivities and are treated as unknown (the path keeps the previous ground).

**Sport filter**: the Vikings only have one sport, so the sport segmented control is removed from the UI. The `Sport` field (`"Football"`) and the `currentSport`/`currentFilters` machinery in `js/map.js` remain so the shared code keeps working; `?sport=` is effectively a no-op.

**Station data fields**: `City`, `State` (as listed by the team), `latitude`/`longitude` (FCC tower), `CallSign` (displayed), `Format`, `Frequency`, `Sport`, `Year`, `towerLatitude`/`towerLongitude`, `licenseCity` (FCC city of license), `listedAs` (call sign the team page used, when different), `power`, `powerNight` (AM), `haat` (FM), `translatorCallSign`/`translatorOf`/`powerSource` (FM translators).

**FCC_OVERRIDES** in `scripts/build-stations.js` resolves team-page rows that don't match an FCC license (sister-station call signs, typos, the unlisted Crookston translator, the KFAN/KFXN branding). Check those each season.

**Time control (Now / Day / Night)**: a segmented row under Sort by. `setTimeOfDay` in `js/map.js` sets `timeOfDayOverride` in `js/lib.js`; every AM day/night decision goes through `isNightForAm` (never call `isNightAt` directly for AM operation), so the list, bars, popup rings/footer and coverage map all follow it. Switching re-ranks with `keepView` and refreshes an open popup. Not persisted or put in the URL.

**FM terrain (2026-10-17)**: `scripts/build-fm-radials.js <FM_service_contour_current.txt>` adds `fmHaatRadials` (72 effective heights, every 5°) and, rarely, `fmOffsetRadials` (dB, for directional nulls / heights outside the F(50,50) range) to FM entries in `js/stations.js`. Source: the FCC's daily FM service contour file (https://transition.fcc.gov/bureaus/mb/databases/map/FM_service_contour_current.zip, ~65 MB; the FCC page lists a different, dead filename), linked by the LMS application ID in field 38 of the cache row (falls back to frequency + tower location when the display call sign differs, e.g. KFAN/KFXN). Each radial's height is solved so our 60 dBu edge lands on the FCC contour (verified: median 0.0–0.1%, max ~1%); `fmRadialAt` in `js/lib.js` uses it for every tier, and `coverageReach` returns per-radial reach for FM too. Re-run after anything that rewrites stations.js.

**AM antenna data, night limits, curvature (2026-10-17)**: `scripts/build-am-patterns.js <cdbs dir>` adds `amClass`, `amFieldDay`, `amFieldNight` to `js/stations.js` from the FCC CDBS files `am_ant_sys.dat` / `am_towers.dat` (download the zips from https://transition.fcc.gov/ftp/Bureaus/MB/Databases/cdbs/; CDBS froze in Jan 2024, so newer licenses keep the generic 300 mV/m·√kW). The field is a number (non-directional) or 72 values every 5° (directional, FCC standard pattern, augmentations not applied). Non-directional rows store RMS per kW and directional rows at licensed power — verified across the whole file; WNAX's computed night pattern matches the FCC plot. Re-run it after `build-stations.js`/`update-signal-data.js`, which rewrite stations.js. `amFieldAt1Km` reads it (`amPowerNow` now switches to the night pattern whenever the sun is down, even at unchanged power). At night the AM Fair floor sits on the station's computed night limit (`amNightLimit`, 72 radials, mV/m) and the other tiers keep their spacing (`amFloorShiftDb`); stations without it fall back to +12 dB (2.0 mV/m, FCC Class B night protection). Class A is exempt. `scripts/build-am-night-limits.js <cdbs dir>` computes the limits with the FCC NIF method (73.182 RSS 50% exclusion, 73.190 Formula 1/Figure 6a skywave, 26 dB co-channel / 0 dB first-adjacent) but with typical 50% skywave instead of the FCC's 10% (logged for reference); interferers come from the FCC AM query per channel ±10 kHz, all countries (cached in `scripts/fcc-am-channel-cache.json`), with CDBS night antennas where available. No published per-station NIF values exist to validate against; sanity checks only (expected top interferers, class ordering). Run it last, after build-am-patterns.js. `AM_CURVATURE` (exp(−0.0021·f_MHz^1.5·d_km)) corrects the flat-earth Norton model; it was fitted to fccdata.org's FCC daytime contours for WEBC, KTLK, WJON, KFYR, KFGO, WNAX and checked on KRVN, KLIN, WOW (median contour error 3.3%, 90th percentile 7%).

### Privacy & Analytics

- Location data stays client-side
- Umami is not set up yet (TODO comment in index.html). `track()` no-ops without it
- Pinned points are never written to the URL, stored, or sent to analytics

## Updating Stations for a New Season

1. Edit `scripts/affiliates.txt` from https://www.vikings.com/audio/radio-network
2. Delete `scripts/fcc-data-cache.json` and run `node scripts/fetch-fcc-bulk.js` (optional if FCC data is recent)
3. `node scripts/build-stations.js` — fix any "No FCC match" rows with an `FCC_OVERRIDES` entry
4. `node scripts/generate-station-table.js`
5. Update station counts in visible copy (index.html FAQ + JSON-LD, stations.html intro, about.html FAQ, llms.txt)
6. Bump `?v=` cache-busting params on changed JS/CSS references (GitHub Pages caches 4 hours)
7. Update `<lastmod>` in sitemap.xml
8. After the changes deploy, ping IndexNow (key file `4f9c1beb20c1dd28fa17886072c72215.txt` is in the site root):
   ```bash
   curl -X POST "https://api.indexnow.org/indexnow" -H "Content-Type: application/json; charset=utf-8" -d '{
     "host": "vikingsfinder.sheetsj.com",
     "key": "4f9c1beb20c1dd28fa17886072c72215",
     "keyLocation": "https://vikingsfinder.sheetsj.com/4f9c1beb20c1dd28fa17886072c72215.txt",
     "urlList": [
       "https://vikingsfinder.sheetsj.com/",
       "https://vikingsfinder.sheetsj.com/stations.html",
       "https://vikingsfinder.sheetsj.com/about.html",
       "https://vikingsfinder.sheetsj.com/llms.txt",
       "https://vikingsfinder.sheetsj.com/sitemap.xml"
     ]
   }'
   ```

## Git Workflow

**IMPORTANT**: Always ask for explicit confirmation before performing ANY git operations (commit, push, PR, merge, rebase).

## Important Notes

- Static site — no build process, no backend, no bundler
- Scripts load in order: stations.js → conductivity.js → lib.js → coverage.js → map.js
- Not affiliated with the Minnesota Vikings or the NFL — the note lives on the About page (Sources & Corrections); footers credit vikings.com like huskerfinder credits huskers.com. No team logos or marks
