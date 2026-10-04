/**
 * NASDAQ Level Monitor
 * Détecte les approches de niveaux ronds (x000, x250, x500, x750) lors de retracements.
 * Intègre les points pivots mensuels pour la notation étoiles.
 *
 * Notation :
 *  ⭐⭐⭐⭐⭐  Niveau x750 + pivot mensuel proche
 *  ⭐⭐⭐⭐    Niveau x750
 *  ⭐⭐⭐      Niveau x000 / x250 / x500 + pivot mensuel proche
 *  ⭐⭐        Niveau x000 / x250 / x500
 */

import https from 'https';

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Variables TELEGRAM_TOKEN et TELEGRAM_CHAT_ID requises');
  process.exit(1);
}
const SYMBOL           = 'NQ=F';            // Yahoo Finance — pivots mensuels uniquement
// Prix temps réel : Stooq (nq.f) — pas de délai contrairement à Yahoo
const CHECK_INTERVAL   = 60 * 1000;         // toutes les minutes
const APPROACH_DIST    = 30;                 // points : distance pour déclencher l'alerte
const PIVOT_PROXIMITY  = 80;                 // points : un pivot est "proche" du niveau

// Etat interne
const alertedLevels = new Map();  // levelKey → timestamp dernier envoi
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1h entre deux alertes sur le même niveau
let prevPrice = null;
let lastDirection = null; // 'up' | 'down'

// ── API Yahoo Finance ─────────────────────────────────────────────────────────

function yahooGet(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

// ── Prix temps réel NQ via Stooq (pas de délai, gratuit) ─────────────────────
// Stooq retourne le prix spot des futures sans le délai de 15min de Yahoo
function stooqGet(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    const req = https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data.trim()));
    }).on('error', reject);
    // Stooq peut ne jamais répondre → abandon après 10s pour basculer sur Yahoo
    req.setTimeout(10000, () => req.destroy(new Error('Stooq timeout')));
  });
}

async function getPrice() {
  // Stooq : @nq.f = E-mini NQ Futures (@ requis pour les futures CME sur Stooq)
  // colonnes avec sd2t2ohlcv : Symbol, Date, Time, Open, High, Low, Close, Volume
  // Erreur réseau Stooq (timeout, etc.) → csv vide → fallback Yahoo
  const csv = await stooqGet('https://stooq.com/q/l/?s=%40nq.f&f=sd2t2ohlcv&h&e=csv').catch(() => '');
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2 || lines[1].includes('N/D')) {
    // Fallback Yahoo Finance si Stooq indisponible
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1m&range=1d`;
    const data = await yahooGet(url);
    const chart = data?.chart?.result?.[0];
    if (!chart) throw new Error('Prix NQ indisponible (Stooq + Yahoo)');
    const meta = chart.meta;
    const closes = chart.indicators?.quote?.[0]?.close ?? [];
    let price = meta.regularMarketPrice;
    if (!price || isNaN(price)) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) { price = closes[i]; break; }
      }
    }
    if (!price) throw new Error('Prix NQ introuvable');
    return { price, name: 'NQ1! Futures (Yahoo fallback)' };
  }
  const cols = lines[1].split(',');
  const close = parseFloat(cols[6]);
  if (isNaN(close)) throw new Error('Stooq: prix invalide → ' + lines[1]);
  return { price: close, name: 'NQ1! Futures (Stooq)' };
}

async function getMonthlyPivots() {
  // Récupère les 2 derniers mois pour obtenir le mois précédent complet
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=1mo&range=3mo`;
  const data = await yahooGet(url);
  const chart = data?.chart?.result?.[0];
  if (!chart) throw new Error('Chart not found');

  const { open, high, low, close } = chart.indicators.quote[0];
  // Prendre l'avant-dernier élément = mois précédent complet
  const idx = high.length - 2;
  const H = high[idx], L = low[idx], C = close[idx];
  const P  = (H + L + C) / 3;
  const R1 = 2 * P - L;
  const R2 = P + (H - L);
  const R3 = H + 2 * (P - L);
  const S1 = 2 * P - H;
  const S2 = P - (H - L);
  const S3 = L - 2 * (H - P);

  return [
    { name: 'S3', value: S3 }, { name: 'S2', value: S2 }, { name: 'S1', value: S1 },
    { name: 'PP', value: P  },
    { name: 'R1', value: R1 }, { name: 'R2', value: R2 }, { name: 'R3', value: R3 },
  ].filter(p => p.value && !isNaN(p.value));
}

// ── Détection des niveaux ─────────────────────────────────────────────────────

function getNearbyLevels(price) {
  // Cherche tous les niveaux ronds dans ±1500 points du prix
  const levels = [];
  const base = Math.round(price / 250) * 250;
  for (let offset = -6; offset <= 6; offset++) {
    const lvl = base + offset * 250;
    const dist = price - lvl;          // positif = prix au-dessus du niveau
    const absDist = Math.abs(dist);
    if (absDist <= APPROACH_DIST) {
      const modulo = Math.round(lvl) % 1000;
      const normalized = ((modulo % 1000) + 1000) % 1000;
      let type;
      if (normalized === 750)                    type = '750';
      else if (normalized === 0)                 type = '000';
      else if (normalized === 500)               type = '500';
      else if (normalized === 250)               type = '250';
      else continue;

      levels.push({ level: lvl, dist, absDist, type, approaching: dist > 0 ? 'from_above' : 'from_below' });
    }
  }
  return levels;
}

