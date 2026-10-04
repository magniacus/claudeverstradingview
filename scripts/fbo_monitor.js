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

// Zones FBO identifiées (4H - BTCUSD)
const FBO_ZONES = [
  {
    name: '🔴 FBO Baissier — Résistance OB',
    high: 64579,
    low: 64361,
    bias: 'SHORT',
    entry: '64 400 – 64 580',
    stop: '65 000',
    tp1: '63 380',
    tp2: '63 000',
    rr: '2.5:1',
  },
  {
    name: '🟢 FBO Haussier — Support OB',
    high: 63400,
    low: 63177,
    bias: 'LONG',
    entry: '63 200 – 63 400',
    stop: '62 900',
    tp1: '64 066',
    tp2: '64 579',
    rr: '2:1',
  },
  {
    name: '🟢 FBO Haussier Profond — Liquidity Sweep',
    high: 62200,
    low: 61900,
    bias: 'LONG',
    entry: '61 900 – 62 200',
    stop: '61 139',
    tp1: '63 380',
    tp2: '64 361',
    rr: '3:1',
  },
];

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
// Raccourci : state.lastAlertTime est le timestamp persisté

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

        const cooldownOk = Date.now() - state.lastAlertTime >= ALERT_COOLDOWN_MS;

        if (count === CONFIRM_COUNT && cooldownOk) {
          console.log(`→ ZONE FBO CONFIRMÉE (${count} checks): ${zone.name}`);
          state.lastAlertTime = Date.now();
          saveState(state);
          await sendTelegram(buildAlert(zone, price));
          console.log('→ Alerte Telegram envoyée !');
        } else if (count < CONFIRM_COUNT) {
          console.log(`→ Zone ${zone.name} — confirmation ${count}/${CONFIRM_COUNT}`);
        } else if (!cooldownOk) {
          const remainMin = Math.round((ALERT_COOLDOWN_MS - (Date.now() - state.lastAlertTime)) / 60000);
          console.log(`→ Zone ${zone.name} — cooldown global actif (encore ${remainMin} min)`);
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

console.log('🚀 FBO Monitor démarré');
console.log('Zones surveillées:');
FBO_ZONES.forEach(z => console.log(`  • ${z.name}: ${z.low} – ${z.high}`));
console.log(`Vérification toutes les ${CHECK_INTERVAL_MS / 1000}s\n`);

// Premier check immédiat
check();
// Puis toutes les minutes
setInterval(check, CHECK_INTERVAL_MS);
