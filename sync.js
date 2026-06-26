/**
 * sync.js — LTC Transaction Sync (clean version)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ADDR = 'MM1rvJGE6izAai1xBeyBF1G4UgBNDiyimg';
const API = 'litecoinspace.org';

const DB_FILE = path.join(__dirname, 'db.json');
const TMP_FILE = path.join(__dirname, 'db.json.tmp');

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ENABLE_INTERVAL = false; // set false if using cron

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
            resolve({
              status: res.statusCode,
              body: JSON.parse(data)
            });
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
    transactions: [],
    lastSync: null,
    address: ADDR
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

    return res.body?.litecoin?.nzd
      ? parseFloat(res.body.litecoin.nzd)
      : null;
  } catch (e) {
    log('Price fetch failed: ' + e.message);
    return null;
  }
}

// ── transactions ────────────────────────────────────────

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
      log(`API returned ${res.status}`);
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

      for (const vout of tx.vout || []) {
        if (vout.scriptpubkey_address === ADDR) {
          sat += vout.value;
        }
      }

      if (sat > 0) {
        const ts = tx.status?.block_time
          ? new Date(tx.status.block_time * 1000).toISOString()
          : new Date().toISOString();

        newDeposits.push({
          hash: tx.txid,
          confirmed: ts,
          amountLTC: sat / 1e8
        });

        log(
          `Found deposit: ${(sat / 1e8).toFixed(4)} LTC — ${tx.txid.slice(
            0,
            16
          )}…`
        );
      }
    }

    if (hitKnown || txs.length < 25) break;

    lastTxid = txs[txs.length - 1].txid;
    await new Promise(r => setTimeout(r, 500));
  }

  return newDeposits;
}

// ── Git ────────────────────────────────────────────────

function gitCommitAndPush() {
  try {
    execSync('git add db.json');

    const status = execSync('git status --porcelain db.json')
      .toString()
      .trim();

    if (!status) {
      log('No Git changes to commit');
      return;
    }

    const msg = `Auto update ${new Date().toISOString()}`;

    execSync(`git commit -m "${msg}"`, { stdio: 'inherit' });
    execSync('git push origin main', { stdio: 'inherit' });

    log('Git push successful');
  } catch (err) {
    log('Git error: ' + err.message);
  }
}

// ── main sync ──────────────────────────────────────────

async function sync() {
  log('=== Starting sync ===');

  const db = loadDb();
  const knownHashes = new Set(db.transactions.map(t => t.hash));

  log(`${knownHashes.size} transactions already in database.`);

  const newDeposits = await fetchNewDeposits(knownHashes);
  log(`Found ${newDeposits.length} new deposit(s).`);

  const currentPrice = await fetchCurrentPrice();
  log(`Current LTC price: $${currentPrice} NZD`);

  for (const tx of newDeposits) {
    tx.priceNZD = currentPrice ? +currentPrice.toFixed(2) : null;
    tx.valueNZD = currentPrice
      ? +(tx.amountLTC * currentPrice).toFixed(2)
      : null;
  }

  if (newDeposits.length > 0 || currentPrice !== null) {
    db.transactions = [...db.transactions, ...newDeposits].sort(
      (a, b) => new Date(b.confirmed) - new Date(a.confirmed)
    );

    db.ltcPriceNZD = currentPrice;

    saveDb(db);
    gitCommitAndPush();
  } else {
    log('No meaningful updates — skipping save + git');
  }

  log(`Database saved. Total: ${db.transactions.length} transactions.`);
  log('=== Sync complete ===\n');
}

// ── run control ────────────────────────────────────────

sync().catch(e => log('Sync error: ' + e.message));

if (ENABLE_INTERVAL) {
  setInterval(() => {
    sync().catch(e => log('Sync error: ' + e.message));
  }, INTERVAL_MS);

  log('Sync scheduled every hour. Running now…');
}
