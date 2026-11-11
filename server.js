require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { openDb } = require('./lib/db');
const { createFinance, todayAr } = require('./lib/finance');
const { createFinanceRouter, bearerAuth } = require('./lib/finance-router');
const { createDocs } = require('./lib/bot-docs');
const { createAuth } = require('./lib/auth');
const { setEnvValues } = require('./lib/env-file');
const { createObraSync } = require('./lib/obra-sheet');

const app = express();
const PORT = safeNumber(process.env.PORT, 9595);
const HOST = process.env.HOST || '127.0.0.1';
const FINANZAS_DB = process.env.FINANZAS_DB || path.join(__dirname, 'data', 'finanzas.db');
const FINANZAS_PUBLIC_URL = process.env.FINANZAS_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, 'data', 'snapshots');
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
const IOL_BASE_URL = 'https://api.invertironline.com';
const IOL_API_ENABLED = envFlag('IOL_API_ENABLED', false);
const IOL_USE_REAL_PORTFOLIO = envFlag('IOL_USE_REAL_PORTFOLIO', false);
// Editable from the Configuración page (persisted to .env), so these are not constants.
let IOL_USERNAME = process.env.IOL_USERNAME || '';
let IOL_PASSWORD = process.env.IOL_PASSWORD || '';
const ENV_FILE = path.join(__dirname, '.env');
const iolStatus = { ok: null, error: null, lastSuccessAt: null, lastAttemptAt: null };
const iolTokenCache = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0
};

// Ensure data dir exists
fs.mkdirSync(DATA_DIR, { recursive: true });

const finance = createFinance(openDb(FINANZAS_DB));
// Personal categorization rules (payee names) stay out of the repo; only used to seed an empty DB.
function loadLocalRules() {
  const file = process.env.FINANZAS_LOCAL_RULES || path.join(__dirname, 'data', 'rules.local.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Ignoring ${file}: ${error.message}`);
    return [];
  }
}
finance.seedDefaults({ extraRules: loadLocalRules() });
// Construction expenses come from a Google Sheet (OBRA_* in .env); disabled when not configured.
const obraSync = createObraSync({ finance });
const docs = createDocs({ baseUrl: FINANZAS_PUBLIC_URL });

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasIolCredentials() {
  return Boolean(IOL_USERNAME && IOL_PASSWORD);
}

function shouldUseIolPortfolio() {
  return IOL_API_ENABLED && IOL_USE_REAL_PORTFOLIO && hasIolCredentials();
}

function emptySections() {
  return {
    cash: { ars: 0, usd: 0 },
    virtual: { ars: 0, usd: 0 },
    crypto: { usdt: 0 }
  };
}

function portfolioSections(portfolio = {}) {
  return {
    cash: {
      ars: safeNumber(portfolio.cash?.ars),
      usd: safeNumber(portfolio.cash?.usd)
    },
    virtual: {
      ars: safeNumber(portfolio.virtual?.ars),
      usd: safeNumber(portfolio.virtual?.usd)
    },
    crypto: {
      usdt: safeNumber(portfolio.crypto?.usdt)
    }
  };
}

function buildYahooTicker(symbol, title = {}) {
  if (!symbol) return null;
  if (title.mercado === 'nYSE' || title.mercado === 'nASDAQ' || title.mercado === 'aMEX' || title.pais === 'estados_Unidos') {
    return symbol;
  }
  if (title.mercado === 'bCBA' || title.pais === 'argentina') {
    return `${symbol}.BA`;
  }
  return symbol;
}

function normalizeIolType(rawType) {
  const value = String(rawType || '').toUpperCase();
  if (!value) return 'Activo';
  if (value.includes('CEDEAR')) return 'CEDEAR';
  if (value.includes('BONO') || value.includes('TITULOSPUBLICOS') || value.includes('LETRA')) return 'Bono';
  if (value.includes('ACCION')) return 'Acción';
  if (value.includes('FONDO')) return 'FCI';
  if (value.includes('OBLIGACION')) return 'ON';
  if (value.includes('ETF')) return 'ETF';
  if (value.includes('DIVISA')) return 'Divisa';
  return rawType || 'Activo';
}

function previousCloseFromVariation(currentPrice, dailyChangePercent) {
  if (!currentPrice) return 0;
  if (!Number.isFinite(dailyChangePercent) || dailyChangePercent <= -100) return currentPrice;
  const divisor = 1 + (dailyChangePercent / 100);
  return divisor ? currentPrice / divisor : currentPrice;
}

