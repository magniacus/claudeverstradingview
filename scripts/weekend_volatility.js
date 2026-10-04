import fs from 'fs';

const bars1h = JSON.parse(fs.readFileSync('scripts/btc_1h_raw.json', 'utf8'))
  .map(b => ({
    ts:     b[0],
    hour:   new Date(b[0]).getUTCHours(),
    dow:    new Date(b[0]).getUTCDay(),   // 0=Dim, 6=Sam
    open:   +b[1], high: +b[2], low: +b[3], close: +b[4],
    range:  (+b[2] - +b[3]) / +b[1] * 100,         // (H-L)/O %
    ret:    (+b[4] - +b[1]) / +b[1] * 100,          // body %
    wick:   (+b[2] - +b[4]) / +b[1] * 100,          // upper wick %
  }));

const saturday = bars1h.filter(b => b.dow === 6);
const sunday   = bars1h.filter(b => b.dow === 0);

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function std(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length);
}
function max(arr) { return arr.length ? Math.max(...arr) : 0; }
function pct(arr, fn) { return (arr.filter(fn).length / arr.length * 100); }

// ── Stats par heure pour chaque jour ─────────────────────────────────────────
function statsByHour(bars) {
  const hours = {};
  for (let h = 0; h < 24; h++) {
    const group = bars.filter(b => b.hour === h);
    if (!group.length) { hours[h] = null; continue; }
    const ranges  = group.map(b => b.range);
    const rets    = group.map(b => Math.abs(b.ret));
    const bodies  = group.map(b => b.ret);
    hours[h] = {
      n:          group.length,
      avgRange:   avg(ranges),
      maxRange:   max(ranges),
      stdRange:   std(ranges),
      avgBody:    avg(rets),
      pctBull:    pct(group, b => b.close > b.open),
      pctBig:     pct(group, b => b.range > 0.3),   // bougie "active" > 0.3%
    };
  }
  return hours;
}

const sat = statsByHour(saturday);
const sun = statsByHour(sunday);

// ── Classement global week-end par volatilité ─────────────────────────────────
const allWE = bars1h.filter(b => b.dow === 0 || b.dow === 6);
const globalByHour = statsByHour(allWE);

function bar(val, max, len = 20) {
  const filled = Math.round(val / max * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

const maxRange = Math.max(...Object.values(globalByHour).filter(Boolean).map(s => s.avgRange));

// ── Affichage ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  VOLATILITÉ HORAIRE BTC — WEEK-END (Samedi + Dimanche)');
console.log(`  Données 1H Binance — ${saturday.length + sunday.length} bougies analysées`);
console.log('═══════════════════════════════════════════════════════════════════');

console.log('\n─── VOLATILITÉ GLOBALE WEEK-END (Sam + Dim combinés) ────────────');
console.log('Heure UTC | N   | Range moy | Max range | Std  | >0.3% | Visuel');
console.log('----------|-----|-----------|-----------|------|-------|' + '─'.repeat(22));
for (let h = 0; h < 24; h++) {
  const s = globalByHour[h];
  if (!s) continue;
  const flag = s.avgRange >= 0.20 ? ' ◀ ACTIF' : s.avgRange <= 0.10 ? ' zzz' : '';
  console.log(
    `${String(h).padStart(2)}h00 UTC | ${String(s.n).padEnd(3)} | ` +
    `${s.avgRange.toFixed(3)}%    | ${s.maxRange.toFixed(2)}%     | ` +
    `${s.stdRange.toFixed(3)} | ${s.pctBig.toFixed(0).padStart(3)}%   | ` +
    `${bar(s.avgRange, maxRange)}${flag}`
  );
}

console.log('\n─── COMPARAISON SAMEDI vs DIMANCHE ──────────────────────────────');
console.log('Heure UTC |    SAMEDI          |    DIMANCHE');
console.log('          | Range  | >0.3% | ↑% | Range  | >0.3% | ↑%');
console.log('----------|--------|-------|----|---------|----|----');
for (let h = 0; h < 24; h++) {
  const s = sat[h], d = sun[h];
  if (!s || !d) continue;
  const flagS = s.avgRange > 0.20 ? '★' : ' ';
  const flagD = d.avgRange > 0.20 ? '★' : ' ';
  console.log(
    `${String(h).padStart(2)}h00 UTC | ${flagS}${s.avgRange.toFixed(3)}% | ${s.pctBig.toFixed(0).padStart(3)}%   | ${s.pctBull.toFixed(0)}% | ` +
    `${flagD}${d.avgRange.toFixed(3)}% | ${d.pctBig.toFixed(0).padStart(3)}%   | ${d.pctBull.toFixed(0)}%`
  );
}

// ── Top sessions ───────────────────────────────────────────────────────────────
console.log('\n─── CLASSEMENT PAR VOLATILITÉ (Week-end global) ─────────────────');
const ranked = Object.entries(globalByHour)
  .filter(([,s]) => s)
  .sort(([,a],[,b]) => b.avgRange - a.avgRange);

console.log('Rang | Heure UTC | Range moy | Bougies actives');
ranked.forEach(([h, s], i) => {
  const stars = i < 3 ? ['🔥','🔶','🟡'][i] : '  ';
  console.log(`  ${String(i+1).padStart(2)} | ${String(h).padStart(2)}h00 UTC  | ${s.avgRange.toFixed(3)}%    | ${s.pctBig.toFixed(0)}% > 0.3%   ${stars}`);
});

// ── Sessions identifiées ────────────────────────────────────────────────────
console.log('\n─── IDENTIFICATION DES SESSIONS ─────────────────────────────────');
const zones = [
  { label: 'Nuit Asia (00-06h)',  hours: [0,1,2,3,4,5] },
  { label: 'Asia/Londres (06-10h)', hours: [6,7,8,9] },
  { label: 'Londres (10-14h)',    hours: [10,11,12,13] },
  { label: 'Overlap (14-17h)',    hours: [14,15,16] },
  { label: 'New York (17-21h)',   hours: [17,18,19,20] },
  { label: 'Nuit NY (21-24h)',    hours: [21,22,23] },
];

console.log('Session              | Range moy Sam | Range moy Dim | Verdict');
console.log('---------------------|---------------|---------------|--------');
zones.forEach(z => {
  const sRanges = z.hours.flatMap(h => saturday.filter(b => b.hour === h).map(b => b.range));
  const dRanges = z.hours.flatMap(h => sunday.filter(b => b.hour === h).map(b => b.range));
  const sAvg = avg(sRanges).toFixed(3);
  const dAvg = avg(dRanges).toFixed(3);
  const verdict = Math.max(+sAvg, +dAvg) >= 0.20 ? '✅ TRADABLE' :
                  Math.max(+sAvg, +dAvg) >= 0.15 ? '⚠️  Faible'  : '❌ Éviter';
  console.log(`${z.label.padEnd(21)}| ${sAvg}%         | ${dAvg}%         | ${verdict}`);
});

console.log('\n─── RÉSUMÉ ───────────────────────────────────────────────────────');
const top3 = ranked.slice(0,3).map(([h]) => `${h}h UTC`).join(', ');
const bot3 = ranked.slice(-3).map(([h]) => `${h}h UTC`).join(', ');
console.log(`  🔥 Heures les plus volatiles : ${top3}`);
console.log(`  💤 Heures les plus calmes    : ${bot3}`);
console.log('═══════════════════════════════════════════════════════════════════\n');
