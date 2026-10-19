const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

test('browser uses API calculations, preserves library, and isolates Zoom tab', async () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const elements = new Map(), storage = new Map(), requests = [], layoutRequests = [], pending = new Set();
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', checked: false,
      hidden: ['zoomTab', 'specificationTab', 'performanceTab', 'materialsTab'].includes(id),
      listeners: {}, attributes: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(key, value) { this.attributes[key] = value; }, appendChild(child) { child.parentElement = this; }, focus() {}, select() {},
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return elements.get(id);
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) el(match[1]);
  const ctx = vm.createContext({
    console, AbortController, TextDecoder, Uint8Array,
    document: { getElementById: el, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: {}, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0),
    fetch: async (url, options) => {
      requests.push(url);
      const body = JSON.parse(options.body);
      if (url.endsWith('layout')) layoutRequests.push(body);
      const operation = url.endsWith('layout') ? body.stream ? body.current_only ? 'layout-current' : 'layout-stream' : 'layout' : 'performance';
      const child = spawn('node', [path.join(root, 'backend/engine/worker.cjs'), operation]);
      pending.add(child);
      child.stdin.end(options.body);
      const abort = () => child.kill();
      options.signal.addEventListener('abort', abort);
      child.once('close', () => {
        pending.delete(child);
        options.signal.removeEventListener('abort', abort);
      });
      return { ok: true, body: { getReader() { const iterator = child.stdout[Symbol.asyncIterator](); return {
        async read() {
          if (options.signal.aborted) throw Object.assign(Error('Aborted'), { name: 'AbortError' });
          return iterator.next();
        },
        async cancel() { child.kill(); },
      }; } } };
    },
  });
  const run = source => vm.runInContext(source, ctx);
  try {
    for (const file of ['shared/catalogs.js', 'shared/optics.js', 'shared/examples.js', 'frontend/app.js']) run(fs.readFileSync(path.join(root, file), 'utf8'));
    run("ensureZoomEnvelope=()=>{throw Error('Full-range scans must remain in the backend')}");
    async function waitFor(condition) {
      const deadline = Date.now() + 15000;
      while (!condition()) { if (Date.now() > deadline) throw Error('Timed out: ' + el('geometryStatus').textContent + ' ' + el('performanceStatus').textContent); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await waitFor(() => !!run('layoutResult'));
    assert(el('layout').innerHTML.includes('STO'));
    assert(el('firstOrderData').innerHTML.includes('Effective focal length'));
    assert.deepEqual([...new Set(requests)], ['/api/layout']);
    run('loadLensDocument(JSON.parse(JSON.stringify(pnpExample)))');
    await waitFor(() => run('layoutResult?.key===JSON.stringify(lensDocument(),encodeNumber)'));
    assert(el('layout').innerHTML.includes('STO'));
    await waitFor(() => run('layoutAnalysis?.key===envelopeInputKey()'));
    el('saveLens').listeners.click();
    el('lensNameInput').value = 'Saved PNP';
    el('lensNameForm').listeners.submit({ preventDefault() {} });
    assert.equal(JSON.parse(storage.get('ZoomLens.savedLenses'))[0].document.surfaces.length, 4);
    run('const savedDesign=JSON.parse(JSON.stringify(lensDocument())); specs.epd+=1; loadLensDocument(savedDesign)');
    await waitFor(() => run('layoutResult?.key===JSON.stringify(lensDocument(),encodeNumber)'));
    assert(run('zoomEnvelope!==null'));
    await waitFor(() => run('layoutAnalysis?.key===envelopeInputKey()'));
    el('loadLens').listeners.click();
    assert(el('savedLensRows').innerHTML.indexOf('Saved PNP') < el('savedLensRows').innerHTML.indexOf('PNP example'));
    run('zoomEnvelope=null');
    el('zoomTabButton').listeners.click();
    await waitFor(() => run('zoomEnvelope!==null'));
    assert(!el('zoomTab').hidden);
    assert(el('designTab').hidden);
    assert.equal(el('lensDrawingPanel').parentElement,el('zoomDrawingSlot'));
    assert(el('eflPlot').innerHTML.includes('<'));
    assert(el('zoomEfl').textContent!=='—');
    const beforeSlider=layoutRequests.length;
    run('updateZoom(.5);updateZoom(-1);updateZoom(-.25)');
    await waitFor(()=>run('layoutResult?.key===JSON.stringify(lensDocument(),encodeNumber)'));
    assert.equal(run('zoom'),-.25);
    assert.equal(layoutRequests.length,beforeSlider);
    assert(!requests.includes('/api/performance'));
    run('surfaces[0].radius=55;renderAll()');
    await waitFor(() => layoutRequests.length > beforeSlider);
    run('updateZoom(-.75)');
    await waitFor(() => run('layoutAnalysis?.key===envelopeInputKey() && layoutResult?.key===JSON.stringify(lensDocument(),encodeNumber)'));
    assert.equal(run('zoom'),-.75);
    assert.equal(layoutRequests.length,beforeSlider+1);
    el('performanceTabButton').listeners.click();
    await waitFor(() => !!run('performanceKey'));
    assert(requests.includes('/api/performance'));
    for (const id of ['fanT', 'fanS', 'fieldCurvaturePlot', 'distortionPlot', 'spotPlot', 'mtfPlot']) assert(el(id).innerHTML.includes('<'), id);
    el('designTabButton').listeners.click();
    assert.equal(el('lensDrawingPanel').parentElement,el('designDrawingSlot'));
    el('newLens').listeners.click();
    await waitFor(() => run('layoutResult?.key===JSON.stringify(lensDocument(),encodeNumber)'));
    assert.equal(run('surfaces.length'), 2);
    assert.equal(JSON.parse(storage.get('ZoomLens.savedLenses')).length, 1);
  } finally {
    clearTimeout(run('layoutTimer'));
    for (const child of pending) child.kill();
  }
});
