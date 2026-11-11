#!/usr/bin/env node
'use strict';

// Imports the categorized movements of the retired personal-gastos-dashboard
// (money-summary-data.json → "Detalle categorizado"). Idempotent via external_id.
// Usage: node scripts/import-legacy-gastos.js <money-summary-data.json> [--db path] [--dry-run]

const fs = require('fs');
const path = require('path');
const { openDb } = require('../lib/db');
const { createFinance } = require('../lib/finance');

const args = process.argv.slice(2);
const source = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--db');
if (!source) {
  console.error('usage: import-legacy-gastos.js <money-summary-data.json> [--db path] [--dry-run]');
  process.exit(2);
}
const dbArg = args.indexOf('--db');
const dbFile = dbArg > -1 ? args[dbArg + 1] : (process.env.FINANZAS_DB || path.join(__dirname, '..', 'data', 'finanzas.db'));
const dryRun = args.includes('--dry-run');

const rows = JSON.parse(fs.readFileSync(source, 'utf8')).sheets['Detalle categorizado'];

function accountFor(row) {
  if (row.Fuente === 'Personal Pay') return 'personal-pay-ars';
  if (row.Fuente === 'MercadoPago') return row.Moneda === 'USD' ? 'mercadopago-usd' : 'mercadopago-ars';
  throw new Error(`fuente desconocida: ${row.Fuente}`);
}

// The old sheet was expenses-only; map its categories onto income/expense/transfer/ignored.
function kindFor(row) {
  if (row.Categoria === 'No confirmado') return 'ignored';
  if (row.Categoria === 'Transferencia interna' || row.Categoria === 'Inversiones / ahorro') return 'transfer';
  return row.Monto < 0 ? 'expense' : 'income';
}

// "Ingresos" was the old sheet's catch-all for any inflow (it also swallowed transfers from
// own accounts and IOL withdrawals), so those rows go through the current rules instead.
const transactions = rows.map(row => ({
  ...(row.Categoria === 'Ingresos' ? {} : { kind: kindFor(row), category: row.Categoria, subcategory: row.Subcategoria || null }),
  account_id: accountFor(row),
  date: row.Fecha,
  amount: row.Monto,
  description: row.Descripcion || row.Titulo,
  counterparty: row.Titulo && row.Titulo !== row.Descripcion ? row.Titulo : null,
  external_id: `legacy-gastos:${row.Fuente}:${row['Fila origen']}`,
  note: row['Motivo categoria'] ? `Importado de personal-gastos (${row['Motivo categoria']})` : 'Importado de personal-gastos',
  raw: { estado: row.Estado, categoria_original: row['Categoria original'], subcategoria_original: row['Subcategoria original'], archivo: row['ID/Archivo'], link: row.Link }
}));

const finance = createFinance(openDb(dbFile));
finance.seedDefaults();
const result = finance.ingestTransactions(transactions, 'import', { dryRun, source: 'legacy-gastos', maxItems: Infinity });

const errors = result.results.filter(r => r.status === 'error');
console.log(JSON.stringify({ db: dbFile, dry_run: dryRun, rows: rows.length, counts: result.counts, errors: errors.slice(0, 10) }, null, 2));
if (errors.length) process.exitCode = 1;
