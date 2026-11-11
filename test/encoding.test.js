// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never mojibake
// (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again), and no file
// holds a control byte. And a secret is never said encrypted: Gladys keeps it
// in clear in its database.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// "Ã" or "Â" followed by a Latin-1 continuation, or "â€" (the start of a
// Windows-1252 reading of a three-byte character).
const MOJIBAKE = /[ÂÃ][\u0080-¿€‚-™]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];
const ENCRYPTED = /chiffr|encrypt|crypt[ée]/i;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const read = (file) => readFileSync(join(ROOT, file));

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = read(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

test('the mojibake pattern catches what it should', () => {
  const latin1 = (text) => Buffer.from(text, 'utf8').toString('latin1');
  assert.match(latin1('Français'), MOJIBAKE);
  assert.match(latin1('« Découverte »'), MOJIBAKE);
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});

test('no control byte in any text file of the repository', () => {
  const skip = new Set(['node_modules', '.git', 'data']);
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      if (skip.has(name)) return [];
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  for (const path of walk(ROOT).filter((p) =>
    /\.(js|mjs|json|md|yml|yaml|txt)$|Dockerfile$|LICENSE$/.test(p),
  )) {
    const bytes = readFileSync(path);
    const bad = bytes.findIndex(
      (b) => (b < 0x20 && b !== 0x0a && b !== 0x09 && b !== 0x0d) || b === 0x7f,
    );
    assert.equal(bad, -1, `${path}: control byte at ${bad}`);
    assert.ok(!bytes.includes(0x0d), `${path}: CRLF line ends`);
  }
});

test('a secret is never said encrypted (Gladys keeps it in clear in its database)', () => {
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'src/i18n.js',
  ]) {
    const text = read(file).toString('utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `${file}: line ${line + 1}`);
  }
  const manifest = JSON.parse(read('gladys-assistant-integration.json').toString('utf8'));
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.match(field.description.fr, /gardé par Gladys dans sa base, jamais réaffiché/i);
    assert.match(field.description.en, /kept by Gladys in its database, never shown again/i);
  }
});
