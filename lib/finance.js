'use strict';

const crypto = require('crypto');
const { transaction } = require('./db');

const TIMEZONE = 'America/Argentina/Buenos_Aires';
const CURRENCIES = ['ARS', 'USD', 'USDT'];
const ACCOUNT_KINDS = ['cuenta', 'inversion', 'cripto', 'efectivo'];
const TX_KINDS = ['income', 'expense', 'transfer', 'ignored'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const DEFAULT_ACCOUNTS = [
  { id: 'iol', institution: 'iol', name: 'IOL (inversiones + saldo)', currency: 'ARS', kind: 'inversion', auto_source: 'iol-portfolio' },
  { id: 'wallbit', institution: 'wallbit', name: 'Wallbit', currency: 'USD', kind: 'cuenta' },
  { id: 'mercadopago-ars', institution: 'mercadopago', name: 'MercadoPago ARS', currency: 'ARS', kind: 'cuenta' },
  { id: 'mercadopago-usd', institution: 'mercadopago', name: 'MercadoPago USD', currency: 'USD', kind: 'cuenta' },
  { id: 'personal-pay-ars', institution: 'personal-pay', name: 'Personal Pay', currency: 'ARS', kind: 'cuenta' },
  { id: 'virtual-ars', institution: 'otro', name: 'Virtual ARS (portfolio.json)', currency: 'ARS', kind: 'cuenta', auto_source: 'portfolio-extras' },
  { id: 'cripto-usdt', institution: 'cripto', name: 'Cripto USDT', currency: 'USDT', kind: 'cripto', auto_source: 'portfolio-extras' }
];

// Generic rules seeded into an empty database. Lower priority wins.
// Rules that name real people (payees, the owner's own accounts) never live in the
// repo: put them in data/rules.local.json (gitignored), see seedDefaults().
const DEFAULT_RULES = [
  { priority: 20, direction: 'in', category: 'Rendimientos', subcategory: 'FCI / saldo invertido', kind: 'income', pattern: 'rendimientos|fci|saldo invertido' },
  { priority: 30, direction: 'in', category: 'Reintegros', subcategory: 'Reintegro / devolución', kind: 'income', pattern: 'reintegro|devolucion|devuelto|reembolso|refund' },
  { priority: 45, direction: null, category: 'Inversiones / ahorro', subcategory: 'Broker / movimiento de inversión', kind: 'transfer', pattern: 'invertironline|dinero reservado|wallbit' },
  { priority: 50, direction: 'out', category: 'Suscripciones', subcategory: 'Streaming / membresías', kind: 'expense', pattern: 'netflix|meli\\+|meli plus|prime video|amazon prime|hbo max|hbomax|(^| )max( |$)|hbo|crunchyroll|crunchy|spotify|disney' },
  { priority: 55, direction: 'out', category: 'Suscripciones', subcategory: 'Software / herramientas', kind: 'expense', pattern: 'adobe|google one|proton|openai|chatgpt|brave|apple|microsoft|github|cursor|claude|anthropic|x premium|xai' },
  { priority: 60, direction: 'out', category: 'Servicios', subcategory: 'Internet / telefonía / utilities', kind: 'expense', pattern: 'telecom|pago a personal|epagopersonal|personal flow|ecogas|epec|starlink|pago tic|luz|gas|agua|internet|telefo' },
  { priority: 70, direction: 'out', category: 'Entretenimiento', subcategory: 'Ocio', kind: 'expense', pattern: 'cine|teatro|evento|juego|gaming|steam' },
  { priority: 80, direction: 'out', category: 'Comida y supermercado', subcategory: 'Delivery / alimentos', kind: 'expense', pattern: 'pedidosya|rappi|propina|restaurant|resto|bar|cafe|kaneko|panader|kiosco|super|supermercado|mayor|frigorifico|carniceria|verduleria' },
  { priority: 90, direction: 'out', category: 'Transporte', subcategory: 'Movilidad', kind: 'expense', pattern: 'uber|cabify|didi|sube|ypf|shell|axion|nafta|combustible|peaje|estacionamiento|estacion de servicio|e-bikes' },
  { priority: 100, direction: 'out', category: 'Salud', subcategory: 'Farmacia / atención médica', kind: 'expense', pattern: 'farmacity|farmacia|medic|salud|clinica|laboratorio|osde|swiss medical' },
  { priority: 110, direction: 'out', category: 'Impuestos y comisiones', subcategory: 'Retenciones / tasas', kind: 'expense', pattern: 'retencion|iibb|sircupa|impuesto|comision|percepcion|rentas|municipalidad|afip|arca' },
  { priority: 120, direction: 'out', category: 'Hogar y construcción', subcategory: 'Materiales / mantenimiento', kind: 'expense', pattern: 'corralon|construcc|ferreter|materiales|pinturer|madera|electricidad' },
  { priority: 125, direction: 'out', category: 'Indumentaria y deporte', subcategory: 'Ropa / calzado / deporte', kind: 'expense', pattern: 'dexter|adidas|nike|sport|ropa|zapat|indumentaria' },
  { priority: 130, direction: 'out', category: 'Transferencias a personas', subcategory: 'P2P / CVU', kind: 'expense', pattern: 'transferencia enviada|enviaste dinero|transfers/out' },
  { priority: 140, direction: 'out', category: 'Compras generales', subcategory: 'Compra / pago', kind: 'expense', pattern: 'compra|pago|purchase|mercado libre|mercadolibre' }
];

const DEFAULT_CATEGORY = { income: 'Ingresos', expense: 'Otros gastos', transfer: 'Transferencia interna', ignored: 'No confirmado' };

class ValidationError extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join('; ') : String(errors));
    this.status = 400;
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

