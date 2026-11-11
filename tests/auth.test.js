'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
const { createAuth, hashPassword, verifyPassword } = require('../lib/auth');

function makeApp() {
  const app = express();
  const auth = createAuth({
    getUser: () => 'joaco',
    getPasswordHash: () => hashPassword('correct horse'),
    getSecret: () => 'test-secret',
    loginPage: path.join(__dirname, '..', 'views', 'login.html')
  });
  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));
  app.use(auth.router);
  app.use(auth.requireSession);
  app.get('/', (req, res) => res.send('home'));
  app.get('/api/finance/summary', (req, res) => res.json({ ok: true }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const login = (base, user, password) => fetch(`${base}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ user, password })
});

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = hashPassword('abc');
  assert.ok(verifyPassword('abc', h));
  assert.ok(!verifyPassword('abd', h));
  assert.ok(!verifyPassword('abc', 'garbage'));
});

test('UI and UI API require a session; bot API does not', async () => {
  await withServer(makeApp(), async base => {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), 'login');
    assert.equal((await fetch(`${base}/api/finance/summary`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
    assert.equal((await fetch(`${base}/login`)).status, 200);
  });
});

test('valid login sets a cookie that unlocks the UI; wrong password does not', async () => {
  await withServer(makeApp(), async base => {
    const bad = await login(base, 'joaco', 'nope');
    assert.equal(bad.headers.get('location'), 'login?e=bad');
    assert.equal(bad.headers.get('set-cookie'), null);

    const ok = await login(base, 'Joaco', 'correct horse');
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^fin_session=/);
    assert.equal((await fetch(`${base}/api/finance/summary`, { headers: { cookie } })).status, 200);

    const tampered = cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    assert.equal((await fetch(`${base}/api/finance/summary`, { headers: { cookie: tampered } })).status, 401);
  });
});

test('locks out after repeated failures', async () => {
  await withServer(makeApp(), async base => {
    for (let i = 0; i < 4; i++) await login(base, 'joaco', 'x');
    assert.equal((await login(base, 'joaco', 'x')).headers.get('location'), 'login?e=locked');
    assert.equal((await login(base, 'joaco', 'correct horse')).headers.get('location'), 'login?e=locked');
  });
});
