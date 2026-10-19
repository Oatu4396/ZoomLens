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
    if (fixture.document.groups.length) {
      assert.equal(hash(result.rays), fixture.raysHash);
      assert.equal(hash(result.aperture), fixture.apertureHash);
    } else assert.equal(hash(subset), fixture.layoutHash);
    assert.equal(result.focus.length, 201);
    assert.equal(result.focus[0][0], -1);
    assert.equal(result.focus.at(-1)[0], 1);
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

test('progressive backend layout preserves rays and completed full-range results', () => {
  for (const name of ['pnp-mid', 'finite-asphere', 'auto-vignetting', 'image-na']) {
    const document = fixtures.find(fixture => fixture.name === name).document;
    const full = calculate('layout', document)[0];
    const stream = calculate('layout-stream', document);
    assert.deepEqual(stream.map(row => row.stage), ['current', 'complete']);
    assert.equal(hash(stream[0].data.rays), hash(full.rays), name);
    assert.equal(hash(stream[0].data.firstOrder), hash(full.firstOrder), name);
    assert.equal(hash(stream[1].data), hash(full), name);
    assert.equal(stream[0].data.zoomOptics.length, 1);
    assert.equal(calculate('layout-current', document).length, 1);
  }
});

test('signed zoom, optical trends, nominal marker data and state restoration', () => {
  const ctx = vm.createContext({ console });
  for (const file of ['catalogs.js', 'optics.js', 'examples.js']) vm.runInContext(fs.readFileSync(path.join(root, 'shared', file), 'utf8'), ctx);
  const run = source => vm.runInContext(source, ctx);
  run('setLensDocument(JSON.parse(JSON.stringify(pnpExample)));zoom=-.25');
  const before = run('JSON.stringify(lensDocument(),encodeNumber)');
  const rows = run('zoomOpticsValues()');
  assert.equal(rows[0].position, -1);assert.equal(rows.at(-1).position, 1);
  assert(Number.isFinite(rows.find(row=>row.position===-.25).efl));
  assert(rows.find(row=>row.position===0));
  assert(Math.abs(rows.find(row=>row.position===0).efl-rows.at(-1).efl)>1);
  for (const row of rows.filter(row=>Number.isFinite(row.efl)&&Number.isFinite(row.aperture))) assert(Math.abs(row.aperture-Math.abs(row.efl)/10)<1e-10);
  assert.equal(run('JSON.stringify(lensDocument(),encodeNumber)'), before);
  run('var signed=JSON.parse(JSON.stringify(lensDocument()));setLensDocument(signed)');assert.equal(run('zoom'),-.25);
  run('specs.apertureMode="fnumber";specs.fnumber=4');
  for(const row of run('zoomOpticsValues()').filter(row=>Number.isFinite(row.aperture)))assert.equal(row.aperture,4);
  run('specs.apertureMode="na";specs.na=.1');
  const naRows=run('zoomOpticsValues()');assert(naRows.some(row=>Number.isFinite(row.aperture)));
  for(const row of naRows.filter(row=>Number.isFinite(row.aperture)))assert.equal(row.aperture,.1);
  run('specs.vignetting[0].vuy=[.1,.3];specs.autoVignetting=false;zoom=-1');assert.equal(run('manualVignetting(0,0).vuy'),.1);run('zoom=0');assert(Math.abs(run('manualVignetting(0,0).vuy')-.2)<1e-12);
});

test('full signed-range Auto envelope includes negative positions', () => {
  const ctx=vm.createContext({console});for(const file of ['catalogs.js','optics.js','examples.js'])vm.runInContext(fs.readFileSync(path.join(root,'shared',file),'utf8'),ctx);vm.runInContext('setLensDocument(JSON.parse(JSON.stringify(pnpExample)));zoom=-.25',ctx);const doc=JSON.parse(vm.runInContext('JSON.stringify(lensDocument())',ctx));
  const result=calculate('layout',doc)[0];assert.equal(result.zoomOptics[0].position,-1);assert.equal(result.zoomOptics.at(-1).position,1);
  assert(result.firstOrder);assert(result.rays.rays.length);
  const semis=new Map(result.autoSemis);
  for(const ray of result.rays.rays)for(const [i,point] of ray.points.slice(1).entries())assert(Math.abs(point[1])<=semis.get(doc.surfaces[i].id)+1e-7);
});

test('legacy motion range maps to signed coordinates without changing physical zoom states',()=>{
  const ctx=vm.createContext({console});for(const file of ['catalogs.js','optics.js','examples.js'])vm.runInContext(fs.readFileSync(path.join(root,'shared',file),'utf8'),ctx);
  const run=source=>vm.runInContext(source,ctx);
  for(const t of [0,.25,.5,.75,1]){
    ctx.doc=JSON.parse(JSON.stringify(fixtures.find(f=>f.name==='pnp-wide').document));ctx.doc.zoom=t;
    const expected=ctx.doc.surfaces.map((s,i)=>ctx.doc.surfaces.slice(0,i).reduce((sum,s)=>sum+s.thickness,0)+(ctx.doc.groups.find(g=>g.id===s.group)?.polynomial.split(',').map(Number).reduceRight((sum,a)=>sum*t+a,0)??0));
    run('setLensDocument(doc)');assert.equal(run('zoom'),2*t-1);
    const actual=run('rawPositions()');actual.forEach((z,i)=>assert(Math.abs(z-expected[i])<1e-10));
    for(const group of run('groups'))assert.equal(Number(group.polynomial.split(',')[0]),0);
    const saved=run('JSON.stringify(lensDocument())');assert.equal(JSON.parse(saved).version,3);
    run('setLensDocument(JSON.parse(JSON.stringify(lensDocument())))');assert.equal(run('JSON.stringify(lensDocument())'),saved);
  }
});
