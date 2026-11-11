#!/usr/bin/env node
'use strict';

// Backfills fx_rates and the auto balances (iol, virtual-ars, cripto-usdt) from data/snapshots/*.json.
// Idempotent: re-running updates the same rows. Usage: node scripts/import-snapshots.js [--db path]

const fs = require('fs');
const path = require('path');
const { openDb, transaction } = require('../lib/db');
const { createFinance } = require('../lib/finance');

const root = path.join(__dirname, '..');
const dbArg = process.argv.indexOf('--db');
const dbFile = dbArg > -1 ? process.argv[dbArg + 1] : (process.env.FINANZAS_DB || path.join(root, 'data', 'finanzas.db'));
const snapshotDir = path.join(root, 'data', 'snapshots');

const db = openDb(dbFile);
const finance = createFinance(db);
finance.seedDefaults();

const files = fs.readdirSync(snapshotDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const counts = { fx: 0, balances: {} };

transaction(db, () => {
  for (const file of files) {
    const snap = JSON.parse(fs.readFileSync(path.join(snapshotDir, file), 'utf8'));
    const date = snap.date || file.slice(0, 10);
    const mep = Number(snap.dollarMep) || null;
    if (mep) {
      finance.setFxRate(date, { mep, ccl: snap.dollarCcl }, 'snapshot-import');
      counts.fx++;
    }
    const cash = snap.cash || {};
    const virtual = snap.virtual || {};
    const holdingsValue = Number(snap.holdingsValue);
    const balances = [];
    if (Number.isFinite(holdingsValue)) {
      balances.push({ account_id: 'iol', amount: holdingsValue + (Number(cash.ars) || 0) + (mep ? (Number(cash.usd) || 0) * mep : 0) });
    }
    if (snap.virtual) balances.push({ account_id: 'virtual-ars', amount: (Number(virtual.ars) || 0) + (mep ? (Number(virtual.usd) || 0) * mep : 0) });
    if (snap.crypto) balances.push({ account_id: 'cripto-usdt', amount: Number(snap.crypto.usdt) || 0 });
    for (const balance of balances) {
      const result = finance.addBalance({ ...balance, as_of: date, source: 'snapshot-import' }, 'import');
      counts.balances[result.status] = (counts.balances[result.status] || 0) + 1;
    }
  }
});

console.log(JSON.stringify({ db: dbFile, snapshots: files.length, ...counts }, null, 2));