async function requestIolToken(payload) {
  const body = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      body.append(key, String(value));
    }
  });

  const res = await fetch(`${IOL_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body
  });

  const rawText = await res.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    data = { raw: rawText };
  }

  if (!res.ok) {
    const details = data.error_description || data.error || data.message || rawText || 'token request failed';
    throw new Error(`IOL token HTTP ${res.status}: ${details}`);
  }

  if (!data.access_token) {
    throw new Error('IOL token response missing access_token');
  }

  iolTokenCache.accessToken = data.access_token;
  iolTokenCache.refreshToken = data.refresh_token || iolTokenCache.refreshToken;
  iolTokenCache.expiresAt = Date.now() + Math.max(safeNumber(data.expires_in, 0) - 60, 0) * 1000;

  return iolTokenCache.accessToken;
}

async function getIolAccessToken(forceRefresh = false) {
  if (!hasIolCredentials()) {
    throw new Error('IOL credentials are missing');
  }

  if (!forceRefresh && iolTokenCache.accessToken && Date.now() < iolTokenCache.expiresAt) {
    return iolTokenCache.accessToken;
  }

  if (iolTokenCache.refreshToken) {
    try {
      return await requestIolToken({
        grant_type: 'refresh_token',
        refresh_token: iolTokenCache.refreshToken
      });
    } catch (error) {
      console.error('IOL refresh token error:', error.message);
      iolTokenCache.accessToken = null;
      iolTokenCache.expiresAt = 0;
      if (forceRefresh) {
        iolTokenCache.refreshToken = null;
      }
    }
  }

  return requestIolToken({
    username: IOL_USERNAME,
    password: IOL_PASSWORD,
    grant_type: 'password'
  });
}

async function iolApiGet(endpoint, retry = true) {
  const token = await getIolAccessToken();
  const res = await fetch(`${IOL_BASE_URL}${endpoint}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (res.status === 401 && retry) {
    iolTokenCache.accessToken = null;
    iolTokenCache.expiresAt = 0;
    const refreshedToken = await getIolAccessToken(true);
    return iolApiGetWithToken(endpoint, refreshedToken);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IOL ${endpoint} HTTP ${res.status}: ${text || 'request failed'}`);
  }

  return res.json();
}

async function iolApiGetWithToken(endpoint, token) {
  const res = await fetch(`${IOL_BASE_URL}${endpoint}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IOL ${endpoint} HTTP ${res.status}: ${text || 'request failed'}`);
  }

  return res.json();
}

function extractIolBalances(cuentas = []) {
  const balances = {
    cash: { ars: 0, usd: 0 },
    virtual: { ars: 0, usd: 0 }
  };

  for (const cuenta of cuentas) {
    const available = safeNumber(cuenta?.disponible, safeNumber(cuenta?.saldo));
    const target = String(cuenta?.tipo || '').startsWith('administrada_')
      ? balances.virtual
      : balances.cash;

    if (cuenta?.moneda === 'peso_Argentino') {
      target.ars += available;
    } else if (cuenta?.moneda === 'dolar_Estadounidense') {
      target.usd += available;
    }
  }

  return balances;
}

function mapIolHolding(activo = {}) {
  const titulo = activo.titulo || {};
  const ticker = (titulo.simbolo || '').toUpperCase();
  if (!ticker) return null;

  const quantity = safeNumber(activo.cantidad);
  const currentPrice = safeNumber(activo.ultimoPrecio);
  const dailyChangePercent = safeNumber(activo.variacionDiaria);
  const previousClose = previousCloseFromVariation(currentPrice, dailyChangePercent);
  const dailyChange = currentPrice - previousClose;
  const currentValue = safeNumber(activo.valorizado, quantity * currentPrice);
  const gainLoss = Number.isFinite(Number(activo.gananciaDinero))
    ? Number(activo.gananciaDinero)
    : currentValue - (quantity * safeNumber(activo.ppc));
  const invested = Number.isFinite(currentValue - gainLoss) ? currentValue - gainLoss : quantity * safeNumber(activo.ppc);
  const gainLossPercent = Number.isFinite(Number(activo.gananciaPorcentaje))
    ? Number(activo.gananciaPorcentaje)
    : (invested > 0 ? ((currentValue - invested) / invested) * 100 : 0);

  return {
    ticker,
    yahooTicker: buildYahooTicker(ticker, titulo),
    quantity,
    effectiveQty: quantity,
    avgPrice: safeNumber(activo.ppc),
    currentPrice,
    previousClose,
    dailyChange,
    dailyChangePercent,
    currentValue,
    invested,
    gainLoss,
    gainLossPercent,
    type: normalizeIolType(titulo.tipo),
    name: titulo.descripcion || ticker,
    error: false,
    currency: titulo.moneda || null,
    market: titulo.mercado || null,
    country: titulo.pais || null,
    committed: safeNumber(activo.comprometido),
    pointsVariation: safeNumber(activo.puntosVariacion)
  };
}

async function buildIolPortfolioResponse() {
  const [iolPortfolio, accountState, localPortfolio, dollarRates] = await Promise.all([
    iolApiGet('/api/portafolio'),
    iolApiGet('/api/estadocuenta'),
    Promise.resolve(loadPortfolio()),
    (async () => fetchDollarOficial() || fetchDollarRates())()
  ]);

  const extras = portfolioSections(localPortfolio);
  const balances = extractIolBalances(accountState?.cuentas || []);
  const holdings = (iolPortfolio?.activos || [])
    .map(mapIolHolding)
    .filter(Boolean);

  const holdingsValue = holdings.reduce((sum, holding) => sum + safeNumber(holding.currentValue), 0);
  const totalInvested = holdings.reduce((sum, holding) => sum + safeNumber(holding.invested), 0);

  const cashArs = balances.cash.ars;
  const cashUsdInArs = dollarRates?.mep ? balances.cash.usd * dollarRates.mep : 0;
  const virtualArs = balances.virtual.ars;
  const virtualUsdInArs = dollarRates?.mep ? balances.virtual.usd * dollarRates.mep : 0;
  const cryptoUsdtInArs = dollarRates?.mep ? extras.crypto.usdt * dollarRates.mep : 0;
  const totalValue = holdingsValue + cashArs + cashUsdInArs + virtualArs + virtualUsdInArs + cryptoUsdtInArs;

  return {
    source: 'iol',
    holdings,
    cash: balances.cash,
    virtual: balances.virtual,
    crypto: extras.crypto,
    holdingsValue,
    totalValue,
    totalInvested,
    totalGainLoss: totalValue - totalInvested,
    totalGainLossPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    dollarRates,
    lastUpdate: new Date().toISOString()
  };
}

// Load portfolio config
function loadPortfolio() {
  return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
}

// Yahoo Finance v8 direct fetch
async function yahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const meta = json.chart.result[0].meta;
  return {
    price: meta.regularMarketPrice || 0,
    previousClose: meta.chartPreviousClose || meta.previousClose || 0,
    change: (meta.regularMarketPrice || 0) - (meta.chartPreviousClose || meta.previousClose || 0),
    changePercent: meta.chartPreviousClose ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100) : 0,
    currency: meta.currency || 'ARS',
    marketState: meta.marketState || 'CLOSED'
  };
}

async function yahooHistory(ticker, days = 365) {
  const period1 = Math.floor((Date.now() - days * 86400000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quotes = result.indicators.quote[0];
  return timestamps.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split('T')[0],
    open: quotes.open[i],
    high: quotes.high[i],
    low: quotes.low[i],
    close: quotes.close[i],
    volume: quotes.volume[i]
  })).filter(q => q.close != null);
}

// Fetch dollar rates (MEP & CCL) using YPF as proxy
async function fetchDollarRates() {
  try {
    const [ypfBA, ypfNY] = await Promise.all([
      yahooQuote('YPFD.BA'),
      yahooQuote('YPF')
    ]);
    if (ypfBA.price && ypfNY.price && ypfNY.price > 0) {
      const mep = ypfBA.price / ypfNY.price;
      return { mep, ccl: mep * 1.02, oficial: mep * 0.75 }; // Approximate oficial
    }
  } catch (e) {
    console.error('Dollar rate fetch error:', e.message);
  }
  // Fallback: try to get from latest snapshot
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length > 0) {
      const last = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[files.length - 1]), 'utf8'));
      if (last.dollarMep) return { mep: last.dollarMep, ccl: last.dollarCcl || last.dollarMep * 1.02, oficial: last.dollarMep * 0.75 };
    }
  } catch (e) {}
  return null;
}

// Fetch official dollar rate from a public API
async function fetchDollarOficial() {
  try {
    const res = await fetch('https://dolarapi.com/v1/dolares', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json();
      const rates = {};
      for (const d of data) {
        if (d.casa === 'oficial') rates.oficial = d.venta;
        if (d.casa === 'bolsa') rates.mep = d.venta;
        if (d.casa === 'contadoconliqui') rates.ccl = d.venta;
      }
      if (rates.mep || rates.ccl || rates.oficial) return rates;
    }
  } catch (e) {
    console.error('DolarAPI error:', e.message);
  }
  return null;
}

// Fetch live prices for all holdings
async function fetchPrices(holdings) {
  const results = {};

  const quotes = await Promise.allSettled(
    holdings.map(h => yahooQuote(h.yahooTicker))
  );

  holdings.forEach((h, i) => {
    const result = quotes[i];
    if (result.status === 'fulfilled') {
      results[h.ticker] = { ...result.value, error: false };
    } else {
      console.error(`Price fetch failed for ${h.ticker}:`, result.reason?.message);
      // Use fallback price if available (e.g. bonds not on Yahoo)
      if (h.fallbackPrice) {
        results[h.ticker] = { price: h.fallbackPrice, previousClose: h.fallbackPrice, change: 0, changePercent: 0, error: false, fallback: true };
      } else {
        results[h.ticker] = { price: 0, previousClose: 0, change: 0, changePercent: 0, error: true };
      }
    }
  });

  return results;
}

// Calculate effective quantity (bonds use nominalDivisor)
function effectiveQty(h) {
  return h.nominalDivisor ? h.quantity / h.nominalDivisor : h.quantity;
}

async function buildLocalPortfolioResponse() {
  const portfolio = loadPortfolio();
  const prices = await fetchPrices(portfolio.holdings);
  const dollarRates = await fetchDollarOficial() || await fetchDollarRates();
  const sections = portfolioSections(portfolio);

  let holdingsValue = 0;
  let totalInvested = 0;
  const holdings = portfolio.holdings.map(h => {
    const p = prices[h.ticker] || { price: 0, change: 0, changePercent: 0 };
    const qty = effectiveQty(h);
    const currentValue = qty * p.price;
    const invested = qty * h.avgPrice;
    holdingsValue += currentValue;
    totalInvested += invested;
    return {
      ...h,
      effectiveQty: qty,
      currentPrice: p.price,
      previousClose: p.previousClose,
      dailyChange: p.change,
      dailyChangePercent: p.changePercent,
      currentValue,
      invested,
      gainLoss: currentValue - invested,
      gainLossPercent: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0,
      error: p.error || false
    };
  });

  const cashArs = sections.cash.ars;
  const cashUsdInArs = dollarRates?.mep ? sections.cash.usd * dollarRates.mep : 0;
  const virtualArs = sections.virtual.ars;
  const virtualUsdInArs = dollarRates?.mep ? sections.virtual.usd * dollarRates.mep : 0;
  const cryptoUsdtInArs = dollarRates?.mep ? sections.crypto.usdt * dollarRates.mep : 0;
  const totalValue = holdingsValue + cashArs + cashUsdInArs + virtualArs + virtualUsdInArs + cryptoUsdtInArs;

  return {
    source: 'local-fallback',
    holdings,
    cash: sections.cash,
    virtual: sections.virtual,
    crypto: sections.crypto,
    holdingsValue,
    totalValue,
    totalInvested,
    totalGainLoss: totalValue - totalInvested,
    totalGainLossPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    dollarRates,
    lastUpdate: new Date().toISOString()
  };
}

async function buildCurrentPortfolioResponse() {
  if (shouldUseIolPortfolio()) {
    iolStatus.lastAttemptAt = new Date().toISOString();
    try {
      const response = await buildIolPortfolioResponse();
      Object.assign(iolStatus, { ok: true, error: null, lastSuccessAt: iolStatus.lastAttemptAt });
      return response;
    } catch (error) {
      Object.assign(iolStatus, { ok: false, error: error.message });
      console.error('IOL portfolio fallback activated:', error.message);
    }
  }

  return buildLocalPortfolioResponse();
}

// Save a daily snapshot
async function saveSnapshot() {
  const portfolio = loadPortfolio();
  const prices = await fetchPrices(portfolio.holdings);
  const today = new Date().toISOString().split('T')[0];
  const filePath = path.join(DATA_DIR, `${today}.json`);

  let totalValue = 0;
  let totalInvested = 0;
  const holdingsSnapshot = portfolio.holdings.map(h => {
    const p = prices[h.ticker] || { price: 0 };
    const qty = effectiveQty(h);
    const currentValue = qty * p.price;
    const invested = qty * h.avgPrice;
    totalValue += currentValue;
    totalInvested += invested;
    return {
      ticker: h.ticker,
      type: h.type,
      quantity: h.quantity,
      nominalDivisor: h.nominalDivisor || null,
      avgPrice: h.avgPrice,
      currentPrice: p.price,
      currentValue,
      invested,
      gainLoss: currentValue - invested,
      gainLossPercent: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0
    };
  });

  const dollarRates = await fetchDollarOficial() || await fetchDollarRates();
  const dollarMep = dollarRates?.mep || null;
  const dollarCcl = dollarRates?.ccl || null;
  const sections = portfolioSections(portfolio);

  const cashArs = sections.cash.ars;
  const cashUsdInArs = dollarMep ? sections.cash.usd * dollarMep : 0;
  const virtualArs = sections.virtual.ars;
  const virtualUsdInArs = dollarMep ? sections.virtual.usd * dollarMep : 0;
  const cryptoUsdtInArs = dollarMep ? sections.crypto.usdt * dollarMep : 0;
  const totalWithCash = totalValue + cashArs + cashUsdInArs + virtualArs + virtualUsdInArs + cryptoUsdtInArs;

  const snapshot = {
    date: today,
    timestamp: new Date().toISOString(),
    totalValue: totalWithCash,
    holdingsValue: totalValue,
    totalInvested,
    totalGainLoss: totalWithCash - totalInvested,
    totalGainLossPercent: totalInvested > 0 ? ((totalWithCash - totalInvested) / totalInvested) * 100 : 0,
    cash: sections.cash,
    virtual: sections.virtual,
    crypto: sections.crypto,
    dollarMep,
    dollarCcl,
    totalValueUsdMep: dollarMep ? totalWithCash / dollarMep : null,
    totalValueUsdCcl: dollarCcl ? totalWithCash / dollarCcl : null,
    holdings: holdingsSnapshot,
    prices
  };

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  console.log(`Snapshot saved: ${filePath}`);
  return snapshot;
}

// Finance API: /api/v1 is the token-protected surface for the bot (no browser login needed).
app.set('trust proxy', 'loopback');
app.use('/api/v1', createFinanceRouter(finance, {
  actor: 'bot',
  auth: bearerAuth(() => process.env.FINANZAS_API_TOKEN),
  docs
}));

// Browser login: everything below this point requires a session cookie.
const auth = createAuth({
  getUser: () => process.env.FINANZAS_LOGIN_USER || 'joaco',
  getPasswordHash: () => process.env.FINANZAS_LOGIN_HASH,
  getSecret: () => process.env.FINANZAS_SESSION_SECRET,
  loginPage: path.join(__dirname, 'views', 'login.html')
});
if (!process.env.FINANZAS_LOGIN_HASH || !process.env.FINANZAS_SESSION_SECRET) {
  console.warn('[auth] FINANZAS_LOGIN_HASH / FINANZAS_SESSION_SECRET missing: nobody can log in to the UI');
}
app.use(auth.router);
app.use(auth.requireSession);

// Static files and the UI API
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/finance', createFinanceRouter(finance, { actor: 'ui' }));

app.use(express.json());

// ---------- Configuración (browser session only) ----------

// Logs in to IOL with the given credentials without touching the shared token cache.
async function testIolCredentials(username, password) {
  const res = await fetch(`${IOL_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, grant_type: 'password' }),
    signal: AbortSignal.timeout(15000)
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  let detail = text;
  try { const j = JSON.parse(text); detail = j.error_description || j.error || j.message || text; } catch (e) { /* not JSON */ }
  return { ok: false, status: res.status, error: res.status === 400 || res.status === 401 ? 'Usuario o contraseña de IOL incorrectos' : `IOL respondió HTTP ${res.status}: ${String(detail).slice(0, 200)}` };
}

