import https from 'https';
import fs from 'fs';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

// Récupère N pages de klines Binance en remontant dans le temps
async function fetchKlines(interval, totalBars) {
  const limit = 1000;
  const pages = Math.ceil(totalBars / limit);
  let all = [];
  let endTime = undefined;

  for (let p = 0; p < pages; p++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}` +
      (endTime ? `&endTime=${endTime}` : '');
    const bars = await get(url);
    if (!bars.length) break;
    all = [...bars, ...all];
    endTime = bars[0][0] - 1;
    process.stdout.write(`\r${interval}: ${all.length} barres récupérées...`);
  }
  console.log('');
  return all;
}

async function main() {
  // 4H : 6 mois ≈ 1100 barres (2 pages)
  const bars4h = await fetchKlines('4h', 2000);
  fs.writeFileSync('scripts/btc_4h_raw.json', JSON.stringify(bars4h));
  console.log(`4H : ${bars4h.length} barres — ${new Date(bars4h[0][0]).toISOString().slice(0,10)} → ${new Date(bars4h.at(-1)[0]).toISOString().slice(0,10)}`);

  // 1H : 6 mois ≈ 4400 barres (5 pages)
  const bars1h = await fetchKlines('1h', 5000);
  fs.writeFileSync('scripts/btc_1h_raw.json', JSON.stringify(bars1h));
  console.log(`1H : ${bars1h.length} barres — ${new Date(bars1h[0][0]).toISOString().slice(0,10)} → ${new Date(bars1h.at(-1)[0]).toISOString().slice(0,10)}`);
}

main().catch(console.error);
