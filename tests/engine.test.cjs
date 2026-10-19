const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json')));
function canonical(value) {
  if (typeof value === 'number') return Math.abs(value) < 1e-9 ? 0 : Number(value.toPrecision(10));
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function calculate(operation, document) {
  const process = spawnSync('node', [path.join(root, 'backend/engine/worker.cjs'), operation], {
    input: JSON.stringify({ document }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(process.status, 0, process.stdout + process.stderr);
  return process.stdout.trim().split('\n').map(line => JSON.parse(line));
}

for (const fixture of fixtures) {
  test(`pre-migration layout: ${fixture.name}`, () => {
    const result = calculate('layout', fixture.document)[0];
    const subset = Object.fromEntries(['rays', 'envelope', 'autoSemis', 'autoClearSemis', 'aperture'].map(key => [key, result[key]]));
    assert.equal(hash(subset), fixture.layoutHash);
    assert.equal(result.focus.length, 101);
    assert.equal(result.firstOrder.length, 16);
  });
  if (fixture.performanceHash) test(`pre-migration performance: ${fixture.name}`, () => {
    const stages = calculate('performance', fixture.document);
    assert.deepEqual(stages.map(stage => stage.stage), ['coefficients', 'fans', 'field', 'spot', 'mtf']);
    assert.equal(hash(stages.at(-1).data), fixture.performanceHash);
  });
}

test('SEQ import and saved-document round trip remain compatible', () => {
  const ctx = vm.createContext({ console });
  for (const file of ['catalogs.js', 'optics.js', 'examples.js']) vm.runInContext(fs.readFileSync(path.join(root, 'shared', file), 'utf8'), ctx);
  const run = source => vm.runInContext(source, ctx);
  const imported = run("readSequence('EPD 2\\nWL 10000\\nSO 0 1e12\\nS 50 5 IRG24_SCHOTT\\nSTO\\nS -50 40 AIR\\nSI 0 0\\nDER A\\nDER B\\n')");
  assert.equal(imported.notes.filter(note => note.includes('DER')).length, 1);
  assert.equal(imported.document.surfaces[0].material, 'IRG24');
  ctx.doc = JSON.parse(JSON.stringify(imported.document));
  run('setLensDocument(doc)');
  assert.equal(run('lensDocument().surfaces[0].material'), 'IRG24');
  assert.equal(run('JSON.parse(JSON.stringify(Infinity, encodeNumber), decodeNumber)'), Infinity);
  assert(Number.isNaN(run('JSON.parse(JSON.stringify(NaN, encodeNumber), decodeNumber)')));
});
