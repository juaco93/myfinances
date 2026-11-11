'use strict';

// node:sqlite is still flagged experimental on Node 22; the warning is noise in pm2 logs.
const originalEmit = process.emit;
process.emit = function emitWithoutSqliteWarning(name, data, ...rest) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/.test(data.message)) {
    return false;
  }
  return originalEmit.call(this, name, data, ...rest);
};

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Each entry upgrades the schema by one version. Append only; never edit a shipped step.
const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    institution TEXT NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('ARS', 'USD', 'USDT')),
    kind TEXT NOT NULL DEFAULT 'cuenta' CHECK (kind IN ('cuenta', 'inversion', 'cripto', 'efectivo')),
    auto_source TEXT,
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW_SQL}
  );

  CREATE TABLE balances (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    as_of TEXT NOT NULL,
    amount REAL NOT NULL,
    source TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_SQL}
  );
  CREATE INDEX balances_account_as_of ON balances(account_id, as_of);

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'ignored')),
    description TEXT NOT NULL DEFAULT '',
    counterparty TEXT,
    category TEXT,
    subcategory TEXT,
    category_source TEXT,
    external_id TEXT,
    fingerprint TEXT NOT NULL,
    note TEXT,
    source TEXT NOT NULL,
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
    updated_at TEXT NOT NULL DEFAULT ${NOW_SQL}
  );
  CREATE UNIQUE INDEX transactions_external ON transactions(account_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX transactions_date ON transactions(date);
  CREATE INDEX transactions_fingerprint ON transactions(account_id, fingerprint);

  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY,
    priority INTEGER NOT NULL,
    pattern TEXT NOT NULL,
    direction TEXT CHECK (direction IN ('in', 'out')),
    category TEXT NOT NULL,
    subcategory TEXT,
    kind TEXT CHECK (kind IN ('income', 'expense', 'transfer', 'ignored')),
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE fx_rates (
    date TEXT PRIMARY KEY,
    mep REAL,
    ccl REAL,
    oficial REAL,
    source TEXT,
    updated_at TEXT NOT NULL DEFAULT ${NOW_SQL}
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT ${NOW_SQL},
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  `,
  // v2: payments that an external expense sheet already counts (e.g. a MercadoPago transfer
  // to a builder) point at that sheet row, so they are shown but not counted twice.
  `
  ALTER TABLE transactions ADD COLUMN linked_to TEXT;
  CREATE INDEX transactions_source ON transactions(source);
  CREATE INDEX transactions_linked ON transactions(linked_to) WHERE linked_to IS NOT NULL;
  `,
  // v3: rules can be limited to an account, an amount range and a range of days of the month,
  // and "override" rules win over the category or kind that the sender of a movement chose.
  `
  ALTER TABLE category_rules ADD COLUMN account_id TEXT;
  ALTER TABLE category_rules ADD COLUMN min_amount REAL;
  ALTER TABLE category_rules ADD COLUMN max_amount REAL;
  ALTER TABLE category_rules ADD COLUMN day_from INTEGER;
  ALTER TABLE category_rules ADD COLUMN day_to INTEGER;
  ALTER TABLE category_rules ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
  `
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { openDb, transaction };
