# 🏈 Vikings Radio Finder

Find radio stations broadcasting Minnesota Vikings games near your location.

A spin-off of [Husker Radio Finder](https://github.com/jeffsheets/huskerfinder), using the same FCC-based signal model.

## ✨ Features

- **📍 Location-Based Search**: Uses your device's GPS to find nearby radio stations
- **🗺️ Interactive Map**: Station locations, coverage rings, and a network-wide coverage overlay
- **📡 FCC Tower Data**: Actual tower coordinates, power, and antenna height from FCC records
- **📶 Signal Strength Estimates**: FCC F(50,50) curves for FM, groundwave model for AM, with AM night power
- **📌 Pick a Spot**: Rank stations for anywhere on the map, not just where you are
- **📊 Complete Station List**: Every Vikings Radio Network frequency by state and city

## 🛠️ Local Development

```bash
npx serve .
# Visit http://localhost:3000
```

## 📻 Updating Stations

```bash
# 1. Edit scripts/affiliates.txt from https://www.vikings.com/audio/radio-network
# 2. Refresh FCC data (delete scripts/fcc-data-cache.json to force a re-fetch)
node scripts/fetch-fcc-bulk.js
# 3. Match to FCC licenses and write js/stations.js
node scripts/build-stations.js
# 4. Re-render the static table in stations.html
node scripts/generate-station-table.js
```

Not affiliated with the Minnesota Vikings or the NFL.
