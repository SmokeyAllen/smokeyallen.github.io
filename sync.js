/**
 * sync.js — LTC Transaction Sync
 * Runs continuously, fetching new transactions every hour and saving to db.json.
 *
 * Setup:
 *   1. Install Node.js on your server
 *   2. Place this file in your website root (same folder as transactions.html)
 *   3. Run: node sync.js
 *   4. To keep it running permanently: pm2 start sync.js
 *      (install pm2 with: npm install -g pm2)
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ADDR    = 'MM1rvJGE6izAai1xBeyBF1G4UgBNDiyimg';
const API     = 'litecoinspace.org';
const DB_FILE = path.join(__dirname, 'db.json');
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ── Helpers ──────────────────────────────────────────────────────────────────

function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'smokeyallen-ltc-tracker/1.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading db.json:', e.message);
  }
  return { transactions: [], lastSync: null, address: ADDR };
}

function saveDb(db) {
  db.lastSync = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Fetch NZD price ───────────────────────────────────────────────────────────

async function fetchPrice() {
  try {
    // CoinGecko free API — no key required, works from Node.js
    const res = await get(
      'api.coingecko.com',
      '/api/v3/simple/price?ids=litecoin&vs_currencies=nzd'
    );
    const price = res.body?.litecoin?.nzd;
    return price ? parseFloat(price) : null;
  } catch (e) {
    log('Price fetch failed: ' + e.message);
    return null;
  }
}

// ── Fetch new transactions ────────────────────────────────────────────────────

async function fetchNewDeposits(knownHashes) {
  const newDeposits = [];
  let lastTxid = null;
  let page = 0;

  while (true) {
    page++;
    const apiPath = lastTxid
      ? `/api/address/${ADDR}/txs/chain/${lastTxid}`
      : `/api/address/${ADDR}/txs`;

    log(`Fetching page ${page}: ${apiPath}`);

    let res;
    try {
      res = await get(API, apiPath);
    } catch (e) {
      log('Fetch error: ' + e.message);
      break;
    }

    if (res.status !== 200) {
      log(`API returned status ${res.status}`);
      break;
    }

    const txs = res.body;
    if (!Array.isArray(txs) || txs.length === 0) break;

    let hitKnown = false;
    for (const tx of txs) {
      if (knownHashes.has(tx.txid)) {
        hitKnown = true;
        break;
      }

      let sat = 0;
      for (const vout of (tx.vout || [])) {
        if (vout.scriptpubkey_address === ADDR) sat += vout.value;
      }

      if (sat > 0) {
        const ts = tx.status?.block_time
          ? new Date(tx.status.block_time * 1000).toISOString()
          : new Date().toISOString();
        newDeposits.push({ hash: tx.txid, confirmed: ts, amountLTC: sat / 1e8 });
        log(`  Found deposit: ${(sat / 1e8).toFixed(4)} LTC — ${tx.txid.slice(0, 16)}…`);
      }
    }

    if (hitKnown || txs.length < 25) break;
    lastTxid = txs[txs.length - 1].txid;

    // Small delay between pages to be a good API citizen
    await new Promise(r => setTimeout(r, 500));
  }

  return newDeposits;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

async function sync() {
  log('=== Starting sync ===');

  const db = loadDb();
  const knownHashes = new Set(db.transactions.map(t => t.hash));
  log(`${knownHashes.size} transactions already in database.`);

  const newDeposits = await fetchNewDeposits(knownHashes);
  log(`Found ${newDeposits.length} new deposit(s).`);

  if (newDeposits.length > 0) {
    db.transactions = [...db.transactions, ...newDeposits]
      .sort((a, b) => new Date(b.confirmed) - new Date(a.confirmed));
  }

  db.ltcPriceNZD = await fetchPrice();
  log(`LTC price: $${db.ltcPriceNZD} NZD`);

  saveDb(db);
  log(`Database saved. Total: ${db.transactions.length} transactions.`);
  log('=== Sync complete ===\n');
}

// ── Run immediately, then every hour ─────────────────────────────────────────

sync().catch(e => log('Sync error: ' + e.message));
setInterval(() => {
  sync().catch(e => log('Sync error: ' + e.message));
}, INTERVAL_MS);

log(`Sync scheduled every ${INTERVAL_MS / 60000} minutes. Running now…`);
