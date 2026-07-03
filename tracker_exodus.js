/**
 * sync-mate.js — LTC Transaction Sync for tracked wallet
 * Tracks all sends and receives for a given address.
 * Only fetches transactions newer than the last known sync.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ADDR = 'LcULoCvNwP4eVAe3ChgVZWkHRr5t4VVGs6';
const API  = 'litecoinspace.org';

const DB_FILE  = path.join(__dirname, 'db-exodus.json');

const TMP_FILE = path.join(__dirname, 'db-exodus.json.tmp');

const ENABLE_INTERVAL = false; // set true to poll; otherwise use cron
const INTERVAL_MS     = 60 * 60 * 1000; // 1 hour

// ── logging ─────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── HTTP helper ─────────────────────────────────────────

function get(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'GET',
        headers: { 'User-Agent': 'ltc-sync/1.0' }
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error('JSON parse error: ' + data.slice(0, 120)));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// ── DB ──────────────────────────────────────────────────

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    log('DB read error: ' + e.message);
  }

  return {
    address: ADDR,
    transactions: [],
    lastSync: null,
    ltcPriceNZD: null
  };
}

// atomic write (prevents corruption on crash)
function saveDb(db) {
  db.lastSync = new Date().toISOString();
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, DB_FILE);
}

// ── price ───────────────────────────────────────────────

async function fetchCurrentPrice() {
  try {
    const res = await get(
      'api.coingecko.com',
      '/api/v3/simple/price?ids=litecoin&vs_currencies=nzd'
    );
    return res.body?.litecoin?.nzd ? parseFloat(res.body.litecoin.nzd) : null;
  } catch (e) {
    log('Price fetch failed: ' + e.message);
    return null;
  }
}

// ── transactions ─────────────────────────────────────────
//
// Strategy: page through the API until we hit a tx we already know,
// or until the tx's block_time is older than our last sync cutoff.
// This means on subsequent runs we only process new txs — we never
// re-download the full history.

async function fetchNewTransactions(knownHashes, cutoffDate) {
  const newTxs  = [];
  let lastTxid  = null;
  let page      = 0;
  const cutoffMs = cutoffDate ? new Date(cutoffDate).getTime() : 0;

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
      log(`API returned ${res.status}`);
      break;
    }

    const txs = res.body;
    if (!Array.isArray(txs) || txs.length === 0) break;

    let reachedKnown = false;

    for (const tx of txs) {
      // Stop if we've already stored this tx
      if (knownHashes.has(tx.txid)) {
        reachedKnown = true;
        break;
      }

      // Stop if this confirmed tx is older than our last sync
      const blockTime = tx.status?.block_time;
      if (blockTime && cutoffMs > 0 && blockTime * 1000 < cutoffMs) {
        reachedKnown = true;
        break;
      }

      // Only process confirmed transactions
      if (!tx.status?.confirmed) {
        log(`Skipping unconfirmed tx: ${tx.txid.slice(0, 16)}…`);
        continue;
      }

      const ts = new Date(blockTime * 1000).toISOString();

      // --- received: outputs sent TO our address ---
      let receivedSat = 0;
      for (const vout of tx.vout || []) {
        if (vout.scriptpubkey_address === ADDR) {
          receivedSat += vout.value;
        }
      }

      // --- sent: inputs FROM our address ---
      let sentSat = 0;
      for (const vin of tx.vin || []) {
        if (vin.prevout?.scriptpubkey_address === ADDR) {
          sentSat += vin.prevout.value;
        }
      }

      // Net from the address's perspective (positive = net receive, negative = net send)
      const netSat = receivedSat - sentSat;

      // Classify direction
      let direction;
      if (sentSat > 0 && receivedSat > 0) {
        direction = netSat >= 0 ? 'receive' : 'send'; // change output common in sends
      } else if (sentSat > 0) {
        direction = 'send';
      } else {
        direction = 'receive';
      }

      const entry = {
        hash:        tx.txid,
        confirmed:   ts,
        direction,
        amountLTC:   +(Math.abs(netSat) / 1e8).toFixed(8),
        receivedLTC: +(receivedSat / 1e8).toFixed(8),
        sentLTC:     +(sentSat / 1e8).toFixed(8),
        // priceNZD and valueNZD added in main sync
      };

      newTxs.push(entry);
      log(
        `Found ${direction}: ${entry.amountLTC.toFixed(4)} LTC (net) — ${tx.txid.slice(0, 16)}…`
      );
    }

    if (reachedKnown || txs.length < 25) break;

    lastTxid = txs[txs.length - 1].txid;
    await new Promise(r => setTimeout(r, 500));
  }

  return newTxs;
}

// ── Git ─────────────────────────────────────────────────

function gitCommitAndPush() {
  try {
    execSync('git add db-exodus.json');

    const status = execSync('git status --porcelain db-exodus.json')

      .toString()
      .trim();

    if (!status) {
      log('No Git changes to commit');
      return;
    }

    const msg = `Auto update ${new Date().toISOString()}`;
    execSync(`git commit -m "${msg}"`, { stdio: 'inherit' });
    execSync('git pull --rebase origin main', { stdio: 'inherit' });
    execSync('git push origin main', { stdio: 'inherit' });

    log('Git push successful');
  } catch (err) {
    log('Git error: ' + err.message);
  }
}

// ── main sync ────────────────────────────────────────────

async function sync() {
  log('=== Starting sync ===');

  const db          = loadDb();
  const knownHashes = new Set(db.transactions.map(t => t.hash));

  log(`Tracking address : ${ADDR}`);
  log(`Known transactions: ${knownHashes.size}`);
  log(`Last sync        : ${db.lastSync ?? 'never (first run)'}`);

  // On the first run cutoffDate is null → we fetch everything.
  // On subsequent runs we stop as soon as we hit the cutoff timestamp,
  // so we never re-download the full history.
  const newTxs = await fetchNewTransactions(knownHashes, db.lastSync);
  log(`Found ${newTxs.length} new transaction(s).`);

  const currentPrice = await fetchCurrentPrice();
  log(`Current LTC price: $${currentPrice ?? 'unavailable'} NZD`);

  for (const tx of newTxs) {
    tx.priceNZD = currentPrice ? +currentPrice.toFixed(2) : null;
    tx.valueNZD = currentPrice
      ? +(tx.amountLTC * currentPrice).toFixed(2)
      : null;
  }

  if (newTxs.length > 0 || currentPrice !== null) {
    db.transactions = [...db.transactions, ...newTxs].sort(
      (a, b) => new Date(b.confirmed) - new Date(a.confirmed)
    );
    db.ltcPriceNZD = currentPrice;

    saveDb(db);
    gitCommitAndPush();
  } else {
    log('No meaningful updates — skipping save + git');
  }

  log(`Total transactions stored: ${db.transactions.length}`);
  log('=== Sync complete ===\n');
}

// ── run control ──────────────────────────────────────────

sync().catch(e => log('Sync error: ' + e.message));

if (ENABLE_INTERVAL) {
  setInterval(() => {
    sync().catch(e => log('Sync error: ' + e.message));
  }, INTERVAL_MS);

  log('Sync scheduled every hour. Running now…');
}