function todayAr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(date);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '' && /^[-+]?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function optionalString(value, max = 500) {
  if (value == null || value === '') return null;
  return String(value).slice(0, max);
}

function normalizeAsOf(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (typeof value === 'string' && DATE_RE.test(value)) return `${value}T12:00:00.000Z`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function fingerprintOf({ accountId, date, amount, description, counterparty }) {
  const basis = [accountId, date, amount.toFixed(2), normalizeText(`${description} ${counterparty || ''}`)].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex');
}

function monthsBack(fromMonth, count) {
  const [year, month] = fromMonth.split('-').map(Number);
  const result = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    result.push(d.toISOString().slice(0, 7));
  }
  return result;
}

function createFinance(db) {
  let fxCache = null;
  let rulesCache = null;

  function audit(actor, action, detail) {
    db.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)')
      .run(actor, action, detail == null ? null : JSON.stringify(detail));
  }

  // ---------- FX ----------

  function loadFx() {
    if (!fxCache) {
      fxCache = db.prepare('SELECT date, mep, ccl, oficial FROM fx_rates WHERE mep IS NOT NULL ORDER BY date').all();
    }
    return fxCache;
  }

  function setFxRate(date, rates, source = 'dolarapi') {
    if (!DATE_RE.test(date)) throw new ValidationError(`fecha inválida: ${date}`);
    const mep = Number(rates.mep) || null;
    if (!mep) return;
    db.prepare(`
      INSERT INTO fx_rates (date, mep, ccl, oficial, source, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(date) DO UPDATE SET mep = excluded.mep, ccl = excluded.ccl, oficial = excluded.oficial,
        source = excluded.source, updated_at = excluded.updated_at
    `).run(date, mep, Number(rates.ccl) || null, Number(rates.oficial) || null, source);
    fxCache = null;
  }

  function rateOn(date) {
    const rows = loadFx();
    if (!rows.length) return null;
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return rows[found >= 0 ? found : 0];
  }

  function convert(amount, currency, date) {
    const fx = rateOn(date || todayAr());
    const mep = fx?.mep || null;
    if (currency === 'ARS') return { ars: amount, usd: mep ? amount / mep : null };
    return { ars: mep ? amount * mep : null, usd: amount };
  }

  // ---------- Accounts ----------

  function getAccount(id) {
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  }

  function latestBalance(accountId, asOfDate) {
    if (asOfDate) {
      return db.prepare('SELECT * FROM balances WHERE account_id = ? AND substr(as_of, 1, 10) <= ? ORDER BY as_of DESC, id DESC LIMIT 1')
        .get(accountId, asOfDate) || null;
    }
    return db.prepare('SELECT * FROM balances WHERE account_id = ? ORDER BY as_of DESC, id DESC LIMIT 1').get(accountId) || null;
  }

  function describeAccount(account, today = todayAr()) {
    const balance = latestBalance(account.id);
    const converted = balance ? convert(balance.amount, account.currency, today) : null;
    const staleDays = balance
      ? Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${balance.as_of.slice(0, 10)}T12:00:00Z`)) / 86400000)
      : null;
    return {
      id: account.id,
      institution: account.institution,
      name: account.name,
      currency: account.currency,
      kind: account.kind,
      auto_source: account.auto_source,
      notes: account.notes,
      archived: Boolean(account.archived),
      balance: balance ? {
        amount: balance.amount,
        as_of: balance.as_of,
        source: balance.source,
        note: balance.note,
        ars: converted.ars,
        usd: converted.usd
      } : null,
      stale_days: staleDays
    };
  }

  function listAccounts({ includeArchived = false } = {}) {
    const rows = db.prepare(`SELECT * FROM accounts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY institution, id`).all();
    const today = todayAr();
    return rows.map(row => describeAccount(row, today));
  }

  function upsertAccount(input, actor) {
    const errors = [];
    const id = String(input.id || '').trim().toLowerCase();
    if (!ID_RE.test(id)) errors.push('id: usar minúsculas, números y guiones (2-41 chars), ej. "wallbit" o "mercadopago-ars"');
    const existing = ID_RE.test(id) ? getAccount(id) : null;
    const merged = {
      institution: input.institution ?? existing?.institution,
      name: input.name ?? existing?.name,
      currency: input.currency ? String(input.currency).toUpperCase() : existing?.currency,
      kind: input.kind ?? existing?.kind ?? 'cuenta',
      notes: input.notes !== undefined ? optionalString(input.notes) : existing?.notes ?? null,
      archived: input.archived !== undefined ? (input.archived ? 1 : 0) : existing?.archived ?? 0
    };
    if (!merged.institution || !/^[a-z0-9-]{2,40}$/.test(String(merged.institution))) errors.push('institution: requerido, ej. "wallbit", "iol", "mercadopago"');
    if (!merged.name) errors.push('name: requerido');
    if (!CURRENCIES.includes(merged.currency)) errors.push(`currency: uno de ${CURRENCIES.join(', ')}`);
    if (!ACCOUNT_KINDS.includes(merged.kind)) errors.push(`kind: uno de ${ACCOUNT_KINDS.join(', ')}`);
    if (existing && merged.currency !== existing.currency) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(id).n
        + db.prepare('SELECT COUNT(*) AS n FROM balances WHERE account_id = ?').get(id).n;
      if (used) errors.push('currency: no se puede cambiar la moneda de una cuenta con datos; creá otra cuenta');
    }
    if (errors.length) throw new ValidationError(errors);

    if (existing) {
      db.prepare('UPDATE accounts SET institution = ?, name = ?, currency = ?, kind = ?, notes = ?, archived = ? WHERE id = ?')
        .run(merged.institution, String(merged.name).slice(0, 120), merged.currency, merged.kind, merged.notes, merged.archived, id);
    } else {
      db.prepare('INSERT INTO accounts (id, institution, name, currency, kind, notes, archived) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, merged.institution, String(merged.name).slice(0, 120), merged.currency, merged.kind, merged.notes, merged.archived);
    }
    audit(actor, existing ? 'account.update' : 'account.create', { id, ...merged });
    return { status: existing ? 'updated' : 'created', account: describeAccount(getAccount(id)) };
  }

  // ---------- Balances ----------

  function addBalance(input, actor) {
    const errors = [];
    const account = input.account_id ? getAccount(String(input.account_id)) : null;
    if (!account) errors.push(`account_id: cuenta inexistente "${input.account_id ?? ''}" (ver GET /accounts)`);
    const amount = toNumber(input.amount);
    if (!Number.isFinite(amount)) errors.push('amount: número requerido (usar punto decimal, sin separador de miles)');
    if (account && input.currency && String(input.currency).toUpperCase() !== account.currency) {
      errors.push(`currency: la cuenta ${account.id} es en ${account.currency}; mandá el saldo en esa moneda`);
    }
    const asOf = normalizeAsOf(input.as_of);
    if (!asOf) errors.push('as_of: fecha inválida (YYYY-MM-DD o ISO 8601)');
    if (errors.length) throw new ValidationError(errors);

    const source = optionalString(input.source, 40) || actor;
    if (account.auto_source === 'iol-portfolio' && actor === 'bot' && !['iol-api', 'portfolio-local', 'snapshot-import'].includes(source)) {
      throw new ValidationError(`account_id: ${account.id} se actualiza solo desde IOL; no hace falta cargarlo`);
    }
    // A second balance for the exact same instant is a correction, not a new data point.
    const sameInstant = db.prepare('SELECT * FROM balances WHERE account_id = ? AND as_of = ? ORDER BY id DESC LIMIT 1').get(account.id, asOf);
    if (sameInstant) {
      if (sameInstant.amount === round2(amount)) {
        return { status: 'unchanged', id: sameInstant.id, account_id: account.id, amount: sameInstant.amount, as_of: asOf };
      }
      db.prepare('UPDATE balances SET amount = ?, source = ?, note = ? WHERE id = ?')
        .run(round2(amount), source, optionalString(input.note), sameInstant.id);
      audit(actor, 'balance.update', { account_id: account.id, amount, as_of: asOf, previous: sameInstant.amount });
      return { status: 'updated', id: sameInstant.id, account_id: account.id, amount: round2(amount), as_of: asOf };
    }
    const info = db.prepare('INSERT INTO balances (account_id, as_of, amount, source, note) VALUES (?, ?, ?, ?, ?)')
      .run(account.id, asOf, round2(amount), source, optionalString(input.note));
    audit(actor, 'balance.add', { account_id: account.id, amount, as_of: asOf });
    return { status: 'created', id: Number(info.lastInsertRowid), account_id: account.id, amount: round2(amount), as_of: asOf };
  }

  function addBalances(list, actor) {
    return list.map((item, index) => {
      try {
        return { index, ...addBalance(item || {}, actor) };
      } catch (error) {
        if (error instanceof ValidationError) return { index, status: 'error', errors: error.errors };
        throw error;
      }
    });
  }

  function listBalances({ accountId, from, to, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (accountId) { where.push('account_id = ?'); params.push(accountId); }
    if (from) { where.push('substr(as_of, 1, 10) >= ?'); params.push(from); }
    if (to) { where.push('substr(as_of, 1, 10) <= ?'); params.push(to); }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 5000));
    return db.prepare(`SELECT * FROM balances ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY as_of DESC, id DESC LIMIT ?`).all(...params);
  }

  function deleteBalance(id, actor) {
    const row = db.prepare('SELECT * FROM balances WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`saldo ${id} no existe`);
    db.prepare('DELETE FROM balances WHERE id = ?').run(id);
    audit(actor, 'balance.delete', row);
    return { status: 'deleted', id };
  }

  // ---------- Category rules ----------

  function loadRules() {
    if (!rulesCache) {
      rulesCache = db.prepare('SELECT * FROM category_rules WHERE active = 1 ORDER BY priority, id').all()
        .map(rule => {
          try {
            return { ...rule, regex: new RegExp(rule.pattern, 'i') };
          } catch (error) {
            return null;
          }
        })
        .filter(Boolean);
    }
    return rulesCache;
  }

  function matchRule({ description, counterparty, amount }) {
    const text = normalizeText(`${description || ''} ${counterparty || ''}`);
    const direction = amount < 0 ? 'out' : 'in';
    return loadRules().find(rule => (!rule.direction || rule.direction === direction) && rule.regex.test(text)) || null;
  }

  function listRules() {
    return db.prepare('SELECT * FROM category_rules ORDER BY priority, id').all();
  }

  function addRule(input, actor) {
    const errors = [];
    const priority = Number.isInteger(input.priority) ? input.priority : 75;
    if (!input.pattern) errors.push('pattern: regex requerida (se compara contra descripción + contraparte, en minúsculas y sin tildes)');
    else {
      try { new RegExp(input.pattern, 'i'); } catch (error) { errors.push(`pattern: regex inválida (${error.message})`); }
    }
    if (!input.category) errors.push('category: requerida');
    if (input.direction != null && !['in', 'out'].includes(input.direction)) errors.push('direction: "in", "out" o null');
    if (input.kind != null && !TX_KINDS.includes(input.kind)) errors.push(`kind: uno de ${TX_KINDS.join(', ')}`);
    if (errors.length) throw new ValidationError(errors);
    const info = db.prepare('INSERT INTO category_rules (priority, pattern, direction, category, subcategory, kind, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(priority, input.pattern, input.direction || null, input.category, optionalString(input.subcategory), input.kind || null, optionalString(input.note));
    rulesCache = null;
    audit(actor, 'rule.add', input);
    return { status: 'created', id: Number(info.lastInsertRowid) };
  }

  function deleteRule(id, actor) {
    const row = db.prepare('SELECT * FROM category_rules WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`regla ${id} no existe`);
    db.prepare('DELETE FROM category_rules WHERE id = ?').run(id);
    rulesCache = null;
    audit(actor, 'rule.delete', row);
    return { status: 'deleted', id };
  }

  // Re-run rules over every transaction whose category was not set by hand or by the sender.
  function recategorize(actor) {
    const rows = db.prepare("SELECT * FROM transactions WHERE category_source IN ('rule', 'default')").all();
    const update = db.prepare("UPDATE transactions SET category = ?, subcategory = ?, kind = ?, category_source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    let changed = 0;
    transaction(db, () => {
      for (const row of rows) {
        const rule = matchRule(row);
        const kind = rule?.kind || (row.amount < 0 ? 'expense' : 'income');
        const category = rule?.category || DEFAULT_CATEGORY[kind];
        const subcategory = rule?.subcategory || null;
        const source = rule ? 'rule' : 'default';
        if (category !== row.category || subcategory !== row.subcategory || kind !== row.kind) {
          update.run(category, subcategory, kind, source, row.id);
          changed++;
        }
      }
    });
    audit(actor, 'rules.reapply', { scanned: rows.length, changed });
    return { scanned: rows.length, changed };
  }

  // ---------- Transactions ----------

  function prepareTransaction(input) {
    const errors = [];
    const warnings = [];
    const account = input.account_id ? getAccount(String(input.account_id)) : null;
    if (!account) errors.push(`account_id: cuenta inexistente "${input.account_id ?? ''}" (ver GET /accounts)`);
    if (!DATE_RE.test(String(input.date || ''))) errors.push('date: requerida en formato YYYY-MM-DD');
    let amount = toNumber(input.amount);
    if (!Number.isFinite(amount) || amount === 0) errors.push('amount: número distinto de 0; negativo = sale plata de la cuenta, positivo = entra');
    const currency = input.currency ? String(input.currency).toUpperCase() : account?.currency;
    if (account && currency !== account.currency) errors.push(`currency: la cuenta ${account.id} es en ${account.currency}; usá la cuenta de esa moneda`);
    const description = optionalString(input.description, 300) || '';
    const counterparty = optionalString(input.counterparty, 200);
    if (!description && !counterparty) errors.push('description o counterparty: al menos uno');
    if (input.kind != null && !TX_KINDS.includes(input.kind)) errors.push(`kind: uno de ${TX_KINDS.join(', ')}`);
    if (input.external_id != null && String(input.external_id).length > 200) errors.push('external_id: máximo 200 caracteres');
    if (errors.length) throw new ValidationError(errors);

    if (input.kind === 'expense' && amount > 0) {
      amount = -amount;
      warnings.push('kind=expense con monto positivo: se guardó como negativo');
    } else if (input.kind === 'income' && amount < 0) {
      amount = -amount;
      warnings.push('kind=income con monto negativo: se guardó como positivo');
    }
    amount = round2(amount);

    const rule = matchRule({ description, counterparty, amount });
    const kind = input.kind || rule?.kind || (amount < 0 ? 'expense' : 'income');
    let category;
    let subcategory;
    let categorySource;
    if (input.category) {
      category = String(input.category).slice(0, 80);
      subcategory = optionalString(input.subcategory, 80);
      categorySource = 'explicit';
    } else if (rule && (!input.kind || input.kind === rule.kind)) {
      category = rule.category;
      subcategory = rule.subcategory;
      categorySource = 'rule';
    } else {
      category = DEFAULT_CATEGORY[kind];
      subcategory = null;
      categorySource = 'default';
    }

    return {
      warnings,
      row: {
        account_id: account.id,
        date: input.date,
        amount,
        currency,
        kind,
        description,
        counterparty,
        category,
        subcategory,
        category_source: categorySource,
        external_id: input.external_id != null && input.external_id !== '' ? String(input.external_id) : null,
        fingerprint: fingerprintOf({ accountId: account.id, date: input.date, amount, description, counterparty }),
        note: optionalString(input.note),
        raw: input.raw != null ? JSON.stringify(input.raw).slice(0, 4000) : null
      }
    };
  }

  const TX_FIELDS = ['date', 'amount', 'currency', 'kind', 'description', 'counterparty', 'category', 'subcategory', 'category_source', 'fingerprint', 'note', 'raw'];

  function ingestOne(input, actor, source) {
    const { row, warnings } = prepareTransaction(input);
    if (row.external_id) {
      const existing = db.prepare('SELECT * FROM transactions WHERE account_id = ? AND external_id = ?').get(row.account_id, row.external_id);
      if (existing) {
        // A category fixed by hand in the UI survives re-sends that don't carry an explicit one.
        if (existing.category_source === 'manual' && row.category_source !== 'explicit') {
          row.category = existing.category;
          row.subcategory = existing.subcategory;
          row.kind = input.kind || existing.kind;
          row.category_source = 'manual';
        }
        if (row.raw == null) row.raw = existing.raw;
        if (row.note == null) row.note = existing.note;
        const changedFields = TX_FIELDS.filter(field => existing[field] !== row[field]);
        if (!changedFields.length) return { status: 'unchanged', id: existing.id, warnings };
        db.prepare(`UPDATE transactions SET ${TX_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(...TX_FIELDS.map(f => row[f]), existing.id);
        return { status: 'updated', id: existing.id, changed: changedFields.filter(f => f !== 'fingerprint'), category: row.category, kind: row.kind, warnings };
      }
    } else if (!input.allow_duplicate) {
      const dup = db.prepare('SELECT id FROM transactions WHERE account_id = ? AND fingerprint = ?').get(row.account_id, row.fingerprint);
      if (dup) {
        return { status: 'duplicate', id: dup.id, warnings: [...warnings, 'ya existe un movimiento igual (cuenta+fecha+monto+descripción); mandá external_id o allow_duplicate=true si es otro'] };
      }
    }
    const info = db.prepare(`
      INSERT INTO transactions (account_id, external_id, source, ${TX_FIELDS.join(', ')})
      VALUES (?, ?, ?, ${TX_FIELDS.map(() => '?').join(', ')})
    `).run(row.account_id, row.external_id, source, ...TX_FIELDS.map(f => row[f]));
    return { status: 'created', id: Number(info.lastInsertRowid), category: row.category, kind: row.kind, warnings };
  }

  function ingestTransactions(list, actor, { dryRun = false, source, maxItems = 2000 } = {}) {
    if (!Array.isArray(list)) throw new ValidationError('transactions: array requerido');
    if (list.length > maxItems) throw new ValidationError(`transactions: máximo ${maxItems} por request`);
    const results = [];
    db.exec('BEGIN');
    try {
      list.forEach((item, index) => {
        try {
          results.push({ index, ...ingestOne(item || {}, actor, source || actor) });
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          results.push({ index, status: 'error', errors: error.errors });
        }
      });
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
    if (!dryRun) audit(actor, 'transactions.ingest', counts);
    return { dry_run: dryRun, counts, results };
  }

  function getTransaction(id) {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`movimiento ${id} no existe`);
    return row;
  }

  function updateTransaction(id, patch, actor) {
    const existing = getTransaction(id);
    const errors = [];
    const update = {};
    if (patch.kind !== undefined) {
      if (!TX_KINDS.includes(patch.kind)) errors.push(`kind: uno de ${TX_KINDS.join(', ')}`);
      else update.kind = patch.kind;
    }
    if (patch.category !== undefined) {
      if (!patch.category) errors.push('category: no puede ser vacía');
      else update.category = String(patch.category).slice(0, 80);
      update.subcategory = optionalString(patch.subcategory, 80);
    } else if (patch.subcategory !== undefined) {
      update.subcategory = optionalString(patch.subcategory, 80);
    }
    if (patch.description !== undefined) update.description = optionalString(patch.description, 300) || '';
    if (patch.counterparty !== undefined) update.counterparty = optionalString(patch.counterparty, 200);
    if (patch.note !== undefined) update.note = optionalString(patch.note);
    if (patch.date !== undefined) {
      if (!DATE_RE.test(String(patch.date))) errors.push('date: YYYY-MM-DD');
      else update.date = patch.date;
    }
    if (patch.amount !== undefined) {
      const amount = toNumber(patch.amount);
      if (!Number.isFinite(amount) || amount === 0) errors.push('amount: número distinto de 0');
      else update.amount = round2(amount);
    }
    if (errors.length) throw new ValidationError(errors);
    if (!Object.keys(update).length) return { status: 'unchanged', transaction: existing };
    if (update.category !== undefined || update.kind !== undefined) update.category_source = 'manual';
    const merged = { ...existing, ...update };
    update.fingerprint = fingerprintOf({ accountId: merged.account_id, date: merged.date, amount: merged.amount, description: merged.description, counterparty: merged.counterparty });
    const fields = Object.keys(update);
    db.prepare(`UPDATE transactions SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(...fields.map(f => update[f]), id);
    audit(actor, 'transaction.update', { id, ...update });
    return { status: 'updated', transaction: getTransaction(id) };
  }

  function deleteTransaction(id, actor) {
    const row = getTransaction(id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    audit(actor, 'transaction.delete', row);
    return { status: 'deleted', id };
  }

  function listTransactions({ from, to, accountId, institution, category, kind, q, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push('t.date >= ?'); params.push(from); }
    if (to) { where.push('t.date <= ?'); params.push(to); }
    if (accountId) { where.push('t.account_id = ?'); params.push(accountId); }
    if (institution) { where.push('a.institution = ?'); params.push(institution); }
    if (category) { where.push('t.category = ?'); params.push(category); }
    if (kind) { where.push('t.kind = ?'); params.push(kind); }
    if (q) { where.push("(lower(t.description) LIKE ? OR lower(coalesce(t.counterparty, '')) LIKE ?)"); params.push(`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id ${clause}`).get(...params).n;
    const rows = db.prepare(`
      SELECT t.id, t.account_id, a.institution, a.name AS account_name, t.date, t.amount, t.currency, t.kind,
             t.description, t.counterparty, t.category, t.subcategory, t.category_source, t.external_id, t.note, t.source,
             t.created_at, t.updated_at
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      ${clause}
      ORDER BY t.date DESC, t.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.min(Math.max(Number(limit) || 200, 1), 2000), Math.max(Number(offset) || 0, 0));
    return {
      total,
      transactions: rows.map(row => {
        const converted = convert(row.amount, row.currency, row.date);
        return { ...row, amount_ars: converted.ars, amount_usd: converted.usd };
      })
    };
  }

  function listCategories() {
    return db.prepare(`
      SELECT category, kind, COUNT(*) AS count FROM transactions GROUP BY category, kind ORDER BY count DESC
    `).all();
  }

  // ---------- Reports ----------

  function netWorth(date = todayAr()) {
    const accounts = db.prepare('SELECT * FROM accounts WHERE archived = 0').all();
    let ars = 0;
    let usd = 0;
    const byInstitution = {};
    const items = [];
    for (const account of accounts) {
      const balance = latestBalance(account.id, date);
      if (!balance) continue;
      const converted = convert(balance.amount, account.currency, date);
      ars += converted.ars || 0;
      usd += converted.usd || 0;
      byInstitution[account.institution] = byInstitution[account.institution] || { ars: 0, usd: 0 };
      byInstitution[account.institution].ars += converted.ars || 0;
      byInstitution[account.institution].usd += converted.usd || 0;
      items.push({ account_id: account.id, institution: account.institution, amount: balance.amount, currency: account.currency, as_of: balance.as_of, ars: converted.ars, usd: converted.usd });
    }
    return { date, ars, usd, fx: rateOn(date), by_institution: byInstitution, accounts: items };
  }

  function netWorthHistory({ from, to = todayAr() } = {}) {
    const accounts = new Map(db.prepare('SELECT * FROM accounts WHERE archived = 0').all().map(a => [a.id, a]));
    const balances = db.prepare('SELECT account_id, substr(as_of, 1, 10) AS date, amount FROM balances ORDER BY as_of, id').all()
      .filter(b => accounts.has(b.account_id));
    if (!balances.length) return { points: [] };
    const dates = [...new Set(balances.map(b => b.date).filter(d => d <= to))];
    if (!dates.includes(to)) dates.push(to);
    const current = {};
    const points = [];
    let cursor = 0;
    for (const date of dates) {
      while (cursor < balances.length && balances[cursor].date <= date) {
        current[balances[cursor].account_id] = balances[cursor].amount;
        cursor++;
      }
      if (from && date < from) continue;
      const point = { date, ars: 0, usd: 0, by_institution: {} };
      for (const [accountId, amount] of Object.entries(current)) {
        const account = accounts.get(accountId);
        const converted = convert(amount, account.currency, date);
        point.ars += converted.ars || 0;
        point.usd += converted.usd || 0;
        point.by_institution[account.institution] = (point.by_institution[account.institution] || 0) + (converted.usd || 0);
      }
      points.push(point);
    }
    return { points };
  }

  function cashflow({ from, to = todayAr(), accountId, institution } = {}) {
    const where = ["t.kind IN ('income', 'expense')"];
    const params = [];
    if (from) { where.push('t.date >= ?'); params.push(from); }
    if (to) { where.push('t.date <= ?'); params.push(to); }
    if (accountId) { where.push('t.account_id = ?'); params.push(accountId); }
    if (institution) { where.push('a.institution = ?'); params.push(institution); }
    const rows = db.prepare(`
      SELECT t.date, t.amount, t.currency, t.kind, t.category, a.institution
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${where.join(' AND ')}
    `).all(...params);

    const months = {};
    const categories = {};
    const totals = { income_ars: 0, income_usd: 0, expense_ars: 0, expense_usd: 0 };
    for (const row of rows) {
      const month = row.date.slice(0, 7);
      const { ars, usd } = convert(Math.abs(row.amount), row.currency, row.date);
      const m = months[month] || (months[month] = { month, income_ars: 0, income_usd: 0, expense_ars: 0, expense_usd: 0, count: 0 });
      m[`${row.kind}_ars`] += ars || 0;
      m[`${row.kind}_usd`] += usd || 0;
      m.count++;
      totals[`${row.kind}_ars`] += ars || 0;
      totals[`${row.kind}_usd`] += usd || 0;
      const key = `${row.kind}|${row.category}`;
      const c = categories[key] || (categories[key] = { kind: row.kind, category: row.category, ars: 0, usd: 0, count: 0 });
      c.ars += ars || 0;
      c.usd += usd || 0;
      c.count++;
    }
    const monthList = Object.values(months).sort((a, b) => a.month.localeCompare(b.month))
      .map(m => ({ ...m, net_ars: m.income_ars - m.expense_ars, net_usd: m.income_usd - m.expense_usd }));
    return {
      from: from || null,
      to,
      totals: { ...totals, net_ars: totals.income_ars - totals.expense_ars, net_usd: totals.income_usd - totals.expense_usd },
      months: monthList,
      categories: Object.values(categories).sort((a, b) => b.ars - a.ars)
    };
  }

  function summary({ months = 3 } = {}) {
    const count = Math.min(Math.max(Number(months) || 3, 1), 36);
    const today = todayAr();
    const monthKeys = monthsBack(today.slice(0, 7), count);
    const flow = cashflow({ from: `${monthKeys[0]}-01`, to: today });
    const lastTx = db.prepare('SELECT account_id, MAX(date) AS last_date, COUNT(*) AS count FROM transactions GROUP BY account_id').all();
    return {
      today,
      fx: rateOn(today),
      net_worth: netWorth(today),
      accounts: listAccounts().map(a => ({
        id: a.id,
        currency: a.currency,
        balance: a.balance?.amount ?? null,
        balance_as_of: a.balance?.as_of ?? null,
        stale_days: a.stale_days,
        last_transaction_date: lastTx.find(t => t.account_id === a.id)?.last_date || null,
        transactions: lastTx.find(t => t.account_id === a.id)?.count || 0
      })),
      cashflow: { totals: flow.totals, months: flow.months, top_categories: flow.categories.slice(0, 12) }
    };
  }

  function recentAudit(limit = 50) {
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 50, 500))
      .map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
  }

  // ---------- External sources (e.g. the construction expense sheet) ----------

  // Accounts that only carry an external source's movements (no balance of their own).
  function ensureAccount({ id, institution, name, currency, kind = 'cuenta', auto_source = null }) {
    db.prepare('INSERT OR IGNORE INTO accounts (id, institution, name, currency, kind, auto_source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, institution, name, currency, kind, auto_source);
    db.prepare('UPDATE accounts SET name = ?, auto_source = ? WHERE id = ?').run(name, auto_source, id);
    return getAccount(id);
  }

  // Makes the transactions of `source` match `rows` exactly: inserts new rows, updates changed
  // ones (by external_id) and deletes rows that disappeared from the source. Refuses to delete
  // most of the data at once, which almost always means the source came back truncated.
  function reconcileSource({ source, rows, actor = 'system', minKeepRatio = 0.5 }) {
    const existing = db.prepare('SELECT id, external_id FROM transactions WHERE source = ?').all(source);
    const wanted = new Set(rows.map(r => String(r.external_id)));
    const stale = existing.filter(r => !wanted.has(r.external_id));
    if (existing.length && existing.length - stale.length < existing.length * minKeepRatio) {
      throw new ValidationError(`${source}: la fuente devolvió ${rows.length} filas y hay ${existing.length} guardadas; no se borra nada por las dudas`);
    }
    const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, errors: [] };
    transaction(db, () => {
      for (const input of rows) {
        try {
          const result = ingestOne(input, actor, source);
          counts[result.status] = (counts[result.status] || 0) + 1;
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          counts.errors.push({ external_id: input.external_id, errors: error.errors });
        }
      }
      const del = db.prepare('DELETE FROM transactions WHERE id = ?');
      for (const row of stale) { del.run(row.id); counts.deleted++; }
    });
    if (counts.created || counts.updated || counts.deleted) audit(actor, 'source.reconcile', { source, ...counts, errors: counts.errors.length });
    return counts;
  }

  // Marks payments that the external `source` already counts as expenses (same currency and
  // amount, a few days apart) as transfers linked to that row, and releases links whose row is
  // gone. Only looks at the given categories, where such payments land (P2P transfers, works).
  function linkPayments({ source, categories, toleranceDays = 3, linkCategory = 'Pago de obra', linkSubcategory = 'Contado en la planilla', actor = 'system' }) {
    const sourceRows = db.prepare("SELECT id, external_id, date, amount, currency, description, raw FROM transactions WHERE source = ? AND kind = 'expense' ORDER BY date, id").all(source);
    const keys = new Set(sourceRows.map(r => r.external_id));
    const counts = { linked: 0, released: 0 };
    const releaseRow = db.prepare('SELECT * FROM transactions WHERE linked_to IS NOT NULL AND source != ?');
    const update = db.prepare("UPDATE transactions SET kind = ?, category = ?, subcategory = ?, category_source = ?, linked_to = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
    transaction(db, () => {
      // Release links to rows that no longer exist: the payment goes back to its rule.
      for (const row of releaseRow.all(source)) {
        if (keys.has(row.linked_to)) continue;
        const rule = matchRule(row);
        const kind = rule?.kind || (row.amount < 0 ? 'expense' : 'income');
        update.run(kind, rule?.category || DEFAULT_CATEGORY[kind], rule?.subcategory || null, rule ? 'rule' : 'default', null, row.id);
        counts.released++;
      }
      const linked = new Set(db.prepare('SELECT linked_to FROM transactions WHERE linked_to IS NOT NULL').all().map(r => r.linked_to));
      const placeholders = categories.map(() => '?').join(', ');
      const candidates = db.prepare(`SELECT id, date, amount, currency, external_id, raw FROM transactions
        WHERE source != ? AND kind = 'expense' AND linked_to IS NULL AND category IN (${placeholders})`).all(source, ...categories);
      const taken = new Set();
      const day = iso => Date.parse(`${iso}T00:00:00Z`) / 86400000;
      for (const row of sourceRows) {
        if (linked.has(row.external_id)) continue;
        const opId = /"op_id":"(\d+)"/.exec(row.raw || '')?.[1];
        let best = null;
        for (const c of candidates) {
          if (taken.has(c.id) || c.currency !== row.currency || Math.abs(Math.abs(c.amount) - Math.abs(row.amount)) > 0.5) continue;
          const gap = Math.abs(day(c.date) - day(row.date));
          if (gap > toleranceDays) continue;
          const exact = opId && (String(c.external_id || '').includes(opId) || String(c.raw || '').includes(opId));
          const score = exact ? -1 : gap;
          if (!best || score < best.score) best = { c, score };
        }
        if (!best) continue;
        taken.add(best.c.id);
        update.run('transfer', linkCategory, linkSubcategory, 'source-link', row.external_id, best.c.id);
        counts.linked++;
      }
    });
    if (counts.linked || counts.released) audit(actor, 'source.link', { source, ...counts });
    return counts;
  }

  // ---------- Seed ----------

  // extraRules: personal rules kept outside the repo (data/rules.local.json).
  function seedDefaults({ extraRules = [] } = {}) {
    transaction(db, () => {
      const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (id, institution, name, currency, kind, auto_source) VALUES (?, ?, ?, ?, ?, ?)');
      for (const a of DEFAULT_ACCOUNTS) insertAccount.run(a.id, a.institution, a.name, a.currency, a.kind, a.auto_source || null);
      const ruleCount = db.prepare('SELECT COUNT(*) AS n FROM category_rules').get().n;
      if (!ruleCount) {
        const insertRule = db.prepare('INSERT INTO category_rules (priority, pattern, direction, category, subcategory, kind) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of [...DEFAULT_RULES, ...extraRules]) insertRule.run(r.priority, r.pattern, r.direction ?? null, r.category, r.subcategory ?? null, r.kind);
      }
    });
    rulesCache = null;
  }

  return {
    ensureAccount,
    reconcileSource,
    linkPayments,
    audit,
    setFxRate,
    rateOn,
    convert,
    getAccount,
    listAccounts,
    upsertAccount,
    addBalance,
    addBalances,
    listBalances,
    deleteBalance,
    listRules,
    addRule,
    deleteRule,
    recategorize,
    ingestTransactions,
    getTransaction,
    updateTransaction,
    deleteTransaction,
    listTransactions,
    listCategories,
    netWorth,
    netWorthHistory,
    cashflow,
    summary,
    recentAudit,
    seedDefaults
  };
}

module.exports = {
  createFinance,
  ValidationError,
  NotFoundError,
  todayAr,
  normalizeText,
  CURRENCIES,
  ACCOUNT_KINDS,
  TX_KINDS
};
