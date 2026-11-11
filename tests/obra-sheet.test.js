'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../lib/db');
const { createFinance } = require('../lib/finance');
const { parseRows, parseAmount, parseDate, payeeOf } = require('../lib/obra-sheet');

const ACCOUNTS = { ARS: 'obra-ars', USD: 'obra-usd' };

function setup() {
  const finance = createFinance(openDb(':memory:'));
  finance.seedDefaults();
  finance.ensureAccount({ id: 'obra-ars', institution: 'obra', name: 'Obra (pesos)', currency: 'ARS', auto_source: 'obra-sheet' });
  finance.ensureAccount({ id: 'obra-usd', institution: 'obra', name: 'Obra (dólares)', currency: 'USD', auto_source: 'obra-sheet' });
  return finance;
}

const sheet = [
  ['10/11/2026', 'Ladrillos', 'Cerramiento casa', 'Materiales', 450000, '', 'Transferencia Mercado Pago a Juan Perez (Banco X). Operación 187852785735.', ''],
  ['11/11/2026', 'Pallet de cemento', 'Cerramiento casa', 'materiales ', ' $570.000,00', '', 'Efectivo', ''],
  ['19/06/2025', 'Compra lote', 'Papeles/Tramites', '', '', '$43.000,00', '33k transf + 10k cash', '#REF!'],
  ['12/11/2026', 'Flete', 'Obrador', 'Materiales', 20000, '', '', ''],
  ['12/11/2026', 'Flete', 'Obrador', 'Materiales', 20000, '', '', ''],
  ['', '', '', '', ' $127.253.007,61', '$54.530,00']
];

test('parseAmount and parseDate read the sheet formats', () => {
  assert.equal(parseAmount(450000), 450000);
  assert.equal(parseAmount(' $1.058.481,00'), 1058481);
  assert.equal(parseAmount('$43.000'), 43000);
  assert.equal(parseAmount('US$ 1.250,50'), 1250.5);
  assert.equal(parseAmount('(1.000,50)'), -1000.5);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseDate('19/06/2025'), '2025-06-19');
  assert.equal(parseDate('1/2/2026'), '2026-02-01');
  assert.equal(parseDate('31/13/2025'), null);
  assert.equal(parseDate(''), null);
  assert.equal(payeeOf('Transferencia Mercado Pago a Juan Perez (Banco X). Operación 1.'), 'Juan Perez');
});

test('parseRows skips the totals row, splits currencies and keys repeated rows apart', () => {
  const rows = parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' });
  assert.equal(rows.length, 5);
  const lote = rows.find(r => r.description === 'Compra lote');
  assert.equal(lote.currency, 'USD');
  assert.equal(lote.account_id, 'obra-usd');
  assert.equal(lote.amount, -43000);
  const ladrillos = rows.find(r => r.description === 'Ladrillos');
  assert.equal(ladrillos.counterparty, 'Juan Perez');
  assert.equal(ladrillos.raw.op_id, '187852785735');
  assert.equal(rows.find(r => r.description === 'Pallet de cemento').subcategory, 'Cerramiento casa / Materiales');
  const fletes = rows.filter(r => r.description === 'Flete').map(r => r.external_id);
  assert.equal(new Set(fletes).size, 2);
  assert.match(fletes[0], /:0$/);
  assert.match(fletes[1], /:1$/);
});

test('reconcileSource inserts, keeps, and deletes rows that left the sheet', () => {
  const finance = setup();
  const rows = parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' });
  let counts = finance.reconcileSource({ source: 'obra-sheet', rows });
  assert.equal(counts.created, 5);
  counts = finance.reconcileSource({ source: 'obra-sheet', rows });
  assert.equal(counts.unchanged, 5);
  assert.equal(counts.created, 0);
  counts = finance.reconcileSource({ source: 'obra-sheet', rows: rows.slice(0, 4) });
  assert.equal(counts.deleted, 1);
  const flow = finance.cashflow({ from: '2026-11-01', to: '2026-11-30' });
  assert.equal(flow.categories.find(c => c.category === 'Obra').ars, 450000 + 570000 + 20000);
});

test('reconcileSource refuses to wipe most rows at once', () => {
  const finance = setup();
  const rows = parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' });
  finance.reconcileSource({ source: 'obra-sheet', rows });
  assert.throws(() => finance.reconcileSource({ source: 'obra-sheet', rows: rows.slice(0, 1) }), /no se borra nada/);
  assert.equal(finance.listTransactions({ accountId: 'obra-ars' }).total, 4);
});