function iolSettingsView() {
  return {
    username: IOL_USERNAME,
    has_password: Boolean(IOL_PASSWORD),
    enabled: IOL_API_ENABLED && IOL_USE_REAL_PORTFOLIO,
    status: iolStatus
  };
}

app.get('/api/settings/iol', (req, res) => res.json(iolSettingsView()));

app.post('/api/settings/iol', async (req, res) => {
  const username = String(req.body?.username ?? IOL_USERNAME).trim();
  const password = req.body?.password ? String(req.body.password) : IOL_PASSWORD;
  if (!username || !password) return res.status(400).json({ error: 'Falta el usuario o la contraseña de IOL' });
  if (username.length > 200 || password.length > 200) return res.status(400).json({ error: 'Valor demasiado largo' });
  try {
    const test = await testIolCredentials(username, password);
    if (!test.ok) return res.status(400).json({ error: test.error });
    setEnvValues(ENV_FILE, { IOL_USERNAME: username, IOL_PASSWORD: password });
    IOL_USERNAME = username;
    IOL_PASSWORD = password;
    Object.assign(iolTokenCache, { accessToken: null, refreshToken: null, expiresAt: 0 });
    console.log('[settings] IOL credentials updated from the UI');
    // Refresh the IOL balance right away so the dashboard reflects the real portfolio.
    await recordAutoBalances().catch(error => console.error('Auto balance error:', error.message));
    res.json({ saved: true, ...iolSettingsView() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings/obra', (req, res) => res.json(obraSync.status()));

app.post('/api/settings/obra/sync', async (req, res) => {
  if (!obraSync.configured) return res.status(400).json({ error: 'La planilla de la obra no está configurada (OBRA_SHEET_ID y GOOGLE_SERVICE_ACCOUNT_FILE en .env)' });
  const status = await obraSync.sync('ui');
  res.status(status.last?.ok ? 200 : 502).json(status);
});

app.post('/api/settings/iol/test', async (req, res) => {
  if (!IOL_USERNAME || !IOL_PASSWORD) return res.status(400).json({ error: 'No hay credenciales de IOL cargadas' });
  try {
    const test = await testIolCredentials(IOL_USERNAME, IOL_PASSWORD);
    iolStatus.lastAttemptAt = new Date().toISOString();
    Object.assign(iolStatus, test.ok ? { ok: true, error: null, lastSuccessAt: iolStatus.lastAttemptAt } : { ok: false, error: test.error });
    res.status(test.ok ? 200 : 400).json(test.ok ? iolSettingsView() : { error: test.error, ...iolSettingsView() });
  } catch (error) {
    res.status(502).json({ error: `No se pudo contactar a IOL: ${error.message}` });
  }
});

// API: Current portfolio with live prices
app.get('/api/portfolio', async (req, res) => {
  try {
    const response = await buildCurrentPortfolioResponse();
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Historical snapshots
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const history = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return {
        date: data.date,
        totalValue: data.totalValue,
        totalInvested: data.totalInvested,
        totalGainLoss: data.totalGainLoss,
        totalGainLossPercent: data.totalGainLossPercent,
        cash: data.cash,
        dollarMep: data.dollarMep,
        dollarCcl: data.dollarCcl,
        totalValueUsdMep: data.totalValueUsdMep,
        totalValueUsdCcl: data.totalValueUsdCcl
      };
    });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Price history for a ticker
app.get('/api/prices/:ticker', async (req, res) => {
  try {
    const portfolio = loadPortfolio();
    const requestedTicker = req.params.ticker.toUpperCase();
    let holding = portfolio.holdings.find(h => h.ticker === requestedTicker);

    if (!holding && shouldUseIolPortfolio()) {
      try {
        const iolPortfolio = await iolApiGet('/api/portafolio');
        const mappedHolding = (iolPortfolio?.activos || [])
          .map(mapIolHolding)
          .find(item => item?.ticker === requestedTicker);

        if (mappedHolding?.yahooTicker) {
          holding = {
            ticker: mappedHolding.ticker,
            name: mappedHolding.name,
            yahooTicker: mappedHolding.yahooTicker
          };
        }
      } catch (error) {
        console.error('IOL price history fallback error:', error.message);
      }
    }

    if (!holding?.yahooTicker) return res.status(404).json({ error: 'Ticker no encontrado' });

    const prices = await yahooHistory(holding.yahooTicker, 365);

    res.json({ ticker: holding.ticker, name: holding.name, prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Benchmarks (portfolio vs S&P500 vs Merval, normalized)
app.get('/api/benchmarks', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 0;
    const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().split('T')[0] : null;

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
    const allSnapshots = files.map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
    const snapshots = cutoff ? allSnapshots.filter(s => s.date >= cutoff) : allSnapshots;

    // yahooHistory takes DAYS: cover the whole snapshot range (it used to ask for 2.5 days).
    const since = snapshots[0]?.date ? Date.parse(snapshots[0].date) : Date.now() - 365 * 86400000;
    const historyDays = Math.ceil((Date.now() - since) / 86400000) + 10;
    const [spyHistory, mervalHistory] = await Promise.all([
      yahooHistory('SPY', historyDays).catch(() => []),
      yahooHistory('^MERV', historyDays).catch(() => [])
    ]);

    const spyMap = {};
    spyHistory.forEach(p => { spyMap[p.date] = p.close; });
    const mervalMap = {};
    mervalHistory.forEach(p => { mervalMap[p.date] = p.close; });

    if (snapshots.length === 0) return res.json({ dates: [], portfolio: [], spy: [], merval: [] });

    const firstDate = snapshots[0].date;
    const firstPortfolio = snapshots[0].totalValueUsdMep || (snapshots[0].dollarMep ? snapshots[0].totalValue / snapshots[0].dollarMep : null);

    const spyDates = Object.keys(spyMap).sort();
    const mervalDates = Object.keys(mervalMap).sort();
    // Latest price on or before the snapshot date, ignoring prices older than 10 days: a feed gap
    // must show as a gap, not as a flat line copied from the first or last known close.
    const priorPrice = (dates, map, target) => {
      let found = null;
      for (const d of dates) { if (d <= target) found = d; else break; }
      if (!found || (Date.parse(target) - Date.parse(found)) / 86400000 > 10) return null;
      return map[found];
    };

    const result = {
      dates: [],
      portfolio: [],
      spy: [],
      merval: []
    };
    // A benchmark whose data starts later is anchored to the portfolio's index on that day, so
    // both lines leave from the same point. Merval quotes in pesos: convert it to dollars at
    // that day's MEP so it compares with the portfolio in USD.
    let spyBase = null;
    let spyAnchor = 100;
    let mervalBase = null;
    let mervalAnchor = 100;

    for (const snap of snapshots) {
      const portfolioUsd = snap.totalValueUsdMep || (snap.dollarMep ? snap.totalValue / snap.dollarMep : null);
      if (!portfolioUsd || !firstPortfolio) continue;

      const spyPrice = priorPrice(spyDates, spyMap, snap.date);
      const mervalArs = priorPrice(mervalDates, mervalMap, snap.date);
      const mervalUsd = mervalArs && snap.dollarMep ? mervalArs / snap.dollarMep : null;
      const portfolioIndex = (portfolioUsd / firstPortfolio) * 100;
      if (spyPrice && spyBase == null) { spyBase = spyPrice; spyAnchor = portfolioIndex; }
      if (mervalUsd && mervalBase == null) { mervalBase = mervalUsd; mervalAnchor = portfolioIndex; }

      result.dates.push(snap.date);
      result.portfolio.push(portfolioIndex.toFixed(2));
      result.spy.push(spyPrice && spyBase ? ((spyPrice / spyBase) * spyAnchor).toFixed(2) : null);
      result.merval.push(mervalUsd && mervalBase ? ((mervalUsd / mervalBase) * mervalAnchor).toFixed(2) : null);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Risk metrics
app.get('/api/risk', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 0;
    const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().split('T')[0] : null;

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
    const allSnapshots = files.map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
    const snapshots = cutoff ? allSnapshots.filter(s => s.date >= cutoff) : allSnapshots;

    if (snapshots.length < 2) return res.json({ volatility: 0, maxDrawdown: 0, sharpe: 0, returns: [] });

    const values = snapshots
      .map(s => s.totalValueUsdMep || (s.dollarMep ? s.totalValue / s.dollarMep : null))
      .filter(v => v != null);

    const returns = [];
    for (let i = 1; i < values.length; i++) {
      returns.push((values[i] - values[i-1]) / values[i-1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / returns.length;
    const periodVol = Math.sqrt(variance);
    const totalDays = (new Date(snapshots[snapshots.length-1].date) - new Date(snapshots[0].date)) / 86400000;
    const periodsPerYear = totalDays > 0 ? (returns.length / totalDays) * 252 : 252;
    const annualVol = periodVol * Math.sqrt(periodsPerYear);

    let peak = values[0];
    let maxDrawdown = 0;
    for (const v of values) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const annualReturn = mean * periodsPerYear;
    const sharpe = annualVol > 0 ? (annualReturn - 0.05) / annualVol : 0;

    const byMonth = {};
    for (const s of snapshots) {
      const ym = s.date.substring(0, 7);
      if (!byMonth[ym]) byMonth[ym] = [];
      const usdVal = s.totalValueUsdMep || (s.dollarMep ? s.totalValue / s.dollarMep : null);
      if (usdVal) byMonth[ym].push({ date: s.date, value: usdVal });
    }

    const months = Object.keys(byMonth).sort();
    const monthlyReturns = [];
    for (let i = 1; i < months.length; i++) {
      const prev = byMonth[months[i-1]];
      const curr = byMonth[months[i]];
      if (prev.length > 0 && curr.length > 0) {
        const v0 = prev[prev.length - 1].value;
        const v1 = curr[curr.length - 1].value;
        monthlyReturns.push({
          date: curr[curr.length - 1].date,
          month: months[i],
          returnPct: ((v1 - v0) / v0) * 100
        });
      }
    }

    const dollarHistory = snapshots
      .filter(s => s.dollarMep)
      .map(s => ({ date: s.date, mep: s.dollarMep, ccl: s.dollarCcl }));

    res.json({
      volatility: (annualVol * 100).toFixed(1),
      maxDrawdown: (maxDrawdown * 100).toFixed(1),
      sharpe: sharpe.toFixed(2),
      annualReturn: (annualReturn * 100).toFixed(1),
      monthlyReturns,
      dollarHistory
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Update cash, virtual, and crypto positions
app.post('/api/cash', (req, res) => {
  try {
    const { ars, usd, virtualArs, virtualUsd, usdt } = req.body;
    const portfolio = loadPortfolio();
    if (!portfolio.cash) portfolio.cash = { ars: 0, usd: 0 };
    if (ars !== undefined) portfolio.cash.ars = parseFloat(ars) || 0;
    if (usd !== undefined) portfolio.cash.usd = parseFloat(usd) || 0;
    if (!portfolio.virtual) portfolio.virtual = { ars: 0, usd: 0 };
    if (virtualArs !== undefined) portfolio.virtual.ars = parseFloat(virtualArs) || 0;
    if (virtualUsd !== undefined) portfolio.virtual.usd = parseFloat(virtualUsd) || 0;
    if (!portfolio.crypto) portfolio.crypto = { usdt: 0 };
    if (usdt !== undefined) portfolio.crypto.usdt = parseFloat(usdt) || 0;
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
    recordAutoBalances().catch(error => console.error('Auto balance error:', error.message));
    res.json({ ok: true, cash: portfolio.cash, virtual: portfolio.virtual, crypto: portfolio.crypto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Trigger manual snapshot
app.post('/api/snapshot', async (req, res) => {
  try {
    const snapshot = await saveSnapshot();
    res.json({ ok: true, snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store today's dollar quote so every movement and balance can be shown in ARS and USD MEP.
async function refreshFxRate() {
  const rates = await fetchDollarOficial() || await fetchDollarRates();
  if (rates?.mep) finance.setFxRate(todayAr(), rates, 'dolarapi');
  return rates;
}

// The IOL account and the portfolio.json extras feed the net worth automatically.
async function recordAutoBalances() {
  const portfolio = await buildCurrentPortfolioResponse();
  const mep = portfolio.dollarRates?.mep;
  if (portfolio.dollarRates?.mep) finance.setFxRate(todayAr(), portfolio.dollarRates, 'dolarapi');
  const asOf = todayAr();
  const source = portfolio.source === 'iol' ? 'iol-api' : 'portfolio-local';
  const results = finance.addBalances([
    {
      account_id: 'iol',
      amount: portfolio.holdingsValue + safeNumber(portfolio.cash?.ars) + (mep ? safeNumber(portfolio.cash?.usd) * mep : 0),
      as_of: asOf,
      source,
      note: `${portfolio.holdings.length} activos`
    },
    { account_id: 'virtual-ars', amount: safeNumber(portfolio.virtual?.ars) + (mep ? safeNumber(portfolio.virtual?.usd) * mep : 0), as_of: asOf, source },
    { account_id: 'cripto-usdt', amount: safeNumber(portfolio.crypto?.usdt), as_of: asOf, source }
  ], 'system');
  const failed = results.filter(r => r.status === 'error');
  if (failed.length) console.error('Auto balances rejected:', JSON.stringify(failed));
  return results;
}

cron.schedule('0 21 * * 1-5', async () => {
  console.log('Running scheduled snapshot...');
  await saveSnapshot();
  await recordAutoBalances().catch(error => console.error('Auto balance error:', error.message));
}, { timezone: 'America/Argentina/Buenos_Aires' });

// Every 30 minutes: pull the construction sheet, then pair payments that came back.
async function maintenance() {
  await obraSync.sync('system');
  try { finance.linkRoundTrips(); } catch (error) { console.error('Round trips:', error.message); }
}
cron.schedule('*/30 * * * *', () => { maintenance(); }, { timezone: 'America/Argentina/Buenos_Aires' });

cron.schedule('30 11,17 * * *', () => {
  refreshFxRate().catch(error => console.error('FX refresh error:', error.message));
}, { timezone: 'America/Argentina/Buenos_Aires' });

async function init() {
  const today = new Date().toISOString().split('T')[0];
  const todayFile = path.join(DATA_DIR, `${today}.json`);
  if (!fs.existsSync(todayFile)) {
    console.log('No snapshot for today, creating...');
    await saveSnapshot();
  }
  if (!finance.listBalances({ accountId: 'iol', from: todayAr(), limit: 1 }).length) {
    await recordAutoBalances();
  }
  await refreshFxRate();
}

if (!process.env.FINANZAS_API_TOKEN) {
  console.warn('FINANZAS_API_TOKEN is not set: /api/v1 will answer 503 until it is configured.');
}

app.listen(PORT, HOST, () => {
  console.log(`Finanzas dashboard running on http://${HOST}:${PORT}`);
  init().catch(err => console.error('Init error:', err.message));
  setTimeout(maintenance, 15000);
  // One login at startup so Configuración shows the real IOL status, not "untested".
  if (hasIolCredentials() && iolStatus.ok == null) {
    testIolCredentials(IOL_USERNAME, IOL_PASSWORD).then(test => {
      if (iolStatus.ok != null) return;
      iolStatus.lastAttemptAt = new Date().toISOString();
      Object.assign(iolStatus, test.ok ? { ok: true, error: null, lastSuccessAt: iolStatus.lastAttemptAt } : { ok: false, error: test.error });
    }).catch(error => console.error('IOL status check:', error.message));
  }
});
