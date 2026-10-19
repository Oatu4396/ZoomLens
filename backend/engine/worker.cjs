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
  const operation = process.argv[2];
  if (['layout', 'layout-stream', 'layout-current'].includes(operation)) {
    const stages = operation === 'layout-stream' ? [true, false] : [operation === 'layout-current'];
    for (const current of stages) {
      context.currentLayout = current;
      const result = vm.runInContext(`(() => {
        if (!currentLayout) ensureZoomEnvelope();
        const rays = currentLayout ? currentZoomEnvelope() : buildRays();
        let rows = null;
        let sample = {position: zoom, efl: NaN, aperture: NaN, focus: NaN};
        try {
          const optics = opticalMatrices();
          rows = firstOrderRows(optics);
          sample = {position: zoom, efl: optics.efl,
            aperture: specs.apertureMode === 'na' ? specs.na : specs.fnumber,
            focus: optics.lastZ + optics.imageDistance - positions().at(-1)};
        } catch {}
        const zoomOptics = currentLayout ? [sample] : zoomOpticsValues();
        return {
          rays, firstOrder: rows, envelope: zoomEnvelope,
          autoSemis: [...autoSemis], autoClearSemis: [...autoClearSemis],
          semiAuto: surfaces.map(s => s.semiAuto),
          aperture: { epd: specs.epd, fnumber: specs.fnumber, na: specs.na },
          vignetting: [...autoVignettingValues],
          focus: zoomOptics.map(row => [row.position, row.focus]), zoomOptics
        };
      })()`, context);
      await emit(operation === 'layout' ? result : {stage: current ? 'current' : 'complete', data: result});
    }
  } else if (operation === 'performance') {
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
