import fs from 'fs';

const bars1h = JSON.parse(fs.readFileSync('scripts/btc_1h_raw.json', 'utf8'))
  .map(b => ({
    ts: b[0], date: new Date(b[0]).toISOString().slice(0,10),
    hour: new Date(b[0]).getUTCHours(), dow: new Date(b[0]).getUTCDay(),
    open: +b[1], high: +b[2], low: +b[3], close: +b[4],
    range: (+b[2] - +b[3]) / +b[1] * 100,
    ret:   (+b[4] - +b[1]) / +b[1] * 100,
  }));

const daily = JSON.parse(fs.readFileSync('scripts/btc_daily_raw.json', 'utf8'))
  .map(b => ({ ts: b[0], date: new Date(b[0]).toISOString().slice(0,10),
               dow: new Date(b[0]).getUTCDay(), open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function std(arr) { const m=avg(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }
function prevDay(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10);
}

// ── Construire le contexte de chaque dimanche ─────────────────────────────────
// Pour chaque dimanche on veut :
//  - Journée du samedi (direction, range)
//  - Les 3h précédant 14h UTC (11h/12h/13h) = momentum matin
//  - Les barres 14h et 15h UTC (notre créneau)
//  - Les barres 16h→23h UTC (pour mesurer ce qui suit)

const sundays = [...new Set(bars1h.filter(b => b.dow === 0).map(b => b.date))].sort();

const satDaily = new Map();
daily.filter(b => b.dow === 6).forEach(b => satDaily.set(b.date, b));

const results = [];

for (const sunDate of sundays) {
  const satDate = prevDay(sunDate);
  const sat = satDaily.get(satDate);
  if (!sat) continue;

  const dayBars = bars1h.filter(b => b.date === sunDate).sort((a,b) => a.hour - b.hour);
  if (dayBars.length < 16) continue;

  const bar14 = dayBars.find(b => b.hour === 14);
  const bar15 = dayBars.find(b => b.hour === 15);
  if (!bar14 || !bar15) continue;

  // Contexte matin (11h-13h)
  const morning = dayBars.filter(b => b.hour >= 11 && b.hour <= 13);
  const morningRet = morning.length ? (morning.at(-1).close - morning[0].open) / morning[0].open * 100 : 0;

  // Open du dimanche
  const dayOpen = dayBars[0]?.open;

  // Prix entrée = open 14h
  const entry = bar14.open;

  // Résultat du slot 14h-16h (close du 15h)
  const slotClose = bar15.close;
  const slotRet = (slotClose - entry) / entry * 100;

  // Résultat sur 4H suivantes (jusqu'à 18h)
  const bar16 = dayBars.find(b => b.hour === 16);
  const bar17 = dayBars.find(b => b.hour === 17);
  const bar18 = dayBars.find(b => b.hour === 18);
  const ret4h  = bar18 ? (bar18.close - entry) / entry * 100 : null;

  // Plus haut/bas dans le slot 14h-15h
  const slotHigh = Math.max(bar14.high, bar15.high);
  const slotLow  = Math.min(bar14.low,  bar15.low);

  // Stats de la bougie 14h seule
  const b14ret   = bar14.ret;
  const b14range = bar14.range;

  // Contexte samedi
  const satBull   = sat.close > sat.open;
  const satRange  = (sat.high - sat.low) / sat.open * 100;
  const satRet    = (sat.close - sat.open) / sat.open * 100;

  // Prix vs open dimanche au moment de l'entrée
  const entryVsDayOpen = dayOpen ? (entry - dayOpen) / dayOpen * 100 : 0;

  results.push({
    date: sunDate, satBull, satRet, satRange,
    morningRet, entryVsDayOpen,
    entry, slotClose, slotRet, slotHigh, slotLow,
    b14ret, b14range, ret4h,
    slotBull: slotRet > 0,
  });
}

console.log(`\nDimanches analysés : ${results.length}`);

// ══════════════════════════════════════════════════════════════════════════════
// 1. STATS BRUTES 14h–16h UTC DIMANCHE
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  STRATÉGIE BTC — DIMANCHE 14h–16h UTC (16h–18h FR)');
console.log('═══════════════════════════════════════════════════════════════');

const allRets = results.map(r => r.slotRet);
const pctBull = results.filter(r => r.slotBull).length / results.length * 100;
console.log('\n─── STATS BRUTES 14h–16h UTC ────────────────────────────────');
console.log(`  N dimanches       : ${results.length}`);
console.log(`  Rdt moyen         : ${avg(allRets) >= 0 ? '+' : ''}${avg(allRets).toFixed(3)}%`);
console.log(`  Std               : ±${std(allRets).toFixed(3)}%`);
console.log(`  % haussier        : ${pctBull.toFixed(0)}%`);
console.log(`  % baissier        : ${(100-pctBull).toFixed(0)}%`);
console.log(`  Range moyen slot  : ${avg(results.map(r => r.b14range)).toFixed(3)}%`);

// ══════════════════════════════════════════════════════════════════════════════
// 2. FILTRES DE CONTEXTE
// ══════════════════════════════════════════════════════════════════════════════
function stats(subset, label) {
  if (!subset.length) return;
  const rets = subset.map(r => r.slotRet);
  const win  = subset.filter(r => r.slotBull).length;
  const cum  = subset.reduce((acc, r) => acc * (1 + r.slotRet/100), 1);
  const rr   = avg(subset.filter(r=>r.slotBull).map(r=>r.slotRet)) /
               Math.abs(avg(subset.filter(r=>!r.slotBull).map(r=>r.slotRet)));
  console.log(
    `  ${label.padEnd(40)} | n=${String(subset.length).padEnd(2)} | ` +
    `WR=${((win/subset.length)*100).toFixed(0).padStart(3)}% | ` +
    `rdt=${avg(rets)>=0?'+':''}${avg(rets).toFixed(3)}% | ` +
    `cum=${((cum-1)*100)>=0?'+':''}${((cum-1)*100).toFixed(1)}% | ` +
    `R/R=${rr.toFixed(2)}`
  );
}

console.log('\n─── IMPACT DU CONTEXTE (filtres) ────────────────────────────');
console.log('  Condition                                | N   | WR   | Rdt moy  | Cumulé  | R/R');
console.log('  ' + '─'.repeat(90));

// Sam haussier vs baissier
stats(results.filter(r => r.satBull),  'Sam haussier');
stats(results.filter(r => !r.satBull), 'Sam baissier');

console.log('  ' + '─'.repeat(90));

// Momentum matin
stats(results.filter(r => r.morningRet > 0.2),  'Matin haussier (11-13h ret > +0.2%)');
stats(results.filter(r => r.morningRet < -0.2), 'Matin baissier (11-13h ret < -0.2%)');
stats(results.filter(r => Math.abs(r.morningRet) <= 0.2), 'Matin neutre (±0.2%)');

console.log('  ' + '─'.repeat(90));

// Prix vs open dimanche à 14h
stats(results.filter(r => r.entryVsDayOpen > 0.2),  'Entrée > +0.2% vs open du jour');
stats(results.filter(r => r.entryVsDayOpen < -0.2), 'Entrée < -0.2% vs open du jour (dip)');
stats(results.filter(r => Math.abs(r.entryVsDayOpen) <= 0.2), 'Entrée proche open du jour');

console.log('  ' + '─'.repeat(90));

// Direction de la bougie 14h
stats(results.filter(r => r.b14ret > 0.1),  'Bougie 14h haussière (ret > +0.1%)');
stats(results.filter(r => r.b14ret < -0.1), 'Bougie 14h baissière (ret < -0.1%)');

console.log('  ' + '─'.repeat(90));

// Combos
stats(results.filter(r => r.satBull && r.morningRet > 0),        'Sam↑ + Matin↑');
stats(results.filter(r => r.satBull && r.morningRet < 0),        'Sam↑ + Matin↓');
stats(results.filter(r => !r.satBull && r.morningRet < 0),       'Sam↓ + Matin↓');
stats(results.filter(r => !r.satBull && r.morningRet > 0),       'Sam↓ + Matin↑ (reversion)');

console.log('  ' + '─'.repeat(90));

// MEILLEUR COMBO
const bestCombo = results.filter(r => r.satBull && r.morningRet > 0 && r.entryVsDayOpen > -0.5);
stats(bestCombo, '★ Sam↑ + Matin↑ + pas suracheté');

const bestCombo2 = results.filter(r => !r.satBull && r.morningRet > 0 && r.b14ret > 0);
stats(bestCombo2, '★ Sam↓ + Matin↑ + b14↑ (rebound)');

// ══════════════════════════════════════════════════════════════════════════════
// 3. STRATÉGIES SPÉCIFIQUES
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── STRATÉGIES DÉTAILLÉES ────────────────────────────────────');

// Stratégie LONG : Sam haussier + Matin haussier
const stgLong = results.filter(r => r.satBull && r.morningRet > 0);
const stgLongRets = stgLong.map(r => r.slotRet);
const stgLongWin = stgLong.filter(r => r.slotBull).length;
console.log('\n  LONG — Condition : Sam clôture↑ ET matin dim 11-13h↑');
console.log(`    Occurrences   : ${stgLong.length}/${results.length} dimanches`);
console.log(`    Win rate      : ${(stgLongWin/stgLong.length*100).toFixed(0)}%`);
console.log(`    Rdt moyen     : ${avg(stgLongRets)>=0?'+':''}${avg(stgLongRets).toFixed(3)}%`);
console.log(`    Cumulé        : ${((stgLong.reduce((a,r)=>a*(1+r.slotRet/100),1)-1)*100).toFixed(1)}%`);
console.log(`    Max gain      : +${Math.max(...stgLongRets).toFixed(2)}%`);
console.log(`    Max perte     : ${Math.min(...stgLongRets).toFixed(2)}%`);
const avgWin14 = avg(stgLong.filter(r=>r.slotBull).map(r=>r.slotRet));
const avgLoss14 = avg(stgLong.filter(r=>!r.slotBull).map(r=>r.slotRet));
console.log(`    Gain moy win  : +${avgWin14.toFixed(3)}%`);
console.log(`    Perte moy loss: ${avgLoss14.toFixed(3)}%`);
console.log(`    R/R           : ${(avgWin14/Math.abs(avgLoss14)).toFixed(2)}:1`);

// Stratégie SHORT : Matin baissier quel que soit le sam
const stgShort = results.filter(r => r.morningRet < -0.3 && r.b14ret < 0);
const stgShortRets = stgShort.map(r => -r.slotRet); // short = inverse
const stgShortWin = stgShort.filter(r => !r.slotBull).length;
console.log('\n  SHORT — Condition : Matin 11-13h baissier (<-0.3%) ET b14h baissière');
console.log(`    Occurrences   : ${stgShort.length}/${results.length} dimanches`);
if (stgShort.length > 0) {
  console.log(`    Win rate      : ${(stgShortWin/stgShort.length*100).toFixed(0)}%`);
  console.log(`    Rdt moyen     : ${avg(stgShortRets)>=0?'+':''}${avg(stgShortRets).toFixed(3)}%`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. NIVEAUX D'ENTRÉE OPTIMAUX
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── NIVEAUX D\'ENTRÉE (bougie 14h) ───────────────────────────');

// Est-ce qu'entrer sur dip en début de 14h (low de 14h) est meilleur ?
const dipEntries = stgLong.map(r => {
  const retFromLow  = (r.slotClose - r.slotLow)  / r.slotLow  * 100;
  const retFromOpen = r.slotRet;
  return { retFromLow, retFromOpen, better: retFromLow > retFromOpen };
});
const dipBetter = dipEntries.filter(d => d.better).length;
console.log(`  Entrer sur le low de 14h est meilleur que l'open : ${(dipBetter/dipEntries.length*100).toFixed(0)}% des cas`);
console.log(`  Gain moyen en entrant sur l'open   : +${avg(dipEntries.map(d=>d.retFromOpen)).toFixed(3)}%`);
console.log(`  Gain moyen en entrant sur le low   : +${avg(dipEntries.map(d=>d.retFromLow)).toFixed(3)}%`);
console.log(`  Dip moyen sur la bougie 14h        : -${avg(stgLong.map(r=>(r.entry - r.slotLow)/r.entry*100)).toFixed(3)}%`);

// ══════════════════════════════════════════════════════════════════════════════
// 5. DÉTAIL DATE PAR DATE
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── HISTORIQUE (dimanches 14h–16h UTC) ──────────────────────');
console.log('Date       | Sam  | Matin | Slot 14-16h | 4H après | Signal');
console.log('-----------|------|-------|------------|----------|-------');
results.slice(-20).forEach(r => {
  const satStr  = r.satBull ? `+${r.satRet.toFixed(1)}%` : `${r.satRet.toFixed(1)}%`;
  const mStr    = r.morningRet >= 0 ? `+${r.morningRet.toFixed(2)}%` : `${r.morningRet.toFixed(2)}%`;
  const slotStr = r.slotRet >= 0 ? `+${r.slotRet.toFixed(2)}%` : `${r.slotRet.toFixed(2)}%`;
  const r4hStr  = r.ret4h != null ? (r.ret4h >= 0 ? `+${r.ret4h.toFixed(2)}%` : `${r.ret4h.toFixed(2)}%`) : 'N/A';
  const sig = r.satBull && r.morningRet > 0 ? '✅ LONG' : r.morningRet < -0.3 && !r.satBull ? '🔴 SHORT' : '—';
  console.log(`${r.date} | ${satStr.padStart(6)} | ${mStr.padStart(6)} | ${slotStr.padStart(8)}   | ${r4hStr.padStart(7)}  | ${sig}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. SYNTHÈSE
// ══════════════════════════════════════════════════════════════════════════════
const best = results.filter(r => r.satBull && r.morningRet > 0);
const bestWR = (best.filter(r=>r.slotBull).length/best.length*100).toFixed(0);
const bestRdt = avg(best.map(r=>r.slotRet)).toFixed(3);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  SETUP OPTIMAL — Dimanche 14h–16h UTC (16h–18h FR)');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`
  Direction    : LONG
  Conditions   :
    1. Samedi a clôturé haussier (close > open daily)
    2. Session 11h–13h UTC du dimanche est haussière

  Entrée       : Open de la bougie 14h UTC (16h FR)
                 Ou sur dip si -0.2% sous l'open de 14h
  Stop         : Sous le low de la bougie 13h UTC
  TP1          : +0.3% (15h UTC / 17h FR)
  TP2          : +0.6% (fin session 18h UTC / 20h FR)

  Performance (${best.length} occurrences) :
    Win rate   : ${bestWR}%
    Rdt moyen  : +${bestRdt}%
    Cumulé     : +${((best.reduce((a,r)=>a*(1+r.slotRet/100),1)-1)*100).toFixed(1)}%

  Fréquence    : ~${Math.round(best.length / (results.length / 4))} fois / mois
`);
console.log('═══════════════════════════════════════════════════════════════\n');
