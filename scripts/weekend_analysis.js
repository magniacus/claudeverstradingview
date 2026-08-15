import fs from 'fs';

const raw = JSON.parse(fs.readFileSync('scripts/btc_daily_raw.json', 'utf8'));

// Binance klines: [openTime, open, high, low, close, volume, ...]
const bars = raw.map(b => ({
  ts:     b[0],
  date:   new Date(b[0]).toISOString().slice(0,10),
  dow:    new Date(b[0]).getUTCDay(), // 0=Dim, 1=Lun, ..., 6=Sam
  open:   parseFloat(b[1]),
  high:   parseFloat(b[2]),
  low:    parseFloat(b[3]),
  close:  parseFloat(b[4]),
  volume: parseFloat(b[5]),
}));

const DOW = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];

// Rendement journalier
bars.forEach((b, i) => {
  b.ret = i > 0 ? (b.close - bars[i-1].close) / bars[i-1].close * 100 : 0;
  b.range = (b.high - b.low) / b.open * 100;
  b.bullish = b.close > b.open;
});

// ── 1. Stats par jour de la semaine ────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  ANALYSE BTC/USD — PATTERNS PAR JOUR DE SEMAINE');
console.log('  Données : 500 jours (Binance daily)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('─── RENDEMENT MOYEN PAR JOUR ────────────────────────────────');
console.log('Jour   | N  | Rdt moyen | % haussier | Range moy');
console.log('-------|----|-----------|-----------|-----------');
for (let d = 0; d < 7; d++) {
  const group = bars.slice(1).filter(b => b.dow === d);
  const n = group.length;
  const avgRet   = group.reduce((s,b) => s + b.ret, 0) / n;
  const pctBull  = group.filter(b => b.bullish).length / n * 100;
  const avgRange = group.reduce((s,b) => s + b.range, 0) / n;
  const flag = (d === 0 || d === 6) ? ' ←' : '';
  console.log(`${DOW[d].padEnd(6)} | ${String(n).padEnd(2)} | ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(2).padStart(5)}%   | ${pctBull.toFixed(0).padStart(5)}%      | ${avgRange.toFixed(2)}%${flag}`);
}

// ── 2. Stratégies Week-end ─────────────────────────────────────────────────
const saturdays = bars.slice(1).filter(b => b.dow === 6);
const sundays   = bars.slice(1).filter(b => b.dow === 0);
const weekends  = [...saturdays, ...sundays].sort((a,b) => a.ts - b.ts);

// Paire Sam+Dim : rendement cumulé sur le week-end entier
const weekendPairs = [];
for (let i = 0; i < bars.length - 1; i++) {
  if (bars[i].dow === 5) { // Vendredi
    const fri = bars[i];
    const sat = bars[i+1]?.dow === 6 ? bars[i+1] : null;
    const sun = sat && bars[i+2]?.dow === 0 ? bars[i+2] : null;
    if (sat && sun) {
      const wkRet = (sun.close - fri.close) / fri.close * 100;
      const satRet = sat.ret;
      const sunRet = sun.ret;
      weekendPairs.push({ date: fri.date, fri, sat, sun, wkRet, satRet, sunRet });
    }
  }
}

console.log('\n─── WEEK-ENDS COMPLETS (Ven clôture → Dim clôture) ─────────');
const posWk = weekendPairs.filter(w => w.wkRet > 0).length;
const avgWkRet = weekendPairs.reduce((s,w) => s + w.wkRet, 0) / weekendPairs.length;
console.log(`  N week-ends analysés : ${weekendPairs.length}`);
console.log(`  Rendement moyen Ven→Dim : ${avgWkRet >= 0 ? '+' : ''}${avgWkRet.toFixed(2)}%`);
console.log(`  % semaines haussières   : ${(posWk/weekendPairs.length*100).toFixed(0)}%`);

// ── 3. Stratégie A : Long samedi matin, sortie dimanche soir ──────────────
console.log('\n─── STRATÉGIE A : Long Sam ouverture → Dim clôture ─────────');
const stgA = weekendPairs.map(w => ({
  date: w.date,
  ret: (w.sun.close - w.sat.open) / w.sat.open * 100,
}));
const stgA_pos = stgA.filter(s => s.ret > 0).length;
const stgA_avg = stgA.reduce((s,b) => s + b.ret, 0) / stgA.length;
const stgA_cum = stgA.reduce((acc, b) => acc * (1 + b.ret/100), 1);
console.log(`  Win rate   : ${(stgA_pos/stgA.length*100).toFixed(0)}%`);
console.log(`  Rdt moyen  : ${stgA_avg >= 0 ? '+' : ''}${stgA_avg.toFixed(2)}%`);
console.log(`  Cumulé     : ${((stgA_cum-1)*100).toFixed(1)}%`);

// ── 4. Stratégie B : Long vendredi clôture → samedi clôture ──────────────
console.log('\n─── STRATÉGIE B : Long Ven clôture → Sam clôture ───────────');
const stgB = weekendPairs.map(w => ({ date: w.date, ret: w.satRet }));
const stgB_pos = stgB.filter(s => s.ret > 0).length;
const stgB_avg = stgB.reduce((s,b) => s + b.ret, 0) / stgB.length;
const stgB_cum = stgB.reduce((acc, b) => acc * (1 + b.ret/100), 1);
console.log(`  Win rate   : ${(stgB_pos/stgB.length*100).toFixed(0)}%`);
console.log(`  Rdt moyen  : ${stgB_avg >= 0 ? '+' : ''}${stgB_avg.toFixed(2)}%`);
console.log(`  Cumulé     : ${((stgB_cum-1)*100).toFixed(1)}%`);

// ── 5. Stratégie C : Short samedi si gap haussier vs vendredi ────────────
console.log('\n─── STRATÉGIE C : Short Sam si Sam.open > Ven.close ────────');
const stgC = weekendPairs.filter(w => w.sat.open > w.fri.close);
const stgC_trades = stgC.map(w => ({ date: w.date, ret: -w.satRet })); // short = inversé
const stgC_pos = stgC_trades.filter(s => s.ret > 0).length;
const stgC_avg = stgC_trades.reduce((s,b) => s + b.ret, 0) / stgC_trades.length;
console.log(`  Occurrences : ${stgC.length}/${weekendPairs.length}`);
console.log(`  Win rate    : ${(stgC_pos/stgC_trades.length*100).toFixed(0)}%`);
console.log(`  Rdt moyen   : ${stgC_avg >= 0 ? '+' : ''}${stgC_avg.toFixed(2)}%`);

// ── 6. Pattern heure d'entrée : Sam vs Dim ────────────────────────────────
console.log('\n─── CORRÉLATION SAM / DIM ───────────────────────────────────');
const sameTrend = weekendPairs.filter(w => (w.satRet > 0) === (w.sunRet > 0)).length;
console.log(`  Sam et Dim même direction : ${(sameTrend/weekendPairs.length*100).toFixed(0)}% du temps`);

const satUp_sunUp = weekendPairs.filter(w => w.satRet > 0 && w.sunRet > 0).length;
const satUp_sunDn = weekendPairs.filter(w => w.satRet > 0 && w.sunRet < 0).length;
const satDn_sunUp = weekendPairs.filter(w => w.satRet < 0 && w.sunRet > 0).length;
const satDn_sunDn = weekendPairs.filter(w => w.satRet < 0 && w.sunRet < 0).length;
console.log(`  Sam↑ → Dim↑ : ${satUp_sunUp} fois (${(satUp_sunUp/weekendPairs.length*100).toFixed(0)}%)`);
console.log(`  Sam↑ → Dim↓ : ${satUp_sunDn} fois (${(satUp_sunDn/weekendPairs.length*100).toFixed(0)}%)`);
console.log(`  Sam↓ → Dim↑ : ${satDn_sunUp} fois (${(satDn_sunUp/weekendPairs.length*100).toFixed(0)}%)`);
console.log(`  Sam↓ → Dim↓ : ${satDn_sunDn} fois (${(satDn_sunDn/weekendPairs.length*100).toFixed(0)}%)`);

// Stratégie D : si Sam haussier → Long Dim
console.log('\n─── STRATÉGIE D : Long Dim si Sam était haussier ────────────');
const stgD = weekendPairs.filter(w => w.satRet > 0).map(w => ({ date: w.date, ret: w.sunRet }));
const stgD_pos = stgD.filter(s => s.ret > 0).length;
const stgD_avg = stgD.reduce((s,b) => s + b.ret, 0) / stgD.length;
const stgD_cum = stgD.reduce((acc,b) => acc * (1 + b.ret/100), 1);
console.log(`  Occurrences : ${stgD.length}`);
console.log(`  Win rate    : ${(stgD_pos/stgD.length*100).toFixed(0)}%`);
console.log(`  Rdt moyen   : ${stgD_avg >= 0 ? '+' : ''}${stgD_avg.toFixed(2)}%`);
console.log(`  Cumulé      : ${((stgD_cum-1)*100).toFixed(1)}%`);

// Stratégie E : si Sam baissier → Long Dim (mean reversion)
console.log('\n─── STRATÉGIE E : Long Dim si Sam était baissier (reversion)');
const stgE = weekendPairs.filter(w => w.satRet < 0).map(w => ({ date: w.date, ret: w.sunRet }));
const stgE_pos = stgE.filter(s => s.ret > 0).length;
const stgE_avg = stgE.reduce((s,b) => s + b.ret, 0) / stgE.length;
const stgE_cum = stgE.reduce((acc,b) => acc * (1 + b.ret/100), 1);
console.log(`  Occurrences : ${stgE.length}`);
console.log(`  Win rate    : ${(stgE_pos/stgE.length*100).toFixed(0)}%`);
console.log(`  Rdt moyen   : ${stgE_avg >= 0 ? '+' : ''}${stgE_avg.toFixed(2)}%`);
console.log(`  Cumulé      : ${((stgE_cum-1)*100).toFixed(1)}%`);

// ── 7. Meilleurs / pires week-ends ────────────────────────────────────────
console.log('\n─── TOP 5 MEILLEURS WEEK-ENDS ───────────────────────────────');
[...weekendPairs].sort((a,b) => b.wkRet - a.wkRet).slice(0,5).forEach(w => {
  console.log(`  ${w.date}  Sam:${w.satRet >= 0?'+':''}${w.satRet.toFixed(1)}%  Dim:${w.sunRet >= 0?'+':''}${w.sunRet.toFixed(1)}%  Total:${w.wkRet >= 0?'+':''}${w.wkRet.toFixed(1)}%`);
});
console.log('\n─── TOP 5 PIRES WEEK-ENDS ───────────────────────────────────');
[...weekendPairs].sort((a,b) => a.wkRet - b.wkRet).slice(0,5).forEach(w => {
  console.log(`  ${w.date}  Sam:${w.satRet >= 0?'+':''}${w.satRet.toFixed(1)}%  Dim:${w.sunRet >= 0?'+':''}${w.sunRet.toFixed(1)}%  Total:${w.wkRet >= 0?'+':''}${w.wkRet.toFixed(1)}%`);
});

console.log('\n═══════════════════════════════════════════════════════════════\n');
