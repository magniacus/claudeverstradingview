/**
 * FBO Monitor — surveille les zones FBO sur BTCUSD 4H
 * et envoie une alerte Telegram quand le prix y entre.
 */

import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'fbo_monitor_state.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Variables TELEGRAM_TOKEN et TELEGRAM_CHAT_ID requises');
  process.exit(1);
}
const CDP_PORT = 9222;
const CHECK_INTERVAL_MS = 60 * 1000; // toutes les minutes

// Zones FBO (4H - BTCUSDT Binance) recalculées une fois par jour à RECALC_LOCAL (heure locale du PC).
// Elles sont sauvegardées dans STATE_FILE : un redémarrage reprend les zones du jour sans recalculer.
// Si le monitor ne tournait pas à l'heure prévue, le calcul du jour est fait dès son démarrage.
const RECALC_LOCAL = { h: 8, m: 0 };
const SEND_DAILY_SUMMARY = true;    // envoie les nouvelles zones sur Telegram après chaque recalcul
const DRY_RUN = process.argv.includes('--zones');

// Paramètres de détection
const KLINES_LIMIT    = 500;  // bougies 4H récupérées (~83 jours)
const OB_LOOKBACK     = 180;  // bougies 4H scannées pour les OB et swings (~30 jours)
const DISPLACEMENT    = 2;    // impulsion minimale (en ATR) sur les 3 bougies suivant l'OB
const SWING_SIDE      = 3;    // fractale : 3 bougies de chaque côté
const ATR_LEN         = 14;

// Cooldown global : une seule alerte toutes les 4H, toutes zones confondues
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastAlertTime: 0 }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

let state = loadState();
// Persistés : state.lastAlertTime, state.zones, state.zonesDay (jour local YYYY-MM-DD du dernier calcul)
let FBO_ZONES = Array.isArray(state.zones) ? state.zones : [];
let zonesDay = FBO_ZONES.length ? state.zonesDay ?? null : null;

// Confirmation : nombre de checks consécutifs où le prix est dans la zone
// L'alerte n'est envoyée qu'après CONFIRM_COUNT checks (= 2 minutes)
const CONFIRM_COUNT = 2;
const zoneConfirm = new Map();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getPrice() {
  // Prix BTC/USDT depuis Binance
  const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
  return parseFloat(data.price);
}

// ── Calcul automatique des zones FBO ─────────────────────────────────────────

const fmt = n => Math.round(n).toLocaleString('fr-FR');

