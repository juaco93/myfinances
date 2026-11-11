'use strict';

// Pulls a construction-expense Google Sheet into the finance DB as expenses.
// The sheet is the source of truth for those expenses: payments that also show up in a bank or
// wallet (a MercadoPago transfer to the builder) are linked to the sheet row and not counted twice.
//
// Expected columns (first row is a header): Fecha (dd/mm/yyyy) | Descripción | Categoría |
// Subcategoría | Gasto ARS | Gasto USD | Comentarios | ID operación MP. Rows without a date
// (totals, notes) are skipped.

const crypto = require('crypto');
const fs = require('fs');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SOURCE = 'obra-sheet';

function createGoogleAuth(keyFile) {
  let cache = { token: null, exp: 0 };
  return async function getToken() {
    if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
    const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
    const res = await fetch(aud, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google token HTTP ${res.status}: ${data.error_description || data.error || 'sin token'}`);
    cache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return cache.token;
  };
}

async function fetchValues({ sheetId, range, getToken }) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`
    + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` }, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets HTTP ${res.status}: ${data.error?.message || 'error'}`);
  return data.values || [];
}

// ---------- Parsing ----------

function parseDate(value) {
  const s = String(value ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [, d, mo, y] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? s : null;
}

// Numbers come unformatted from the API; text cells use the Argentine format ("$ 1.058.481,00").
function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value ?? '').replace(/U\$S|US\$|USD|ARS|\$|\s/gi, '');
  if (!s) return 0;
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/[()-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const sentence = v => { const s = clean(v); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; };

function payeeOf(comment) {
  const m = /transferencia (?:mercado pago |bancaria )?a ([^.(]+?)(?:\s*\(|\.|$)/i.exec(comment || '');
  return m ? clean(m[1]).slice(0, 120) : null;
}

function opIdOf(row) {
  const fromColumn = /\d{8,}/.exec(String(row[7] ?? ''));
  if (fromColumn) return fromColumn[0];
  const fromComment = /operaci[oó]n\s+(\d{8,})/i.exec(String(row[6] ?? ''));
  return fromComment ? fromComment[1] : null;
}

// Sheet values → movement inputs for finance.reconcileSource. The external_id is a hash of the
// row's content plus its occurrence number, so edits and deletions in the sheet follow through.
function parseRows(values, { accounts, category }) {
  const out = [];
  const seen = new Map();
  values.forEach((row, index) => {
    const date = parseDate(row[0]);
    if (!date) return;
    const description = clean(row[1]);
    const group = clean(row[2]);
    const sub = sentence(row[3]);
    const comment = clean(row[6]);
    const op = opIdOf(row);
    for (const [currency, col] of [['ARS', 4], ['USD', 5]]) {
      const value = parseAmount(row[col]);
      if (!value) continue;
      const hash = crypto.createHash('sha1').update([date, currency, value, description.toLowerCase(), comment.toLowerCase()].join('|')).digest('hex').slice(0, 12);
      const n = seen.get(hash) || 0;
      seen.set(hash, n + 1);
      out.push({
        account_id: accounts[currency],
        external_id: `obra:${hash}:${n}`,
        date,
        amount: -value,
        currency,
        kind: value > 0 ? 'expense' : 'income',
        description: description || [group, sub].filter(Boolean).join(', ') || 'Gasto de obra',
        counterparty: payeeOf(comment),
        category,
        subcategory: [group, sub].filter(Boolean).join(' / ').slice(0, 80) || null,
        note: comment || null,
        raw: { sheet_row: index + 1, op_id: op || undefined }
      });
    }
  });
  return out;
}

// ---------- Sync ----------

function createObraSync({ finance, env = process.env, log = console }) {
  const sheetId = env.OBRA_SHEET_ID;
  const keyFile = env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const label = env.OBRA_LABEL || 'Obra';
  const range = env.OBRA_SHEET_RANGE || 'Gastos!A:H';
  const category = env.OBRA_CATEGORY || 'Obra';
  const linkCategories = (env.OBRA_LINK_CATEGORIES || 'Construccion casa,Construcción casa,Transferencias a personas,Hogar y construcción,Pago de obra')
    .split(',').map(s => s.trim()).filter(Boolean);
  const configured = Boolean(sheetId && keyFile);
  const getToken = configured ? createGoogleAuth(keyFile) : null;
  const accounts = { ARS: 'obra-ars', USD: 'obra-usd' };
  let running = null;
  const state = { last: null };

  function status() {
    return { configured, label, category, sheet: configured ? { id_tail: sheetId.slice(-6), range } : null, last: state.last, running: Boolean(running) };
  }

  async function run(actor) {
    const startedAt = new Date().toISOString();
    try {
      finance.ensureAccount({ id: accounts.ARS, institution: 'obra', name: `${label} (pesos)`, currency: 'ARS', auto_source: SOURCE });
      finance.ensureAccount({ id: accounts.USD, institution: 'obra', name: `${label} (dólares)`, currency: 'USD', auto_source: SOURCE });
      const values = await fetchValues({ sheetId, range, getToken });
      const rows = parseRows(values.slice(1), { accounts, category });
      if (!rows.length) throw new Error('la planilla no devolvió gastos con fecha');
      const counts = finance.reconcileSource({ source: SOURCE, rows, actor });
      const links = finance.linkPayments({ source: SOURCE, categories: linkCategories, actor });
      const totals = rows.reduce((acc, r) => ({ ...acc, [r.currency]: (acc[r.currency] || 0) + Math.abs(r.amount) }), {});
      const dates = rows.map(r => r.date).sort();
      state.last = {
        ok: true, at: startedAt, rows: rows.length, totals, from: dates[0], to: dates[dates.length - 1],
        created: counts.created, updated: counts.updated, deleted: counts.deleted, unchanged: counts.unchanged,
        errors: counts.errors.length, linked: links.linked, released: links.released
      };
      if (counts.created || counts.updated || counts.deleted || links.linked) log.log(`[obra] sync: ${JSON.stringify(state.last)}`);
    } catch (error) {
      state.last = { ok: false, at: startedAt, error: error.message, previous: state.last?.ok ? state.last : state.last?.previous || null };
      log.error(`[obra] sync failed: ${error.message}`);
    }
    return status();
  }

  function sync(actor = 'system') {
    if (!configured) return Promise.resolve(status());
    if (!running) running = run(actor).finally(() => { running = null; });
    return running;
  }

  return { configured, sync, status, SOURCE };
}

module.exports = { createObraSync, parseRows, parseAmount, parseDate, payeeOf, createGoogleAuth, SOURCE };
