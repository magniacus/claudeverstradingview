import fs from 'fs';

const bars1h = JSON.parse(fs.readFileSync('scripts/btc_1h_raw.json', 'utf8'))
  .map(b => ({
    ts: b[0], date: new Date(b[0]).toISOString().slice(0,10),
    hour: new Date(b[0]).getUTCHours(), dow: new Date(b[0]).getUTCDay(),
    open: +b[1], high: +b[2], low: +b[3], close: +b[4],
    range: (+b[2] - +b[3]) / +b[1] * 100,
    ret:   (+b[4] - +b[1]) / +b[1] * 100,
    bullish: +b[4] > +b[1],
  }));

const daily = JSON.parse(fs.readFileSync('scripts/btc_daily_raw.json', 'utf8'))
  .map(b => ({ ts: b[0], date: new Date(b[0]).toISOString().slice(0,10),
               dow: new Date(b[0]).getUTCDay(), open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function prevDay(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10);
}

const satDaily = new Map();
daily.filter(b => b.dow === 6).forEach(b => satDaily.set(b.date, b));

const sundays = [...new Set(bars1h.filter(b => b.dow === 0).map(b => b.date))].sort();

// ══════════════════════════════════════════════════════════════════════════════
// Pour chaque dimanche, construire le contexte complet
// ══════════════════════════════════════════════════════════════════════════════
const trades = [];

for (const sunDate of sundays) {
  const satDate = prevDay(sunDate);
  const sat = satDaily.get(satDate);
  if (!sat) continue;

  const dayBars = bars1h.filter(b => b.date === sunDate).sort((a,b) => a.hour - b.hour);
  if (dayBars.length < 16) continue;

  const bar11 = dayBars.find(b => b.hour === 11);
  const bar12 = dayBars.find(b => b.hour === 12);
  const bar13 = dayBars.find(b => b.hour === 13);
  const bar14 = dayBars.find(b => b.hour === 14);
  const bar15 = dayBars.find(b => b.hour === 15);
  const bar16 = dayBars.find(b => b.hour === 16);
  const bar17 = dayBars.find(b => b.hour === 17);
  const bar18 = dayBars.find(b => b.hour === 18);
  if (!bar13 || !bar14 || !bar15) continue;

  const dayOpen = dayBars[0]?.open;

  // ── Niveaux de liquidité clés ─────────────────────────────────────────────
  // 1. Low de la session matin (11h–13h)
  const morningBars = dayBars.filter(b => b.hour >= 11 && b.hour <= 13);
  const morningLow  = morningBars.length ? Math.min(...morningBars.map(b => b.low)) : null;
  const morningHigh = morningBars.length ? Math.max(...morningBars.map(b => b.high)) : null;
  const morningRet  = morningBars.length ? (morningBars.at(-1).close - morningBars[0].open) / morningBars[0].open * 100 : 0;

  // 2. Low du samedi (equal lows / PDL)
  const satLow  = sat.low;
  const satHigh = sat.high;

  // 3. Low de la bougie 13h (dernier niveau avant le trade)
  const b13Low  = bar13.low;
  const b13High = bar13.high;

  // ── Détection sweep sur la bougie 14h ─────────────────────────────────────
  // Sweep BEARISH : bougie 14h descend sous le morningLow ET remonte (close > low de 13h)
  const sweep14_morningLow = morningLow && bar14.low < morningLow && bar14.close > morningLow;
  // Sweep sous le low de 13h
  const sweep14_b13Low = bar14.low < b13Low && bar14.close > b13Low;
  // N'importe quel sweep (low de 14h < low de 13h mais close > open = engulf)
  const sweep14_any = bar14.low < b13Low && bar14.bullish;

  // ── Taille du wick du sweep (mesure de l'amplitude) ──────────────────────
  const sweepSize = morningLow ? (morningLow - bar14.low) / morningLow * 100 : 0;
  const sweepSize13 = (b13Low - bar14.low) / b13Low * 100;

  // ── Résultat du trade (2 bougies = slot 14h-16h) ─────────────────────────
  const entry = bar14.low; // entrée au low de 14h (après le sweep)
  const entryOpen = bar14.open;
  const slotClose = bar15.close;
  const slotRet_open  = (slotClose - entryOpen) / entryOpen * 100;  // entrer à l'open
  const slotRet_low   = (slotClose - entry) / entry * 100;           // entrer au low (après sweep)

  // Résultat 4H (jusqu'à 18h)
  const ret4h = bar18 ? (bar18.close - entryOpen) / entryOpen * 100 : null;

  // ── Contexte directionnnel ─────────────────────────────────────────────────
  const satBull = sat.close > sat.open;
  const b14Bull = bar14.bullish;

  trades.push({
    date: sunDate, satBull, satLow, satHigh, satRet: (sat.close-sat.open)/sat.open*100,
    morningLow, morningHigh, morningRet,
    b13Low, b13High, b14Bull,
    sweep14_morningLow, sweep14_b13Low, sweep14_any,
    sweepSize, sweepSize13,
    entry, entryOpen, slotClose,
    slotRet_open, slotRet_low, slotBull: slotRet_open > 0,
    ret4h,
  });
}

function stats(subset, label) {
  if (subset.length < 3) { console.log(`  ${label.padEnd(55)} | n trop petit (${subset.length})`); return; }
  const rets = subset.map(r => r.slotRet_open);
  const retsLow = subset.map(r => r.slotRet_low);
  const win = subset.filter(r => r.slotBull).length;
  const cum = subset.reduce((acc, r) => acc * (1 + r.slotRet_open/100), 1);
  const cumLow = subset.reduce((acc, r) => acc * (1 + r.slotRet_low/100), 1);
  const avgWin  = avg(subset.filter(r=>r.slotBull).map(r=>r.slotRet_open));
  const avgLoss = avg(subset.filter(r=>!r.slotBull).map(r=>r.slotRet_open));
  const rr = avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : '∞';
  console.log(
    `  ${label.padEnd(55)} | n=${String(subset.length).padEnd(2)} | WR=${((win/subset.length)*100).toFixed(0).padStart(3)}% | ` +
    `rdt=${avg(rets)>=0?'+':''}${avg(rets).toFixed(3)}% | low=${avg(retsLow)>=0?'+':''}${avg(retsLow).toFixed(3)}% | cum=${((cum-1)*100)>=0?'+':''}${((cum-1)*100).toFixed(1)}% | R/R=${rr}`
  );
}

console.log(`\nDimanches analysés : ${trades.length}\n`);

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  PRISE DE LIQUIDITÉ — DIMANCHE 14h UTC (16h FR)');
console.log('  Entrée open = open 14h | Entrée low = low de la bougie 14h (après sweep)');
console.log('═══════════════════════════════════════════════════════════════════════');

console.log('\n─── 1. BASELINE ─────────────────────────────────────────────────────');
console.log('  Condition                                               | N   | WR   | Rdt open | Rdt low  | Cumulé  | R/R');
console.log('  ' + '─'.repeat(100));
stats(trades, 'Tous les dimanches (baseline)');
stats(trades.filter(r => r.satBull), 'Sam haussier');
stats(trades.filter(r => r.b14Bull), 'Bougie 14h haussière');

console.log('\n─── 2. AVEC SWEEP (prise de liquidité sur low de session matin) ────');
console.log('  Condition                                               | N   | WR   | Rdt open | Rdt low  | Cumulé  | R/R');
console.log('  ' + '─'.repeat(100));
stats(trades.filter(r => r.sweep14_morningLow), 'Sweep sous low 11-13h puis close au-dessus');
stats(trades.filter(r => r.sweep14_b13Low),     'Sweep sous low bougie 13h puis close au-dessus');
stats(trades.filter(r => r.sweep14_any),        'Bougie 14h passe sous low 13h ET clôture bull');

console.log('\n─── 3. COMBOS SWEEP + CONTEXTE ─────────────────────────────────────');
console.log('  Condition                                               | N   | WR   | Rdt open | Rdt low  | Cumulé  | R/R');
console.log('  ' + '─'.repeat(100));
stats(trades.filter(r => r.sweep14_any && r.satBull),       'Sweep b14 + Sam haussier');
stats(trades.filter(r => r.sweep14_morningLow && r.satBull),'Sweep matin + Sam haussier');
stats(trades.filter(r => r.sweep14_any && r.morningRet < 0),'Sweep b14 + Matin baissier (contexte idéal)');
stats(trades.filter(r => r.sweep14_morningLow && r.morningRet < 0), 'Sweep matin + Matin baissier');
stats(trades.filter(r => r.sweep14_any && r.satBull && r.morningRet < 0), 'Sweep + Sam↑ + Matin↓ (SETUP COMPLET)');

console.log('\n─── 4. SANS SWEEP (comparaison) ─────────────────────────────────────');
console.log('  Condition                                               | N   | WR   | Rdt open | Rdt low  | Cumulé  | R/R');
console.log('  ' + '─'.repeat(100));
stats(trades.filter(r => !r.sweep14_any),                   'Pas de sweep bougie 14h');
stats(trades.filter(r => !r.sweep14_any && r.satBull),      'Pas de sweep + Sam haussier');
stats(trades.filter(r => !r.sweep14_any && r.b14Bull),      'Pas de sweep + b14 haussière');

console.log('\n─── 5. TAILLE DU SWEEP ──────────────────────────────────────────────');
const sweepTrades = trades.filter(r => r.sweep14_any);
// Quartiles sweep
const sizes = sweepTrades.map(r => r.sweepSize13).sort((a,b)=>a-b);
const q1 = sizes[Math.floor(sizes.length*0.25)] || 0;
const q3 = sizes[Math.floor(sizes.length*0.75)] || 0;
const median = sizes[Math.floor(sizes.length*0.5)] || 0;
console.log(`  Sweep taille médiane   : ${median.toFixed(3)}%`);
console.log(`  Q1 / Q3                : ${q1.toFixed(3)}% / ${q3.toFixed(3)}%`);
stats(sweepTrades.filter(r => r.sweepSize13 > median), `Sweep > médiane (${median.toFixed(3)}%) = gros sweep`);
stats(sweepTrades.filter(r => r.sweepSize13 <= median), `Sweep ≤ médiane (micro sweep)`);

console.log('\n─── 6. HISTORIQUE DÉTAILLÉ ──────────────────────────────────────────');
console.log('Date       | Sam  | Mat↑↓ | Swp13 | SwpMat | B14  | Slot(open) | Slot(low) | 4H    ');
console.log('-----------|------|-------|-------|--------|------|------------|-----------|-------');
trades.slice(-20).forEach(r => {
  const satStr = r.satBull ? '↑' : '↓';
  const matStr = r.morningRet >= 0.2 ? '↑' : r.morningRet <= -0.2 ? '↓' : '–';
  const s13 = r.sweep14_b13Low ? `✓${r.sweepSize13.toFixed(2)}%` : '✗    ';
  const sM  = r.sweep14_morningLow ? '✓' : '✗';
  const b14 = r.b14Bull ? `↑${r.slotRet_open>=0?'+':''}` : `↓`;
  const open = r.slotRet_open >= 0 ? `+${r.slotRet_open.toFixed(2)}%` : `${r.slotRet_open.toFixed(2)}%`;
  const low  = r.slotRet_low >= 0  ? `+${r.slotRet_low.toFixed(2)}%`  : `${r.slotRet_low.toFixed(2)}%`;
  const r4   = r.ret4h != null ? (r.ret4h >= 0 ? `+${r.ret4h.toFixed(2)}%` : `${r.ret4h.toFixed(2)}%`) : 'N/A';
  // highlight sweeps
  const flag = r.sweep14_any ? ' ◀' : '';
  console.log(`${r.date} | ${satStr}     | ${matStr}     | ${s13} | ${sM}      | ${b14}    | ${open.padStart(8)}   | ${low.padStart(7)}   | ${r4}${flag}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// SYNTHÈSE FINALE
// ══════════════════════════════════════════════════════════════════════════════
const bestSetup = trades.filter(r => r.sweep14_any && r.satBull && r.morningRet < 0);
const bestSetup2 = trades.filter(r => r.sweep14_any && r.satBull);
const sweepFreq = (sweepTrades.length / trades.length * 100).toFixed(0);

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('  SETUP FINAL — LONG DIMANCHE 14h UTC avec PRISE DE LIQUIDITÉ');
console.log('═══════════════════════════════════════════════════════════════════════');

const finalSet = bestSetup.length >= 3 ? bestSetup : bestSetup2;
const finalLabel = bestSetup.length >= 3 ? 'Sweep + Sam↑ + Matin↓' : 'Sweep + Sam↑';

if (finalSet.length > 0) {
  const wr = (finalSet.filter(r=>r.slotBull).length / finalSet.length * 100).toFixed(0);
  const rdtOpen = avg(finalSet.map(r=>r.slotRet_open)).toFixed(3);
  const rdtLow  = avg(finalSet.map(r=>r.slotRet_low)).toFixed(3);
  const cum     = ((finalSet.reduce((a,r)=>a*(1+r.slotRet_low/100),1)-1)*100).toFixed(1);
  const avgWin  = avg(finalSet.filter(r=>r.slotBull).map(r=>r.slotRet_low));
  const avgLoss = avg(finalSet.filter(r=>!r.slotBull).map(r=>r.slotRet_low));
  const rr = avgLoss ? (avgWin / Math.abs(avgLoss)).toFixed(2) : '∞';

  console.log(`
  Condition        : ${finalLabel}
  Fréquence        : ~${finalSet.length}/${trades.length} dimanches (${sweepFreq}% ont un sweep)

  Lecture du setup :
    1. Sam daily clôture haussier
    2. Session 11h–13h UTC dimanche se termine en rouge (pression baissière)
    3. À 14h UTC, la bougie descend SOUS le low de la bougie 13h (sweep de liquidité)
       → wick bas visible, prise des stops des longs de la session matin
    4. La bougie 14h remonte et clôture HAUSSIÈRE au-dessus du low de 13h

  Entrée           : Au LOW de la bougie 14h UTC (pendant le sweep)
                     Ou limit order quelques ticks sous le low de 13h
  Stop             : -0.3% sous le low du sweep (protection contre fausse reprise)
  TP1              : Close de 15h UTC (+0.3%)
  TP2              : 18h UTC (+0.6%)

  Performance (entrée au low du sweep) :
    N trades       : ${finalSet.length}
    Win rate       : ${wr}%
    Rdt moy (low)  : +${rdtLow}%
    Rdt moy (open) : +${rdtOpen}%  ← gain additionnel grâce au sweep
    Cumulé         : +${cum}%
    R/R            : ${rr}:1
`);
}
console.log('═══════════════════════════════════════════════════════════════════════\n');
