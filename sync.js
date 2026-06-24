/**
 * sync.js — LTC Transaction Sync
 * Runs every hour, fetching new transactions and saving to db.json.
 * Stores the NZD price at time of each deposit.
 *
 * Setup:
 *   1. Place this file alongside db.json and transactions.html
 *   2. Run: node sync.js
 *   3. To keep running permanently: pm2 start sync.js
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ADDR        = 'MM1rvJGE6izAai1xBeyBF1G4UgBNDiyimg';
const API         = 'litecoinspace.org';
const DB_FILE     = path.join(__dirname, 'db.json');
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method: 'GET', headers: { 'User-Agent': 'smokeyallen-ltc-tracker/1.0' } },
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('Error reading db.json:', e.message); }
  return { transactions: [], lastSync: null, address: ADDR };
}

function saveDb(db) {
  db.lastSync = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Fetch current NZD price ───────────────────────────────────────────────────

async function fetchCurrentPrice() {
  try {
    const res = await get('api.coingecko.com', '/api/v3/simple/price?ids=litecoin&vs_currencies=nzd');
    return res.body?.litecoin?.nzd ? parseFloat(res.body.litecoin.nzd) : null;
  } catch (e) {
    log('Price fetch failed: ' + e.message);
    return null;
  }
}

// ── Fetch new deposits ────────────────────────────────────────────────────────

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
    try { res = await get(API, apiPath); }
    catch (e) { log('Fetch error: ' + e.message); break; }

    if (res.status !== 200) { log(`API returned ${res.status}`); break; }

    const txs = res.body;
    if (!Array.isArray(txs) || txs.length === 0) break;

    let hitKnown = false;
    for (const tx of txs) {
      if (knownHashes.has(tx.txid)) { hitKnown = true; break; }

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
    await new Promise(r => setTimeout(r, 500));
  }

  return newDeposits;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

async function sync() {
  log('=== Starting sync ===');

  const db          = loadDb();
  const knownHashes = new Set(db.transactions.map(t => t.hash));
  log(`${knownHashes.size} transactions already in database.`);

  const newDeposits = await fetchNewDeposits(knownHashes);
  log(`Found ${newDeposits.length} new deposit(s).`);

  // Fetch current price once and stamp it onto every new deposit
  const currentPrice = await fetchCurrentPrice();
  log(`Current LTC price: $${currentPrice} NZD`);

  for (const tx of newDeposits) {
    tx.priceNZD = currentPrice ? parseFloat(currentPrice.toFixed(2)) : null;
    tx.valueNZD = currentPrice ? parseFloat((tx.amountLTC * currentPrice).toFixed(2)) : null;
  }

  if (newDeposits.length > 0) {
    db.transactions = [...db.transactions, ...newDeposits]
      .sort((a, b) => new Date(b.confirmed) - new Date(a.confirmed));
  }

  db.ltcPriceNZD = currentPrice;
  saveDb(db);

  log(`Database saved. Total: ${db.transactions.length} transactions.`);
  log('=== Sync complete ===\n');
}

sync().catch(e => log('Sync error: ' + e.message));
setInterval(() => sync().catch(e => log('Sync error: ' + e.message)), INTERVAL_MS);
log(`Sync scheduled every hour. Running now…`);