async function getKlines4h() {
  const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=${KLINES_LIMIT}`);
  if (!Array.isArray(rows)) throw new Error('Klines Binance invalides');
  // La dernière bougie est en cours : on la retire pour ne travailler que sur des bougies clôturées
  return rows.slice(0, -1).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

function computeZones(k, price) {
  const N = k.length;
  const tr = k.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - k[i - 1].c), Math.abs(b.l - k[i - 1].c)) : b.h - b.l);
  const atrAt = i => { const s = tr.slice(Math.max(0, i - ATR_LEN + 1), i + 1); return s.reduce((a, b) => a + b) / s.length; };
  const atr = atrAt(N - 1);
  const start = Math.max(SWING_SIDE, N - OB_LOOKBACK);

  // Swings fractals confirmés
  const highs = [], lows = [];
  for (let i = start; i < N - SWING_SIDE; i++) {
    const w = k.slice(i - SWING_SIDE, i + SWING_SIDE + 1);
    if (k[i].h === Math.max(...w.map(b => b.h))) highs.push(k[i].h);
    if (k[i].l === Math.min(...w.map(b => b.l))) lows.push(k[i].l);
  }

  // Order blocks : dernière bougie opposée avant une impulsion >= DISPLACEMENT ATR sur 3 bougies,
  // non invalidés (aucune clôture au-delà de leur bord opposé depuis)
  const bulls = [], bears = [];
  for (let i = start; i < N - 3; i++) {
    const a = atrAt(i), next = k.slice(i + 1, i + 4), after = k.slice(i + 4);
    const up = Math.max(...next.map(b => b.h)) - k[i].h;
    const dn = k[i].l - Math.min(...next.map(b => b.l));
    if (k[i].c < k[i].o && up >= DISPLACEMENT * a) {
      const z = { low: k[i].l, high: Math.max(k[i].o, k[i].c) };
      if (!after.some(b => b.c < z.low)) bulls.push(z);
    }
    if (k[i].c > k[i].o && dn >= DISPLACEMENT * a) {
      const z = { low: Math.min(k[i].o, k[i].c), high: k[i].h };
      if (!after.some(b => b.c > z.high)) bears.push(z);
    }
  }

  // Cibles : premier swing à >= 1,5 ATR du bord de la zone, puis le suivant à >= 1 ATR plus loin
  const targetsDown = from => {
    const s = [...new Set(lows)].filter(p => p <= from - 1.5 * atr).sort((a, b) => b - a);
    const tp1 = s[0] ?? from - 2 * atr;
    return [tp1, s.find(p => p <= tp1 - atr) ?? tp1 - 1.5 * atr];
  };
  const targetsUp = from => {
    const s = [...new Set(highs)].filter(p => p >= from + 1.5 * atr).sort((a, b) => a - b);
    const tp1 = s[0] ?? from + 2 * atr;
    return [tp1, s.find(p => p >= tp1 + atr) ?? tp1 + 1.5 * atr];
  };
  const rr = (low, high, stop, tp2) => {
    const mid = (low + high) / 2;
    return (Math.abs(tp2 - mid) / Math.abs(mid - stop)).toFixed(1) + ':1';
  };
  const zone = (name, bias, low, high, stop, tp1, tp2) => ({
    name, bias, low: Math.round(low), high: Math.round(high),
    entry: `${fmt(low)} – ${fmt(high)}`, stop: fmt(stop), tp1: fmt(tp1), tp2: fmt(tp2),
    rr: rr(low, high, stop, tp2),
  });

  const zones = [];
  const bear = bears.filter(z => z.high >= price).sort((a, b) => a.low - b.low)[0];
  const bull = bulls.filter(z => z.low <= price).sort((a, b) => b.high - a.high)[0];

  if (bear) {
    // Stop au-dessus des sommets proches (liquidité), sinon 1,5 ATR au-dessus de la zone
    const near = highs.filter(p => p > bear.high && p <= bear.high + 2 * atr);
    const stop = (near.length ? Math.max(...near) : bear.high + 1.4 * atr) + 0.1 * atr;
    const [tp1, tp2] = targetsDown(bear.low);
    zones.push(zone('🔴 FBO Baissier — Résistance OB', 'SHORT', bear.low, bear.high, stop, tp1, tp2));
  }
  if (bull) {
    const near = lows.filter(p => p < bull.low && p >= bull.low - 2 * atr);
    const stop = (near.length ? Math.min(...near) : bull.low - 1.4 * atr) - 0.1 * atr;
    const [tp1, tp2] = targetsUp(bull.high);
    zones.push(zone('🟢 FBO Haussier — Support OB', 'LONG', bull.low, bull.high, stop, tp1, tp2));
  }

  // Liquidity sweep : sous le groupe de creux le plus proche en dessous du support (ou du prix)
  const ref = bull ? bull.low : price;
  const below = [...new Set(lows)].filter(p => p < ref - 0.5 * atr).sort((a, b) => b - a);
  if (below.length) {
    const cluster = below.filter(p => p >= below[0] - 0.75 * atr);
    const level = Math.min(...cluster);
    const low = level - atr, high = level - 0.1 * atr;
    const stop = low - atr;
    const tp1 = bull ? bull.high : targetsUp(high)[0];
    const tp2 = targetsUp(tp1 - 1.5 * atr)[1];
    zones.push(zone('🟢 FBO Haussier Profond — Liquidity Sweep', 'LONG', low, high, stop, tp1, tp2));
  }

  return { zones, atr };
}

async function recalcZones() {
  const [klines, price] = await Promise.all([getKlines4h(), getPrice()]);
  const { zones, atr } = computeZones(klines, price);
  if (!zones.length) throw new Error('aucune zone détectée');
  FBO_ZONES = zones;
  zonesDay = localDay();
  zoneConfirm.clear();
  if (!DRY_RUN) saveState(Object.assign(state, { zones: FBO_ZONES, zonesDay }));

  console.log(`[${new Date().toISOString()}] Zones recalculées (prix ${fmt(price)}, ATR14 ${fmt(atr)}) :`);
  FBO_ZONES.forEach(z => console.log(`  • ${z.name}: ${z.low} – ${z.high} | stop ${z.stop} | TP ${z.tp1} / ${z.tp2} | R/R ${z.rr}`));

  if (SEND_DAILY_SUMMARY && !DRY_RUN) {
    const lines = FBO_ZONES.map(z => `${z.name}\n   ${z.entry} · stop ${z.stop} · TP ${z.tp1} / ${z.tp2} · R/R ${z.rr}`);
    await sendTelegram(`📐 <b>Zones FBO du jour — BTCUSD 4H</b>\n\n💰 Prix : ${fmt(price)} $ · ATR14 : ${fmt(atr)}\n\n${lines.join('\n\n')}`);
  }
}

// Jour local au format YYYY-MM-DD
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Recalcul si aucune zone n'est connue, ou si l'heure du jour est passée et que les zones datent d'un jour précédent
function recalcDue() {
  const now = new Date();
  const pastTime = now.getHours() * 60 + now.getMinutes() >= RECALC_LOCAL.h * 60 + RECALC_LOCAL.m;
  return zonesDay === null || (zonesDay !== localDay(now) && pastTime);
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${text}&parse_mode=HTML`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function buildAlert(zone, price) {
  return `⚡ <b>ALERTE FBO — BTCUSD 4H</b>

${zone.name}

💰 <b>Prix actuel :</b> ${price.toLocaleString()} $
📍 <b>Zone :</b> ${zone.low.toLocaleString()} – ${zone.high.toLocaleString()} $

📊 <b>Setup :</b>
• Direction : <b>${zone.bias}</b>
• Entrée : ${zone.entry}
• Stop : ${zone.stop}
• TP1 : ${zone.tp1}
• TP2 : ${zone.tp2}
• R/R : ${zone.rr}

⚠️ Attends la confirmation FBO (rejection + clôture hors zone) avant d'entrer.`;
}

async function check() {
  if (recalcDue()) {
    try { await recalcZones(); }
    catch (err) { console.error(`[${new Date().toISOString()}] Recalcul des zones échoué (${err.message}) — zones précédentes conservées`); }
  }
  if (!FBO_ZONES.length) return;

  try {
    const price = await getPrice();
    if (!price) { console.log(`[${new Date().toISOString()}] Prix non disponible`); return; }

    console.log(`[${new Date().toISOString()}] BTC: $${price.toLocaleString()}`);

    for (const zone of FBO_ZONES) {
      const inZone = price >= zone.low && price <= zone.high;
      const zoneKey = zone.name;

      if (inZone) {
        const count = (zoneConfirm.get(zoneKey) || 0) + 1;
        zoneConfirm.set(zoneKey, count);

        const cooldownOk = state.lastAlertDay !== localDay();

        if (count === CONFIRM_COUNT && cooldownOk) {
          console.log(`→ ZONE FBO CONFIRMÉE (${count} checks): ${zone.name}`);
          state.lastAlertTime = Date.now();
          state.lastAlertDay = localDay();
          saveState(state);
          await sendTelegram(buildAlert(zone, price));
          console.log('→ Alerte Telegram envoyée !');
        } else if (count < CONFIRM_COUNT) {
          console.log(`→ Zone ${zone.name} — confirmation ${count}/${CONFIRM_COUNT}`);
        } else if (!cooldownOk) {
          console.log(`→ Zone ${zone.name} — alerte déjà envoyée aujourd'hui`);
        }
      } else {
        // Prix sorti : reset le compteur de confirmation
        if (zoneConfirm.has(zoneKey)) {
          zoneConfirm.delete(zoneKey);
          console.log(`→ Prix sorti de la zone: ${zone.name}`);
        }
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Erreur: ${err.message}`);
  }
}

if (DRY_RUN) {
  // node scripts/fbo_monitor.js --zones : affiche les zones calculées puis quitte
  // (aucun envoi Telegram, zones sauvegardées inchangées)
  recalcZones().catch(err => { console.error(`Erreur: ${err.message}`); process.exit(1); });
} else {
  const hhmm = `${String(RECALC_LOCAL.h).padStart(2, '0')}:${String(RECALC_LOCAL.m).padStart(2, '0')}`;
  console.log('🚀 FBO Monitor démarré');
  console.log(`Recalcul des zones : une fois par jour à ${hhmm} (heure locale)`);
  if (FBO_ZONES.length) {
    console.log(`Zones sauvegardées du ${zonesDay} :`);
    FBO_ZONES.forEach(z => console.log(`  • ${z.name}: ${z.low} – ${z.high} | stop ${z.stop} | TP ${z.tp1} / ${z.tp2} | R/R ${z.rr}`));
  }
  console.log(`Vérification toutes les ${CHECK_INTERVAL_MS / 1000}s\n`);

  // Premier check immédiat (calcule les zones seulement si aucune n'est sauvegardée ou si celles du jour manquent après l'heure prévue)
  check();
  // Puis toutes les minutes
  setInterval(check, CHECK_INTERVAL_MS);
}
