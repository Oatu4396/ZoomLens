const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');

const shared = path.resolve(__dirname, '../../shared');
const source = ['catalogs.js', 'optics.js'].map(file => fs.readFileSync(path.join(shared, file), 'utf8')).join('\n');
const context = vm.createContext({ console });
vm.runInContext(source, context);

async function emit(value) {
  context.output = value;
  const line = vm.runInContext('JSON.stringify(output, encodeNumber)', context) + '\n';
  if (!process.stdout.write(line)) await once(process.stdout, 'drain');
  await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  context.payload = input;
  vm.runInContext('var request = JSON.parse(payload, decodeNumber); setLensDocument(request.document)', context);
  if (process.argv[2] === 'layout') {
    const result = vm.runInContext(`(() => {
      ensureZoomEnvelope();
      const rays = buildRays();
      let rows = null;
      try { rows = firstOrderRows(opticalMatrices()); } catch {}
      const zoomOptics = zoomOpticsValues();
      return {
        rays, firstOrder: rows, envelope: zoomEnvelope,
        autoSemis: [...autoSemis], autoClearSemis: [...autoClearSemis],
        semiAuto: surfaces.map(s => s.semiAuto),
        aperture: { epd: specs.epd, fnumber: specs.fnumber, na: specs.na },
        vignetting: [...autoVignettingValues],
        focus: zoomOptics.map(row => [row.position, row.focus]), zoomOptics
      };
    })()`, context);
    await emit(result);
  } else if (process.argv[2] === 'performance') {
    const steps = vm.runInContext('ensureZoomEnvelope(); calculatePerformance()', context);
    for (const stage of steps) await emit(stage);
  } else {
    throw Error('Unknown calculation.');
  }
}

main().catch(async error => {
  await emit({ error: error.message });
  process.exitCode = 1;
});
