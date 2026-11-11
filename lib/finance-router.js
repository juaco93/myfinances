'use strict';

const crypto = require('crypto');
const express = require('express');
const { ValidationError } = require('./finance');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerAuth(getToken) {
  return (req, res, next) => {
    const expected = getToken();
    if (!expected) {
      return res.status(503).json({ error: 'FINANZAS_API_TOKEN no está configurado en el servidor' });
    }
    const header = req.get('authorization') || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.get('x-api-key') || '').trim();
    if (!provided || !tokenMatches(provided, expected)) {
      return res.status(401).json({ error: 'token inválido o ausente (header Authorization: Bearer <token>)' });
    }
    return next();
  };
}

function dateParam(req, name) {
  const value = req.query[name];
  if (value == null || value === '') return undefined;
  if (!DATE_RE.test(String(value))) throw new ValidationError(`${name}: usar YYYY-MM-DD`);
  return String(value);
}

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id inválido');
  return id;
}

function listFromBody(body, key) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  if (body && typeof body === 'object' && Object.keys(body).length) return [body];
  throw new ValidationError(`body: objeto, array o { "${key}": [...] }`);
}

const wrap = handler => (req, res) => {
  try {
    const result = handler(req, res);
    if (result !== undefined) res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, errors: error.errors });
    console.error('finance api error:', error);
    return res.status(500).json({ error: error.message });
  }
};

function createFinanceRouter(finance, { actor, auth, docs }) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  if (docs) {
    router.get('/openapi.json', (req, res) => res.json(docs.openapi()));
    router.get('/guide', (req, res) => res.type('text/markdown; charset=utf-8').send(docs.guide()));
  }
  if (auth) router.use(auth);

  router.get('/health', wrap(() => ({ ok: true, actor, today: require('./finance').todayAr() })));

  router.get('/accounts', wrap(req => ({ accounts: finance.listAccounts({ includeArchived: req.query.include_archived === 'true' }) })));
  router.post('/accounts', wrap((req, res) => {
    const result = finance.upsertAccount(req.body || {}, actor);
    res.status(result.status === 'created' ? 201 : 200);
    return result;
  }));
  router.patch('/accounts/:accountId', wrap(req => {
    if (!finance.getAccount(req.params.accountId)) {
      const error = new Error(`cuenta ${req.params.accountId} no existe`);
      error.status = 404;
      throw error;
    }
    return finance.upsertAccount({ ...(req.body || {}), id: req.params.accountId }, actor);
  }));

  router.get('/balances', wrap(req => ({
    balances: finance.listBalances({ accountId: req.query.account_id, from: dateParam(req, 'from'), to: dateParam(req, 'to'), limit: req.query.limit })
  })));
  router.post('/balances', wrap(req => {
    const results = finance.addBalances(listFromBody(req.body, 'balances'), actor);
    return { results };
  }));
  router.delete('/balances/:id', wrap(req => finance.deleteBalance(idParam(req), actor)));

  router.get('/transactions', wrap(req => finance.listTransactions({
    from: dateParam(req, 'from'),
    to: dateParam(req, 'to'),
    accountId: req.query.account_id,
    institution: req.query.institution,
    category: req.query.category,
    subcategory: req.query.subcategory,
    kind: req.query.kind,
    q: req.query.q,
    limit: req.query.limit,
    offset: req.query.offset
  })));
  router.post('/transactions', wrap(req => {
    const dryRun = req.body?.dry_run === true || req.query.dry_run === 'true';
    return finance.ingestTransactions(listFromBody(req.body, 'transactions'), actor, { dryRun });
  }));
  router.get('/transactions/:id', wrap(req => finance.getTransaction(idParam(req))));
  router.patch('/transactions/:id', wrap(req => finance.updateTransaction(idParam(req), req.body || {}, actor)));
  router.delete('/transactions/:id', wrap(req => finance.deleteTransaction(idParam(req), actor)));

  router.get('/categories', wrap(() => ({ categories: finance.listCategories() })));
  router.get('/rules', wrap(() => ({ rules: finance.listRules() })));
  router.post('/rules', wrap((req, res) => {
    res.status(201);
    return finance.addRule(req.body || {}, actor);
  }));
  router.delete('/rules/:id', wrap(req => finance.deleteRule(idParam(req), actor)));
  router.post('/rules/reapply', wrap(() => finance.recategorize(actor)));
  router.post('/rules/learn', wrap((req, res) => {
    res.status(201);
    return finance.learnFromTransaction(req.body || {}, actor);
  }));
  router.get('/review', wrap(req => finance.reviewQueue({ limit: req.query.limit })));

  router.get('/fx', wrap(req => ({ fx: finance.rateOn(dateParam(req, 'date') || require('./finance').todayAr()) })));
  router.get('/net-worth', wrap(req => finance.netWorth(dateParam(req, 'date'))));
  router.get('/net-worth/history', wrap(req => finance.netWorthHistory({ from: dateParam(req, 'from'), to: dateParam(req, 'to') })));
  router.get('/cashflow', wrap(req => finance.cashflow({
    from: dateParam(req, 'from'),
    to: dateParam(req, 'to'),
    accountId: req.query.account_id,
    institution: req.query.institution
  })));
  router.get('/summary', wrap(req => finance.summary({ months: req.query.months })));
  router.get('/audit', wrap(req => ({ entries: finance.recentAudit(req.query.limit) })));

  router.use((req, res) => res.status(404).json({ error: `ruta inexistente: ${req.method} ${req.originalUrl}` }));
  return router;
}

module.exports = { createFinanceRouter, bearerAuth };
