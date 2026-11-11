'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { setEnvValues } = require('../lib/env-file');

test('setEnvValues replaces, appends and round-trips awkward passwords', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=1\n# comment\nIOL_PASSWORD=old\nB=two\n');
  for (const pw of ['p@ss #word', "it's", 'a"b\'c', 'x$y|z&w', '  spaced  ']) {
    setEnvValues(file, { IOL_PASSWORD: pw, IOL_USERNAME: 'joaco' });
    const parsed = dotenv.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.IOL_PASSWORD, pw);
    assert.equal(parsed.IOL_USERNAME, 'joaco');
    assert.equal(parsed.A, '1');
    assert.equal(parsed.B, 'two');
  }
  assert.match(fs.readFileSync(file, 'utf8'), /# comment/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => setEnvValues(file, { X: 'a\nb' }));
  fs.rmSync(dir, { recursive: true });
});
