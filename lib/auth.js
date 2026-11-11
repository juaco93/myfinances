'use strict';

// Single-user login for the web UI: scrypt password hash + HMAC-signed session cookie.
// The bot keeps using /api/v1 with its Bearer token; this only guards the browser surface.

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');

const COOKIE = 'fin_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ getUser, getPasswordHash, getSecret, loginPage }) {
  const failures = new Map(); // ip -> { count, until }

  const sign = payload => crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');

  function issue(user) {
    const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function readSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || !getSecret()) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (data.exp < Date.now() || data.u !== getUser()) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function cookie(req, value, maxAgeSec) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  router.get('/login', (req, res) => {
    if (readSession(req)) return res.redirect(303, './');
    res.type('html').send(fs.readFileSync(loginPage, 'utf8'));
  });

  router.post('/login', form, (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.until > now) return res.redirect(303, 'login?e=locked');

    const user = String(req.body?.user || '').trim().toLowerCase();
    const ok = getPasswordHash() && getSecret()
      && safeEqual(user, String(getUser()).toLowerCase())
      && verifyPassword(req.body?.password || '', getPasswordHash());
    if (!ok) {
      const fresh = !f || now - f.first > LOCK_MS || (f.until && f.until <= now);
      const count = (fresh ? 0 : f.count) + 1;
      failures.set(ip, { count, first: fresh ? now : f.first, until: count >= MAX_FAILURES ? now + LOCK_MS : 0 });
      console.warn(`[auth] failed login from ${ip} (${count})`);
      return res.redirect(303, `login?e=${count >= MAX_FAILURES ? 'locked' : 'bad'}`);
    }
    failures.delete(ip);
    res.setHeader('Set-Cookie', cookie(req, issue(getUser()), SESSION_DAYS * 86400));
    res.redirect(303, './');
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.redirect(303, 'login');
  });

  // Everything mounted after this needs a session. API calls get 401 JSON, pages get the login redirect.
  function requireSession(req, res, next) {
    if (readSession(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
    // Relative redirect keeps the /finanzas prefix added by tailscale serve.
    const depth = req.path.split('/').length - 2;
    res.redirect(303, `${depth > 0 ? '../'.repeat(depth) : ''}login`);
  }

  return { router, requireSession, readSession, issue };
}

module.exports = { createAuth, hashPassword, verifyPassword, parseCookies, COOKIE };

if (require.main === module) {
  // Usage: node lib/auth.js <password>  → prints the hash for FINANZAS_LOGIN_HASH
  const pw = process.argv[2];
  if (!pw) { console.error('usage: node lib/auth.js <password>'); process.exit(1); }
  console.log(hashPassword(pw));
}
