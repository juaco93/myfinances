'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { openDb } = require('../lib/db');
const { createFinance, ValidationError } = require('../lib/finance');
const { createFinanceRouter, bearerAuth } = require('../lib/finance-router');
const { createDocs } = require('../lib/bot-docs');

function setup() {
  const finance = createFinance(openDb(':memory:'));
  finance.seedDefaults();
  finance.setFxRate('2026-01-01', { mep: 1000 });
  finance.setFxRate('2026-02-01', { mep: 1200 });
  return finance;
}

test('ingest is idempotent by external_id and updates changed fields', () => {
  const finance = setup();
  const tx = { account_id: 'mercadopago-ars', date: '2026-01-10', amount: -5000, description: 'Pago en PedidosYa', external_id: 'mp:1' };
  assert.equal(finance.ingestTransactions([tx], 'bot').results[0].status, 'created');
  assert.equal(finance.ingestTransactions([tx], 'bot').results[0].status, 'unchanged');
  const updated = finance.ingestTransactions([{ ...tx, amount: -5500 }], 'bot').results[0];
  assert.equal(updated.status, 'updated');
  assert.deepEqual(updated.changed, ['amount']);
  assert.equal(finance.listTransactions().total, 1);
});

test('without external_id an identical movement is a duplicate unless allowed', () => {
  const finance = setup();
  const tx = { account_id: 'mercadopago-ars', date: '2026-01-10', amount: -1200, description: 'Café' };
  assert.equal(finance.ingestTransactions([tx], 'bot').results[0].status, 'created');
  assert.equal(finance.ingestTransactions([tx], 'bot').results[0].status, 'duplicate');
  assert.equal(finance.ingestTransactions([{ ...tx, allow_duplicate: true }], 'bot').results[0].status, 'created');
});

