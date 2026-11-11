'use strict';

// Updates KEY=value lines in a dotenv file in place (atomic write, mode 600),
// quoting values so dotenv reads back exactly what was written.

const fs = require('fs');
const dotenv = require('dotenv');

function quote(value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error('value cannot contain line breaks');
  for (const q of ["'", '"', '`']) {
    if (!v.includes(q)) return `${q}${v}${q}`;
  }
  throw new Error("value cannot contain all of ' \" and `");
}

function setEnvValues(file, values) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = original.split('\n');
  const pending = new Map(Object.entries(values));
  const out = lines.map(line => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !pending.has(m[1])) return line;
    const line2 = `${m[1]}=${quote(pending.get(m[1]))}`;
    pending.delete(m[1]);
    return line2;
  });
  if (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${quote(v)}`);
  const text = out.join('\n') + '\n';

  // Round-trip check before touching the real file.
  const parsed = dotenv.parse(text);
  for (const [k, v] of Object.entries(values)) {
    if (parsed[k] !== String(v)) throw new Error(`could not store ${k} safely`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

module.exports = { setEnvValues, quote };
