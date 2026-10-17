/**
 * Fetch FCC tower data in bulk for every state on the Vikings Radio Network
 * Uses the FCC's query interface with list=4 for pipe-delimited output
 */

const https = require('https');
const fs = require('fs');

/**
 * Fetch FM stations from FCC by state
 */
async function fetchFM(state) {
  return new Promise((resolve, reject) => {
    // Use list=4 for pipe-delimited text output (easier to parse)
    const url = `https://transition.fcc.gov/fcc-bin/fmq?call=&filenumber=&state=${state}&city=&freq=88.1&fre2=107.9&serv=&status=3&facid=&asrn=&class=&list=4&ThisTab=Results+to+This+Page%2FTab&dist=&dlat2=&mlat2=&slat2=&NS=N&dlon2=&mlon2=&slon2=&EW=W&size=9`;

    console.log(`Fetching all ${state} FM stations...`);

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch AM stations from FCC by state
 */
async function fetchAM(state) {
  return new Promise((resolve, reject) => {
    // Similar query but for AM stations
    const url = `https://transition.fcc.gov/fcc-bin/amq?call=&filenumber=&state=${state}&city=&freq=540&fre2=1700&serv=&status=3&facid=&asrn=&class=&list=4&ThisTab=Results+to+This+Page%2FTab&dist=&dlat2=&mlat2=&slat2=&NS=N&dlon2=&mlon2=&slon2=&EW=W&size=9`;

    console.log(`Fetching all ${state} AM stations...`);

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse pipe-delimited FCC data
 * The format appears to be (based on earlier output):
 * Index | Field
 * 0     | Empty
 * 1     | Call Sign
 * 2     | Frequency
 * 3     | Service (FM/AM)
 * 4     | Power/ERP
 * ...more fields...
 * 10    | City
 * 11    | State
 * ...
 * We need to find where lat/lon are stored
 */
function parseFCCData(data, format) {
  const stations = [];
  const lines = data.split('\n');

  console.log(`Parsing ${format} data (${lines.length} lines)...`);

  // First, let's look at the first few data lines to understand the format
  let dataLineCount = 0;
  for (let i = 0; i < lines.length && dataLineCount < 3; i++) {
    const line = lines[i].trim();
    if (line && line.includes('|')) {
      const fields = line.split('|');
      if (fields.length > 10 && fields[3].trim() === format) {
        console.log(`\nSample ${format} line ${dataLineCount + 1}:`);
        console.log(`  Fields count: ${fields.length}`);
        for (let j = 0; j < Math.min(fields.length, 30); j++) {
          console.log(`  [${j}]: "${fields[j].trim()}"`);
        }
        dataLineCount++;
      }
    }
  }

  // Now parse all stations
  for (const line of lines) {
    if (line && line.includes('|')) {
      const fields = line.split('|');

      // Basic validation - make sure this is a data line.
      // FM queries also return FX (translator) and FL (LPFM) rows - keep them,
      // tagged by service, since network affiliates include FM translators.
      const service = fields.length > 20 ? fields[3].trim() : '';
      const serviceOk = format === 'FM' ? ['FM', 'FX', 'FL'].includes(service) : service === format;
      if (fields.length > 20 && serviceOk) {
        const callSign = fields[1].trim().replace(/-FM$/, '');
        const frequency = parseFloat(fields[2]);
        const city = fields[10].trim();
        const state = fields[11].trim();
        const status = fields[9].trim(); // LIC / CP / MOD / ...

        // FM: field [4] is the CHANNEL NUMBER (freq = 87.9 + 0.2*(ch-200)).
        // Real ERP is [14] (horizontal) / [15] (vertical) in kW, and
        // [16]/[17] is antenna HAAT in meters.
        // AM: [14] is power in kW; day/night appear as separate rows with
        // [5] = DAY / NIG / UNL.
        let power = null;
        let haat = null;
        let hours = null;
        if (format === 'FM') {
          power = parseFloat(fields[14]) || parseFloat(fields[15]) || null;
          haat = parseFloat(fields[16]) || parseFloat(fields[17]) || null;
        } else if (format === 'AM') {
          power = parseFloat(fields[14]) || null;
          hours = fields[5].trim(); // DAY / NIG / UNL
        }

        // Coordinates are in DMS format:
        // FM: fields [19-26], AM: fields [19-26]
        // [19]: N/S, [20]: lat degrees, [21]: lat minutes, [22]: lat seconds
        // [23]: E/W, [24]: lon degrees, [25]: lon minutes, [26]: lon seconds
        let latitude = null;
        let longitude = null;

        try {
          const latDir = fields[19].trim();
          const latDeg = parseFloat(fields[20]);
          const latMin = parseFloat(fields[21]);
          const latSec = parseFloat(fields[22]);

          const lonDir = fields[23].trim();
          const lonDeg = parseFloat(fields[24]);
          const lonMin = parseFloat(fields[25]);
          const lonSec = parseFloat(fields[26]);

          // Convert DMS to decimal degrees
          if (!isNaN(latDeg) && !isNaN(latMin) && !isNaN(latSec)) {
            latitude = latDeg + (latMin / 60) + (latSec / 3600);
            if (latDir === 'S') latitude = -latitude;
          }

          if (!isNaN(lonDeg) && !isNaN(lonMin) && !isNaN(lonSec)) {
            longitude = lonDeg + (lonMin / 60) + (lonSec / 3600);
            if (lonDir === 'W') longitude = -longitude;
          }
        } catch (e) {
          // Skip if parsing fails
        }

        stations.push({
          callSign,
          frequency,
          format,
          service,
          status,
          city,
          state,
          power,
          haat,
          hours,
          latitude,
          longitude,
          rawLine: line
        });
      }
    }
  }

  console.log(`Parsed ${stations.length} ${format} stations\n`);
  return stations;
}

/**
 * Main execution
 */
async function main() {
  const cacheFile = './scripts/fcc-data-cache.json';

  // Check if we have cached data
  if (fs.existsSync(cacheFile)) {
    console.log('Found cached FCC data. Use this? (Delete file to re-fetch)');
    console.log(`Cache file: ${cacheFile}\n`);

    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`Loaded ${cached.length} stations from cache`);

    // Show sample
    const withCoords = cached.filter(s => s.latitude && s.longitude);
    console.log(`Stations with coordinates: ${withCoords.length}\n`);

    if (withCoords.length > 0) {
      console.log('Sample stations:');
      for (const station of withCoords.slice(0, 3)) {
        console.log(`  ${station.callSign} ${station.frequency}${station.format} - ${station.city}`);
        console.log(`    Tower: ${station.latitude}, ${station.longitude}`);
        console.log(`    Power: ${station.power} kW`);
      }
    }
    return cached;
  }

  try {
    console.log('Fetching fresh data from FCC...\n');

    const allStations = [];
    const states = ['MN', 'ND', 'SD', 'IA', 'WI'];

    // Fetch data for each state
    for (const state of states) {
      console.log('\n' + '='.repeat(60));
      console.log(`Fetching ${state} stations...`);
      console.log('='.repeat(60) + '\n');

      // Fetch FM
      const fmData = await fetchFM(state);
      const fmStations = parseFCCData(fmData, 'FM');
      allStations.push(...fmStations);

      // Be nice to FCC servers
      await sleep(1000);

      // Fetch AM
      const amData = await fetchAM(state);
      const amStations = parseFCCData(amData, 'AM');
      allStations.push(...amStations);

      // Be nice to FCC servers
      await sleep(1000);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Total stations found: ${allStations.length}`);

    // Show some examples with coordinates
    const withCoords = allStations.filter(s => s.latitude && s.longitude);
    console.log(`Stations with coordinates: ${withCoords.length}`);

    if (withCoords.length > 0) {
      console.log('\nSample stations with coordinates:');
      for (const station of withCoords.slice(0, 5)) {
        console.log(`  ${station.callSign} ${station.frequency}${station.format}`);
        console.log(`    ${station.city}, ${station.state}`);
        console.log(`    Tower: ${station.latitude}, ${station.longitude}`);
        console.log(`    Power: ${station.power} kW`);
      }
    }

    // Save to cache file
    fs.writeFileSync(cacheFile, JSON.stringify(allStations, null, 2));
    console.log(`\n✓ Saved data to ${cacheFile}`);

    return allStations;

  } catch (error) {
    console.error('Error:', error);
  }
}

main();