test('linkPayments counts a matching transfer once and releases it when the row goes away', () => {
  const finance = setup();
  const rows = parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' });
  finance.reconcileSource({ source: 'obra-sheet', rows });
  const ingest = finance.ingestTransactions([
    { account_id: 'mercadopago-ars', date: '2026-11-11', amount: -450000, description: 'Transferencia enviada', counterparty: 'Juan Perez', external_id: 'mp-1' },
    { account_id: 'mercadopago-ars', date: '2026-11-20', amount: -570000, description: 'Transferencia enviada', counterparty: 'Otra persona', external_id: 'mp-2' },
    { account_id: 'mercadopago-ars', date: '2026-11-12', amount: -20000, description: 'Uber viaje', external_id: 'mp-3' }
  ], 'bot', { source: 'bot' });
  assert.equal(ingest.counts.created, 3);
  const categories = ['Transferencias a personas', 'Construccion casa'];

  let links = finance.linkPayments({ source: 'obra-sheet', categories });
  assert.equal(links.linked, 1);
  const linked = finance.listTransactions({ accountId: 'mercadopago-ars' }).transactions;
  const mp1 = linked.find(t => t.external_id === 'mp-1');
  assert.equal(mp1.kind, 'transfer');
  assert.equal(mp1.category, 'Pago de obra');
  assert.equal(linked.find(t => t.external_id === 'mp-2').kind, 'expense', 'nine days apart: not the same payment');
  assert.equal(linked.find(t => t.external_id === 'mp-3').kind, 'expense', 'a ride is not a construction payment');

  links = finance.linkPayments({ source: 'obra-sheet', categories });
  assert.equal(links.linked, 0, 'idempotent');

  finance.reconcileSource({ source: 'obra-sheet', rows: rows.filter(r => r.description !== 'Ladrillos') });
  links = finance.linkPayments({ source: 'obra-sheet', categories });
  assert.equal(links.released, 1);
  const released = finance.listTransactions({ accountId: 'mercadopago-ars' }).transactions.find(t => t.external_id === 'mp-1');
  assert.equal(released.kind, 'expense');
  assert.equal(released.category, 'Transferencias a personas');
});

test('nobody but the sheet sync can write to the sheet accounts', () => {
  const finance = setup();
  const result = finance.ingestTransactions([{ account_id: 'obra-ars', date: '2026-11-11', amount: -1000, description: 'Cemento' }], 'bot', { source: 'bot' });
  assert.equal(result.counts.error, 1);
  assert.match(result.results[0].errors[0], /planilla de la obra/);
});

test('cashflow breaks sheet expenses down by stage and type, and movements filter by either', () => {
  const finance = setup();
  finance.reconcileSource({ source: 'obra-sheet', rows: parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' }) });
  const flow = finance.cashflow({ from: '2026-11-01', to: '2026-11-30' });
  const obra = flow.breakdown.filter(b => b.category === 'Obra');
  const cerramiento = obra.filter(b => b.group === 'Cerramiento casa');
  assert.deepEqual(cerramiento.map(b => b.type), ['Materiales']);
  assert.equal(cerramiento[0].ars, 450000 + 570000);
  assert.equal(obra.find(b => b.group === 'Obrador').ars, 40000);
  assert.equal(finance.listTransactions({ subcategory: 'Cerramiento casa' }).total, 2);
  assert.equal(finance.listTransactions({ subcategory: 'Materiales' }).total, 4);
  assert.equal(finance.listTransactions({ subcategory: 'Cerramiento casa / Materiales' }).total, 2);
  assert.equal(finance.listTransactions({ subcategory: 'Cerr%' }).total, 0, 'LIKE wildcards are escaped');
});

test('override rules never touch the sheet rows', () => {
  const finance = setup();
  finance.reconcileSource({ source: 'obra-sheet', rows: parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' }) });
  finance.addRule({ priority: 1, pattern: 'juan perez|.', category: 'Pago de obra', kind: 'transfer', override: true }, 'test');
  finance.recategorize('test');
  finance.reconcileSource({ source: 'obra-sheet', rows: parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' }) });
  const rows = finance.listTransactions({ accountId: 'obra-ars' }).transactions;
  assert.ok(rows.length > 0);
  assert.ok(rows.every(t => t.category === 'Obra' && t.kind === 'expense'));
});

test('the sheet sync leaves round-trip links alone', () => {
  const finance = setup();
  finance.reconcileSource({ source: 'obra-sheet', rows: parseRows(sheet, { accounts: ACCOUNTS, category: 'Obra' }) });
  finance.ingestTransactions([
    { account_id: 'mercadopago-ars', date: '2026-10-13', amount: 2700000, counterparty: 'Buyer', description: 'Transferencia recibida', external_id: 'in' },
    { account_id: 'mercadopago-ars', date: '2026-10-13', amount: -2700000, counterparty: 'Buyer', description: 'Transferencia enviada', external_id: 'out' }
  ], 'bot', { source: 'bot' });
  assert.equal(finance.linkRoundTrips().pairs, 1);
  const links = finance.linkPayments({ source: 'obra-sheet', categories: ['Transferencias a personas'] });
  assert.equal(links.released, 0);
  assert.equal(finance.listTransactions({}).transactions.find(t => t.external_id === 'out').kind, 'transfer');
});
