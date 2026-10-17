/**
 * Build js/stations.js from scripts/affiliates.txt + the FCC cache.
 *
 * affiliates.txt is the hand-maintained list copied from the team's
 * radio-network page. Each row is matched to an FCC license by call sign +
 * frequency; FCC_OVERRIDES covers rows where the team page lists a sister
 * station's call sign, a typo, or an unlisted FM translator.
 *
 * Writes, per station: tower coordinates, power (FM ERP kW / AM day kW),
 * powerNight (AM), haat (FM, meters), and translator fields.
 *
 * Usage: node scripts/fetch-fcc-bulk.js && node scripts/build-stations.js
 */

const fs = require('fs');

const YEAR = 2026;
const fccData = JSON.parse(fs.readFileSync('./scripts/fcc-data-cache.json', 'utf8'));

// "CallSign|Frequency" as listed on the team page → the FCC license to use.
// display: what the site shows (defaults to the FCC call sign).
const FCC_OVERRIDES = {
  // Licensed KFXN-FM, but branded and universally known as KFAN
  'KFAN|100.3': { fcc: 'KFXN', display: 'KFAN' },
  // Team page lists the Brainerd FM's call sign on its AM sister
  'KBLB|1380': { fcc: 'KLIZ' },
  // Unlisted on the team page: KROX's FM translator (licensed to Grand Forks, tower at Crookston)
  '|105.7': { fcc: 'K289CE', translatorOf: 'KROX' },
  // WWAX 92.1 was renamed WWPE-FM (Hermantown) in 2020; same dial position
  'WWAX|92.1': { fcc: 'WWPE' },
  // Not on the team page: WEBC's FM translator, which the station brands as
  // "Northland Fan 106.5 FM/560 AM" (northlandfan.com)
  'WEBC|106.5': { fcc: 'W293CT', translatorOf: 'WEBC' },
  // 650 Hibbing-market AM is licensed KDAH (Nashwauk)
  'WMNT|650': { fcc: 'KDAH' },
  // 1230 Mankato is licensed KFSP (KYSM is the 103.5 FM sister)
  'KYSM|1230': { fcc: 'KFSP' },
  // Typo on the team page
  'KXXS|1390': { fcc: 'KXSS' },
  // 1190 Wabasha is licensed WPVW
  'WBHA|1190': { fcc: 'WPVW' },
  // (affiliates.txt lists KFGO on 790. The team page says "KFGO AM 740", but
  // 740 is sister KNFL, which carried the Vikings as KVOX before the 2020
  // Midwest deal moved them to KFGO-AM 790; the page's frequency looks stale.)
};

const TRANSLATOR_DEFAULTS = { power: 0.25, haat: 50 };

const bareCall = c => c.replace(/-(AM|FM)$/, '');
const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

function parseFccFields(fcc) {
  const f = fcc.rawLine.split('|');
  if (fcc.format === 'FM') {
    return {
      erp: parseFloat(f[14]) || parseFloat(f[15]) || null,
      haat: parseFloat(f[16]) || parseFloat(f[17]) || null
    };
  }
  return { erp: parseFloat(f[14]) || null, hours: (f[5] || '').trim() };
}

const rows = fs.readFileSync('./scripts/affiliates.txt', 'utf8')
  .split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => {
    const [CallSign, freq, Format, City, State] = l.split('|').map(s => s.trim());
    return { CallSign, Frequency: parseFloat(freq), Format, City, State };
  });

const problems = [];

const stations = rows.map(row => {
  const override = FCC_OVERRIDES[`${row.CallSign}|${row.Frequency}`] || {};
  const fccCall = override.fcc || row.CallSign;

  let matches = fccData.filter(fcc =>
    bareCall(fcc.callSign) === fccCall &&
    fcc.format === row.Format &&
    Math.abs(fcc.frequency - row.Frequency) < 0.05
  );
  const licensed = matches.filter(fcc => fcc.status === 'LIC');
  if (licensed.length) matches = licensed;

  if (!matches.length) {
    problems.push(`${row.CallSign || '(blank)'} ${row.Frequency} ${row.Format} (${row.City})`);
    return null;
  }

  const primary = matches[0];
  const station = {
    City: row.City,
    State: row.State,
    latitude: primary.latitude,
    longitude: primary.longitude,
    CallSign: override.display || fccCall,
    Format: row.Format,
    Frequency: row.Frequency,
    Sport: 'Football',
    Year: YEAR,
    towerLatitude: primary.latitude,
    towerLongitude: primary.longitude,
    licenseCity: `${titleCase(primary.city)}, ${primary.state}`
  };
  if (row.CallSign && row.CallSign !== station.CallSign) station.listedAs = row.CallSign;

  if (row.Format === 'FM') {
    const parsed = parseFccFields(primary);
    station.power = parsed.erp;
    station.haat = parsed.haat;
    if (primary.service === 'FX') {
      station.power = parsed.erp || TRANSLATOR_DEFAULTS.power;
      station.haat = parsed.haat || TRANSLATOR_DEFAULTS.haat;
      station.translatorCallSign = bareCall(primary.callSign);
      station.translatorOf = override.translatorOf;
      station.CallSign = override.translatorOf || station.CallSign;
      station.powerSource = 'FCC-FX';
    }
  } else {
    // AM: separate rows for day and night power. DAY-only = daytimer (0 at night).
    let day = null, night = null, unlimited = false;
    matches.forEach(fcc => {
      const parsed = parseFccFields(fcc);
      if (parsed.hours === 'NIG') night = parsed.erp;
      else {
        day = parsed.erp;
        if (parsed.hours === 'UNL') unlimited = true;
      }
    });
    station.power = day || night;
    station.powerNight = unlimited ? station.power : (night || 0);
  }
  return station;
}).filter(Boolean);

if (problems.length) {
  console.error('⚠️  No FCC match (add an FCC_OVERRIDES entry):');
  problems.forEach(p => console.error(`  ${p}`));
  process.exitCode = 1;
}

stations.sort((a, b) => a.State.localeCompare(b.State) || a.City.localeCompare(b.City) || a.Frequency - b.Frequency);
fs.writeFileSync('./js/stations.js', `const stations = ${JSON.stringify(stations, null, 2)};\n`);
console.log(`✓ Wrote ${stations.length} stations to js/stations.js`);