function isRetracement(level, price, direction) {
  // Seulement les retracements baissiers : prix descend depuis le dessus vers le niveau
  if (!direction) return level.approaching === 'from_above';
  return direction === 'down' && level.approaching === 'from_above';
}

function getStars(levelType, hasPivot) {
  if (levelType === '750' && hasPivot)  return 5;
  if (levelType === '750')              return 4;
  if (hasPivot)                         return 3;
  return 2;
}

function starsEmoji(n) { return '⭐'.repeat(n); }

// ── Telegram ─────────────────────────────────────────────────────────────────

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildAlert(price, level, stars, pivotNear, direction, pivots) {
  const dir = direction === 'down' ? '📉 Retracement baissier' : '📈 Retracement haussier';
  const lvlStr = level.level.toLocaleString();
  const dist = Math.abs(level.dist).toFixed(1);
  const approach = level.approaching === 'from_above' ? 'par le dessus ↓' : 'par le dessous ↑';

  let pivotLine = '';
  if (pivotNear) {
    const near = pivots
      .filter(p => Math.abs(p.value - level.level) <= PIVOT_PROXIMITY)
      .map(p => `${p.name} @ ${p.value.toFixed(0)}`)
      .join(', ');
    pivotLine = `\n🎯 <b>Pivot mensuel proche :</b> ${near}`;
  }

  return `<b>Alerte Scalping Nasdaq Andlil ${starsEmoji(stars)}</b>

📍 <b>Niveau :</b> ${lvlStr} (x${level.type})
💰 <b>Prix actuel :</b> ${price.toFixed(1)}
📏 <b>Distance :</b> ${dist} pts${pivotLine}

<i>Retracement baissier — surveille le rebond sur ce niveau.</i>`;
}

// ── Boucle principale ─────────────────────────────────────────────────────────

let pivots = [];
let pivotsLoadedAt = 0;

async function refreshPivots() {
  try {
    pivots = await getMonthlyPivots();
    pivotsLoadedAt = Date.now();
    console.log(`[Pivots mensuels] ${pivots.map(p => `${p.name}:${p.value.toFixed(0)}`).join(' | ')}`);
  } catch (e) {
    console.error(`[Pivots] Erreur: ${e.message}`);
  }
}

async function check() {
  try {
    // Rafraîchit les pivots une fois par heure
    if (Date.now() - pivotsLoadedAt > 3600 * 1000) await refreshPivots();

    const { price } = await getPrice();
    if (!price || isNaN(price)) { console.log('Prix indisponible'); return; }

    // Détermine la direction courante
    const direction = prevPrice !== null ? (price < prevPrice ? 'down' : 'up') : null;
    if (prevPrice !== null && Math.abs(price - prevPrice) > 0.5) lastDirection = direction;
    prevPrice = price;

    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] NQ: ${price.toFixed(1)} | dir: ${lastDirection || '?'}`);

    const nearbyLevels = getNearbyLevels(price);

    for (const level of nearbyLevels) {
      if (!isRetracement(level, price, lastDirection)) continue;

      const levelKey = `${level.level}_${lastDirection}`;
      const lastAlert = alertedLevels.get(levelKey) || 0;
      if (Date.now() - lastAlert < ALERT_COOLDOWN) continue;

      const nearPivot = pivots.some(p => Math.abs(p.value - level.level) <= PIVOT_PROXIMITY);
      const stars = getStars(level.type, nearPivot);

      console.log(`  → Niveau ${level.level} (x${level.type}) — ${stars}⭐ | pivot:${nearPivot}`);

      alertedLevels.set(levelKey, Date.now());
      await sendTelegram(buildAlert(price, level, stars, nearPivot, lastDirection, pivots));
      console.log(`  → Alerte Telegram envoyée (${stars}⭐)`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Erreur: ${e.message}`);
  }
}

// ── Démarrage ────────────────────────────────────────────────────────────────

console.log('🚀 NASDAQ Level Monitor démarré');
console.log(`Symbole     : NQ1! Futures (Stooq — temps réel)`);
console.log(`Seuil       : ±${APPROACH_DIST} pts du niveau`);
console.log(`Pivot prox. : ±${PIVOT_PROXIMITY} pts`);
console.log(`Cooldown    : 1h par niveau`);
console.log(`Niveaux     : x000 / x250 / x500 / x750`);
console.log(`\nNotation :`);
console.log(`  ⭐⭐⭐⭐⭐  x750 + pivot mensuel proche`);
console.log(`  ⭐⭐⭐⭐    x750`);
console.log(`  ⭐⭐⭐      x000/x250/x500 + pivot mensuel`);
console.log(`  ⭐⭐        x000/x250/x500`);
console.log('');

refreshPivots().then(() => {
  check();
  setInterval(check, CHECK_INTERVAL);
});