test('rules categorize, kind fixes the sign, and transfers stay out of cashflow', () => {
  const finance = setup();
  const { results } = finance.ingestTransactions([
    { account_id: 'mercadopago-ars', date: '2026-01-05', amount: -8000, description: 'Pago en PedidosYa' },
    { account_id: 'mercadopago-ars', date: '2026-01-06', amount: 3000, kind: 'expense', description: 'Uber viaje' },
    { account_id: 'mercadopago-ars', date: '2026-01-07', amount: -100000, description: 'Transferencia a Wallbit' },
    { account_id: 'mercadopago-ars', date: '2026-01-08', amount: 500000, description: 'Transferencia recibida', counterparty: 'Empresa SA' }
  ], 'bot');
  assert.equal(results[0].category, 'Comida y supermercado');
  assert.equal(results[1].category, 'Transporte');
  assert.match(results[1].warnings[0], /negativo/);
  assert.equal(results[2].kind, 'transfer');
  assert.equal(results[3].kind, 'income');
  const flow = finance.cashflow({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(flow.totals.expense_ars, 11000);
  assert.equal(flow.totals.income_ars, 500000);
  assert.equal(flow.totals.expense_usd, 11);
});

test('validation errors are per item and do not abort the batch', () => {
  const finance = setup();
  const { counts, results } = finance.ingestTransactions([
    { account_id: 'nope', date: '2026-01-01', amount: -1, description: 'x' },
    { account_id: 'wallbit', date: '2026-01-01', amount: '1.234,50', description: 'x' },
    { account_id: 'wallbit', date: '2026-01-01', amount: -10, currency: 'ARS', description: 'x' },
    { account_id: 'wallbit', date: '2026-01-02', amount: 25.5, description: 'Dividendo SPY' }
  ], 'bot');
  assert.deepEqual(counts, { error: 3, created: 1 });
  assert.match(results[0].errors[0], /cuenta inexistente/);
  assert.match(results[1].errors[0], /amount/);
  assert.match(results[2].errors[0], /USD/);
});

test('dry run reports results without saving', () => {
  const finance = setup();
  const out = finance.ingestTransactions([{ account_id: 'wallbit', date: '2026-01-02', amount: 10, description: 'x' }], 'bot', { dryRun: true });
  assert.equal(out.results[0].status, 'created');
  assert.equal(finance.listTransactions().total, 0);
});

test('manual category survives a re-send without explicit category', () => {
  const finance = setup();
  const tx = { account_id: 'mercadopago-ars', date: '2026-01-10', amount: -5000, description: 'Pago varios', external_id: 'mp:2' };
  const { id } = finance.ingestTransactions([tx], 'bot').results[0];
  finance.updateTransaction(id, { category: 'Regalos' }, 'ui');
  finance.ingestTransactions([{ ...tx, note: 'reenvío' }], 'bot');
  assert.equal(finance.getTransaction(id).category, 'Regalos');
  finance.addRule({ pattern: 'varios', category: 'Otra', direction: 'out', kind: 'expense', priority: 1 }, 'ui');
  finance.recategorize('ui');
  assert.equal(finance.getTransaction(id).category, 'Regalos');
});

test('balances: same instant corrects, net worth converts with the rate of the day', () => {
  const finance = setup();
  assert.equal(finance.addBalance({ account_id: 'wallbit', amount: 100, as_of: '2026-01-15' }, 'bot').status, 'created');
  assert.equal(finance.addBalance({ account_id: 'wallbit', amount: 100, as_of: '2026-01-15' }, 'bot').status, 'unchanged');
  assert.equal(finance.addBalance({ account_id: 'wallbit', amount: 150, as_of: '2026-01-15' }, 'bot').status, 'updated');
  finance.addBalance({ account_id: 'mercadopago-ars', amount: 240000, as_of: '2026-02-03' }, 'bot');
  const nw = finance.netWorth('2026-02-05');
  assert.equal(nw.usd, 150 + 200);
  assert.equal(nw.ars, 150 * 1200 + 240000);
  const history = finance.netWorthHistory({ to: '2026-02-05' }).points;
  assert.deepEqual(history.map(p => p.date), ['2026-01-15', '2026-02-03', '2026-02-05']);
  assert.equal(history[0].ars, 150000);
  assert.throws(() => finance.addBalance({ account_id: 'iol', amount: 1 }, 'bot'), ValidationError);
});

test('account currency cannot change once it has data', () => {
  const finance = setup();
  finance.addBalance({ account_id: 'wallbit', amount: 1 }, 'bot');
  assert.throws(() => finance.upsertAccount({ id: 'wallbit', currency: 'ARS' }, 'bot'), /moneda/);
  assert.equal(finance.upsertAccount({ id: 'efectivo-ars', institution: 'efectivo', name: 'Efectivo', currency: 'ARS', kind: 'efectivo' }, 'bot').status, 'created');
});

test('/api/v1 requires the bearer token; docs are public', async () => {
  const finance = setup();
  const app = express();
  app.use('/api/v1', createFinanceRouter(finance, { actor: 'bot', auth: bearerAuth(() => 'secret-token'), docs: createDocs({ baseUrl: 'http://x' }) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    assert.equal((await fetch(`${base}/accounts`)).status, 401);
    assert.equal((await fetch(`${base}/accounts`, { headers: { authorization: 'Bearer wrong-token!' } })).status, 401);
    assert.equal((await fetch(`${base}/guide`)).status, 200);
    assert.equal((await fetch(`${base}/openapi.json`)).status, 200);
    const ok = await fetch(`${base}/transactions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: [{ account_id: 'wallbit', date: '2026-01-02', amount: -3, description: 'fee' }] })
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).counts.created, 1);
    const bad = await fetch(`${base}/transactions?from=ayer`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('/api/v1 answers 503 when no token is configured', async () => {
  const app = express();
  app.use('/api/v1', createFinanceRouter(setup(), { actor: 'bot', auth: bearerAuth(() => undefined) }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/accounts`, { headers: { authorization: 'Bearer x' } });
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

test('seedDefaults adds local extra rules only to an empty rule table', () => {
  const finance = createFinance(openDb(':memory:'));
  finance.seedDefaults({ extraRules: [{ priority: 5, direction: 'out', category: 'Local', kind: 'expense', pattern: 'someone local' }] });
  const rules = finance.listRules();
  assert.ok(rules.some(r => r.category === 'Local' && r.pattern === 'someone local'));
  const count = rules.length;
  finance.seedDefaults({ extraRules: [{ priority: 6, category: 'Other', kind: 'expense', pattern: 'x' }] });
  assert.equal(finance.listRules().length, count);
});

test('rules can require an account, an amount range and days of the month', () => {
  const finance = createFinance(openDb(':memory:'));
  finance.seedDefaults();
  finance.addRule({ priority: 1, pattern: 'own name', direction: 'in', account_id: 'mercadopago-ars', min_amount: 1000, max_amount: 5000, day_from: 1, day_to: 5, category: 'Sueldo', kind: 'income' }, 'test');
  const send = (date, amount, account = 'mercadopago-ars') => finance.ingestTransactions([{ account_id: account, date, amount, counterparty: 'Own Name', description: 'Ingreso' }], 'bot', { source: 'bot' }).results[0];
  assert.equal(send('2026-11-02', 3000).category, 'Sueldo');
  assert.notEqual(send('2026-11-12', 3000).category, 'Sueldo', 'day 12 is outside 1-5');
  assert.notEqual(send('2026-11-03', 9000).category, 'Sueldo', 'above max_amount');
  assert.notEqual(send('2026-11-03', 3100, 'personal-pay-ars').category, 'Sueldo', 'other account');
  assert.throws(() => finance.addRule({ pattern: 'x', category: 'Y', day_from: 40 }, 'test'), /day_from/);
});

test('override rules beat the sender, but never manual edits or the expense sheet', () => {
  const finance = createFinance(openDb(':memory:'));
  finance.seedDefaults();
  const r = finance.ingestTransactions([
    { account_id: 'mercadopago-ars', date: '2026-10-13', amount: 2700000, kind: 'income', category: 'Ingresos', counterparty: 'Some Buyer', external_id: 'a' },
    { account_id: 'mercadopago-ars', date: '2026-10-14', amount: 50000, kind: 'income', category: 'Ingresos', counterparty: 'Friend', external_id: 'b' }
  ], 'bot', { source: 'bot' });
  assert.equal(r.results[0].category, 'Ingresos');
  finance.addRule({ priority: 47, pattern: '.', direction: 'in', account_id: 'mercadopago-ars', min_amount: 150000, category: 'Cambio de dólares', kind: 'transfer', override: true }, 'test');
  const moved = finance.recategorize('test');
  assert.equal(moved.changed, 1);
  const rows = finance.listTransactions({ accountId: 'mercadopago-ars' }).transactions;
  assert.equal(rows.find(t => t.external_id === 'a').kind, 'transfer');
  assert.equal(rows.find(t => t.external_id === 'b').category, 'Ingresos', 'below min_amount keeps the sender category');
  // A new movement is classified on arrival, even with an explicit kind.
  const fresh = finance.ingestTransactions([{ account_id: 'mercadopago-ars', date: '2026-10-20', amount: 1100000, kind: 'income', counterparty: 'Other Buyer', external_id: 'c' }], 'bot', { source: 'bot' });
  assert.equal(fresh.results[0].kind, 'transfer');
  // Manual edits survive a re-run.
  const id = rows.find(t => t.external_id === 'a').id;
  finance.updateTransaction(id, { category: 'Venta auto', kind: 'income' }, 'ui');
  finance.recategorize('test');
  assert.equal(finance.getTransaction(id).transaction?.category ?? finance.getTransaction(id).category, 'Venta auto');
});
