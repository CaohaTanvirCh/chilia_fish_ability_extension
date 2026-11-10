import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadWindowsConfig} from '../scripts/windows-config.mjs';

const template = new URL('../config/windows.example.json', import.meta.url);

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fish-windows-config-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('missing local config explains how to create it from the template', t => {
  const dir = fixture(t);
  const missing = path.join(dir, 'windows.json');
  assert.throws(() => loadWindowsConfig(missing), error => {
    assert.match(error.message, /Windows config not found/);
    assert.match(error.message, /config\/windows\.example\.json/);
    assert.match(error.message, /Copy-Item/);
    return true;
  });
});

test('the example template can be copied and loaded as a local config', t => {
  const dir = fixture(t);
  const local = path.join(dir, 'windows.json');
  writeFileSync(local, readFileSync(template));
  assert.deepEqual(loadWindowsConfig(local), JSON.parse(readFileSync(template, 'utf8')));
});

test('invalid local config names the field that must be fixed', t => {
  const dir = fixture(t);
  const local = path.join(dir, 'windows.json');
  writeFileSync(local, JSON.stringify({command: 'node', args: [], env: {}, cwd: ''}));
  assert.throws(() => loadWindowsConfig(local), /cwd must be a non-empty string/);
});
