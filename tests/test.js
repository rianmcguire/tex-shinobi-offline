#!/usr/bin/env node

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generateTEX, parseTEX } = require('../site/tex-offline.js');

const FIXTURES = path.join(__dirname, 'fixtures');

// ==================== Helpers ====================

/** Read a fixture .json payload file */
function readFixturePayload(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** Read a fixture .tex file as ArrayBuffer */
function readFixture(name) {
  const buf = fs.readFileSync(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Read a .tex fixture from disk, or generate it by POSTing the payload
 * to the real backend and caching the result.
 */
async function readOrGenerateFixture(texFile, payload) {
  const texPath = path.join(FIXTURES, texFile);
  if (fs.existsSync(texPath)) {
    return readFixture(texFile);
  }
  const body = 'keyChange=' + encodeURIComponent(JSON.stringify(payload));
  const res = await fetch('https://yoda2.tedshd.io/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Backend returned ${res.status} for ${texFile}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(texPath, Buffer.from(ab));
  return ab;
}


/**
 * Normalize a UI payload for roundtrip comparison.
 * - UI stores index/data as strings (DOM attributes); parser returns numbers
 * - Empty macro slots don't roundtrip (backend only writes non-empty)
 * - fnPos entries with value 0xFF (cleared slots) don't survive the binary format
 */
function normalizePayload(payload) {
  for (const pname of ['profile1', 'profile2', 'profile3']) {
    if (!payload[pname]) continue;
    if (payload[pname].macro) {
      for (const key of Object.keys(payload[pname].macro)) {
        if (!payload[pname].macro[key].length) delete payload[pname].macro[key];
      }
    }
    // fnPos entries that encode to 0xFF are "cleared" slots — not stored in binary
    for (const posSec of ['fn1Pos', 'fn2Pos', 'fn3Pos']) {
      const obj = payload[pname][posSec];
      if (!obj) continue;
      for (const key of Object.keys(obj)) {
        const parts = String(obj[key]).split(',');
        if (parseInt(parts[0]) * 8 + parseInt(parts[1]) === 0xFF) delete obj[key];
      }
    }
    const keySections = ['keyChange','fn1','fn2','fn3','fn1Top','fn2Top','fn3Top'];
    for (const sec of keySections) {
      const obj = payload[pname][sec];
      if (!obj) continue;
      for (const key of Object.keys(obj)) {
        const entry = obj[key];
        if (typeof entry.index === 'string' && entry.data !== undefined) {
          entry.index = parseInt(entry.index);
          if (typeof entry.data === 'string' && entry.data.charAt(0) !== 'm') {
            entry.data = parseInt(entry.data);
          }
        }
      }
    }
  }
  return payload;
}

// ==================== Tests ====================

describe('Backend Comparison', () => {
  const fixtures = [
    'all-fn-layers',
    'all-macros',
    'asymmetric-profiles',
    'backend-macro-format',
    'ctrl-fn-swap',
    'data-255',
    'default-config',
    'empty-macros',
    'fn-key-remap',
    'fn-positions',
    'fn1-layer',
    'fn1-macro-keys',
    'fn2-fn3-layers',
    'fn2pos',
    'fntp-positions',
    'full-keychange',
    'gkeys-remap',
    'key-remap',
    'macro-all-sources',
    'macro-chord',
    'macro-chord-symmetric',
    'macro-keys',
    'macro-keys-multiple-fn-layers',
    'macro-sequence',
    'macros-on-p2p3',
    'media-keys-fn1',
    'minimal-header',
    'modifier-swap',
    'mouse-move',
    'multi-macro',
    'multi-profile-macros',
    'multi-profile-fn-keys',
    'single-fn1pos',
    'trackpoint-speed',
    'zero-fn-positions',
  ];

  for (const name of fixtures) {
    test(`byte-exact match: ${name}`, async () => {
      const payload = readFixturePayload(`${name}.json`);
      const fixture = new Uint8Array(await readOrGenerateFixture(`${name}.tex`, payload));
      const local = new Uint8Array(generateTEX(payload));

      assert.equal(local.length, fixture.length,
        `size mismatch: local=${local.length} fixture=${fixture.length}`);

      for (let i = 0; i < local.length; i++) {
        if (local[i] !== fixture[i]) {
          assert.fail(
            `first diff at offset 0x${i.toString(16)}: ` +
            `local=0x${local[i].toString(16)} fixture=0x${fixture[i].toString(16)}`
          );
        }
      }
    });

    test(`roundtrip: ${name}`, () => {
      const payload = readFixturePayload(`${name}.json`);
      const parsed = parseTEX(generateTEX(payload));

      assert.deepEqual(parsed, normalizePayload(payload));
    });
  }
});

describe('real-world KEYMAP.TEX', () => {
  test('parse all 3 profiles with keyChange data', () => {
    const profiles = parseTEX(readFixture('KEYMAP.tex'));
    for (const pname of ['profile1', 'profile2', 'profile3']) {
      assert.ok(profiles[pname], `${pname} exists`);
      assert.ok(Object.keys(profiles[pname].keyChange).length > 0, `${pname} has keyChange entries`);
      for (const [name, code] of [['A', 4], ['ENTER', 40], ['SPACE', 44]]) {
        assert.ok(profiles[pname].keyChange[String(code)], `${pname} has ${name}(${code})`);
      }
      assert.ok(Object.keys(profiles[pname].fn1Pos).length > 0, `${pname} has fn1Pos`);
    }
  });

  test('fn1/fn1Top counts for profile1', () => {
    const p1 = parseTEX(readFixture('KEYMAP.tex')).profile1;
    assert.equal(Object.keys(p1.fn1).length, 17, 'fn1 count');
    assert.equal(Object.keys(p1.fn1Top).length, 78, 'fn1Top count');
  });

  test('roundtrip KEYMAP.TEX parse -> generate -> parse', () => {
    const origProfiles = parseTEX(readFixture('KEYMAP.tex'));
    const regenProfiles = parseTEX(generateTEX(origProfiles));
    // generateTEX always emits macro terminators, so parsed output gains macro
    // entries even when the input had none. Compare everything except macro.
    for (const pname of ['profile1', 'profile2', 'profile3']) {
      const { macro: _a, ...orig } = origProfiles[pname];
      const { macro: _b, ...regen } = regenProfiles[pname];
      assert.deepEqual(regen, orig, pname);
    }
  });
});

describe('Error Handling', () => {
  test('bad magic throws', () => {
    const bad = new ArrayBuffer(104);
    new DataView(bad).setUint32(0, 0x4E4F5045); // 'NOPE'
    assert.throws(() => parseTEX(bad), /Bad magic|CYFI/i);
  });
});
