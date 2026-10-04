import fs from 'fs';

// ── Chargement ────────────────────────────────────────────────────────────────
const daily = JSON.parse(fs.readFileSync('scripts/btc_daily_raw.json', 'utf8'))
  .map(b => ({ ts: b[0], date: new Date(b[0]).toISOString().slice(0,10), dow: new Date(b[0]).getUTCDay(), open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));

const bars1h = JSON.parse(fs.readFileSync('scripts/btc_1h_raw.json', 'utf8'))
  .map(b => ({ ts: b[0], date: new Date(b[0]).toISOString().slice(0,10), hour: new Date(b[0]).getUTCHours(),
               dow: new Date(b[0]).getUTCDay(), open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));

const bars4h = JSON.parse(fs.readFileSync('scripts/btc_4h_raw.json', 'utf8'))
  .map(b => ({ ts: b[0], date: new Date(b[0]).toISOString().slice(0,10), hour: new Date(b[0]).getUTCHours(),
               dow: new Date(b[0]).getUTCDay(), open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));

// ── Identifier les samedis haussiers + dimanche suivant ──────────────────────
const bullishSatDates = new Set();
const saturdayClose = new Map(); // date sam → close price

for (let i = 1; i < daily.length; i++) {
  const b = daily[i];
  if (b.dow === 6 && b.close > b.open) {
    bullishSatDates.add(b.date);
    saturdayClose.set(b.date, b.close);
  }
}

// Associer chaque samedi haussier à son dimanche
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

const validSundays = new Set();
for (const satDate of bullishSatDates) {
  validSundays.add(nextDay(satDate));
}

console.log(`\nSamedis haussiers trouvés : ${bullishSatDates.size}`);
console.log(`Dimanches à analyser      : ${validSundays.size}`);

// ── Analyse 4H ────────────────────────────────────────────────────────────────
const sun4h = bars4h.filter(b => b.dow === 0 && validSundays.has(b.date));

// Stats par slot 4H (00h, 04h, 08h, 12h, 16h, 20h)
const slots4h = [0, 4, 8, 12, 16, 20];
const stats4h = {};
slots4h.forEach(h => stats4h[h] = { rets: [], lows: [], highs: [], bullish: 0, n: 0 });

// Pour chaque dimanche valide, on calcule le retrace par rapport à l'open du dimanche
const sundayOpen4h = new Map();
for (const b of sun4h) {
  if (b.hour === 0) sundayOpen4h.set(b.date, b.open);
}

for (const b of sun4h) {
  const dayOpen = sundayOpen4h.get(b.date);
  if (!dayOpen) continue;
  const h = b.hour;
  if (!stats4h[h]) continue;
  stats4h[h].rets.push((b.close - b.open) / b.open * 100);
  stats4h[h].lows.push((b.low - dayOpen) / dayOpen * 100);   // drawdown vs open dim
  stats4h[h].highs.push((b.high - dayOpen) / dayOpen * 100); // upside vs open dim
  if (b.close > b.open) stats4h[h].bullish++;
  stats4h[h].n++;
}

// ── Analyse 1H ────────────────────────────────────────────────────────────────
const sun1h = bars1h.filter(b => b.dow === 0 && validSundays.has(b.date));

const sundayOpen1h = new Map();
for (const b of sun1h) {
  if (b.hour === 0) sundayOpen1h.set(b.date, b.open);
}

const stats1h = {};
for (let h = 0; h < 24; h++) stats1h[h] = { rets: [], lows: [], highs: [], bullish: 0, n: 0 };

for (const b of sun1h) {
  const dayOpen = sundayOpen1h.get(b.date);
  if (!dayOpen) continue;
  stats1h[b.hour].rets.push((b.close - b.open) / b.open * 100);
  stats1h[b.hour].lows.push((b.low - dayOpen) / dayOpen * 100);
  stats1h[b.hour].highs.push((b.high - dayOpen) / dayOpen * 100);
  if (b.close > b.open) stats1h[b.hour].bullish++;
  stats1h[b.hour].n++;
}

function avg(arr) { return arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0; }

// ── Output ────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  DIMANCHE APRÈS SAMEDI HAUSSIER — ANALYSE INTRADAY');
console.log('═══════════════════════════════════════════════════════════════');

console.log('\n─── ANALYSE 4H (slots UTC) ──────────────────────────────────');
console.log('Slot  | N  | Rdt bgie | %↑  | Low vs DayOpen | High vs DayOpen');
console.log('------|----|-----------|----|----------------|----------------');
for (const h of slots4h) {
  const s = stats4h[h];
  if (!s.n) continue;
  const pctBull = (s.bullish / s.n * 100).toFixed(0);
  const lo = avg(s.lows).toFixed(2);
  const hi = avg(s.highs).toFixed(2);
  const ret = avg(s.rets).toFixed(2);
  const flag = parseFloat(ret) > 0 && parseFloat(hi) > 0.3 ? ' ★' : '';
  console.log(`${String(h).padStart(2)}h UTC | ${String(s.n).padEnd(2)} | ${ret >= 0 ? '+' : ''}${ret}%     | ${pctBull}% | ${lo}%          | +${hi}%${flag}`);
}

console.log('\n─── ANALYSE 1H — MEILLEUR MOMENT D\'ENTRÉE ──────────────────');
console.log('Heure | N  | Rdt bgie | %↑  | Low vs DayOpen | High vs DayOpen');
console.log('------|----|-----------|----|----------------|----------------');

// Grouper par tranche de 3h pour lisibilité
for (let h = 0; h < 24; h += 3) {
  // Agrège les 3 heures
  let allRets = [], allLows = [], allHighs = [], bull = 0, n = 0;
  for (let dh = 0; dh < 3; dh++) {
    const s = stats1h[h + dh];
    if (!s) continue;
    allRets = [...allRets, ...s.rets];
    allLows = [...allLows, ...s.lows];
    allHighs = [...allHighs, ...s.highs];
    bull += s.bullish; n += s.n;
  }
  if (!n) continue;
  const pctBull = (bull / n * 100).toFixed(0);
  const lo = avg(allLows).toFixed(2);
  const hi = avg(allHighs).toFixed(2);
  const ret = avg(allRets).toFixed(2);
  const flag = parseFloat(pctBull) >= 60 && parseFloat(hi) > 0.3 ? ' ★★' :
               parseFloat(pctBull) >= 55 ? ' ★' : '';
  console.log(`${String(h).padStart(2)}-${h+2}h UTC | ${String(n).padEnd(3)}| ${ret >= 0 ? '+' : ''}${ret}%    | ${pctBull}% | ${lo}%         | +${hi}%${flag}`);
}

// ── Meilleure fenêtre d'entrée heure par heure ────────────────────────────
console.log('\n─── MEILLEURE HEURE D\'ENTRÉE (heure par heure) ─────────────');
const hourlyScores = [];
for (let h = 0; h < 24; h++) {
  const s = stats1h[h];
  if (s.n < 3) continue;
  const pctBull = s.bullish / s.n;
  const avgHi = avg(s.highs);
  const avgLo = avg(s.lows);
  const score = pctBull * avgHi - (1 - pctBull) * Math.abs(avgLo);
  hourlyScores.push({ h, n: s.n, pctBull: (pctBull*100).toFixed(0), avgHi: avgHi.toFixed(2), avgLo: avgLo.toFixed(2), score });
}
hourlyScores.sort((a, b) => b.score - a.score);
console.log('Top 5 heures UTC par score (win rate × upside) :');
hourlyScores.slice(0, 5).forEach((e, i) => {
  console.log(`  #${i+1}  ${String(e.h).padStart(2)}h UTC — ${e.pctBull}% haussier | max +${e.avgHi}% | min ${e.avgLo}% | score: ${e.score.toFixed(3)}`);
});

// ── Analyse du retrace en début de dimanche ───────────────────────────────
console.log('\n─── RETRACE AVANT REPRISE : heures 0→6 UTC ─────────────────');
// Pour chaque dimanche valide, quel est le plus bas atteint dans les 6 premières heures?
const sundayDips = [];
for (const sunDate of validSundays) {
  const dayBars = sun1h.filter(b => b.date === sunDate && b.hour <= 6);
  if (!dayBars.length) continue;
  const dayOpen = sundayOpen1h.get(sunDate);
  if (!dayOpen) continue;
  const minLow = Math.min(...dayBars.map(b => b.low));
  const maxHigh = Math.max(...dayBars.map(b => b.high));
  // Close de fin de journée
  const allDay = sun1h.filter(b => b.date === sunDate);
  const dayClose = allDay.at(-1)?.close;
  const dip = (minLow - dayOpen) / dayOpen * 100;
  const dayRet = dayClose ? (dayClose - dayOpen) / dayOpen * 100 : null;
  sundayDips.push({ date: sunDate, dip, dayRet, dayOpen, minLow });
}

const avgDip = avg(sundayDips.map(d => d.dip));
const dipPct = sundayDips.filter(d => d.dip < -0.3).length / sundayDips.length * 100;
const retAfterDip = sundayDips.filter(d => d.dip < -0.3 && d.dayRet > 0).length /
                    Math.max(1, sundayDips.filter(d => d.dip < -0.3).length) * 100;

console.log(`  Dip moyen en début de dimanche (0-6h) : ${avgDip.toFixed(2)}%`);
console.log(`  % dim avec dip > 0.3%                 : ${dipPct.toFixed(0)}%`);
console.log(`  % haussier après dip > 0.3%            : ${retAfterDip.toFixed(0)}%`);

// ── Synthèse stratégie ────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  SYNTHÈSE — SETUP OPTIMAL');
console.log('═══════════════════════════════════════════════════════════════');

const bestHour = hourlyScores[0];
console.log(`\n  Meilleure entrée : ${bestHour.h}h UTC (${bestHour.h+2}h Paris hiver / ${bestHour.h+2}h été)`);
console.log(`  Condition       : Samedi clôture haussier (close > open)`);
console.log(`  Direction       : LONG`);
console.log(`  Entrée          : ${bestHour.h}h00 UTC dimanche (ou sur dip si ${avgDip.toFixed(1)}% sous open)`);
console.log(`  Stop            : Sous le plus bas du samedi`);
console.log(`  TP              : +0.5% à +1% (lundi Asian open)`);
console.log(`  Win rate estimé : ~${bestHour.pctBull}%`);
console.log('═══════════════════════════════════════════════════════════════\n');
