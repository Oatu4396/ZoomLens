# ZoomLens

A lens-design workspace with Design, Specification, Performance, Zoom, and Materials tabs. The Design tab places lens data on the left and the lens drawing on the right. The Zoom tab includes the same interactive drawing, zoom controls, group motions, EFL/aperture trends, and focus curves.

## Run with Docker Compose

Install Docker Engine with the Compose plugin, or Docker Desktop, then run from this repository:

```sh
docker compose up -d --build
```

Open **http://localhost:8080**. Check startup and logs with:

```sh
docker compose ps
docker compose logs -f zoomlens
```

To use another host port:

```sh
PORT=8090 docker compose up -d --build
```

To update or stop:

```sh
git pull --ff-only
docker compose up -d --build
docker compose down
```

Compose builds one service containing Python and Node.js. No database, GPU, or external optical service is required. The container runs as an unprivileged user and has an HTTP health check at `/api/health`.

Optional environment settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Published host port |
| `ZOOMLENS_WORKERS` | `2` | Maximum simultaneous optical calculation processes |
| `ZOOMLENS_TIMEOUT` | `120` | Maximum calculation duration, in seconds, after acquiring a worker slot |

## Deployment handoff

Point the domain's reverse proxy at the published port and forward **all paths**, including `/api/*`, to the service. Keep response buffering disabled for `/api/layout` and `/api/performance` so drawings and plots appear as each stage finishes. Set the proxy timeout at least as high as the calculation timeout plus any queue wait. Serve the public site through HTTPS, including for browser features such as the native device-save picker.

The previous static-page deployment is replaced by this service. The existing GitHub deployment workflow only pulls the repository on the server; it does not build or restart Compose. Update that server deployment step when switching hosting. Server provisioning, domain/proxy configuration, and HTTPS certificates are left to the deployment operator.

Browser-saved lenses and the current design retain their existing storage keys (`ZoomLens.savedLenses` and `ZoomLens.currentDesign`). Keep the same scheme, hostname, and port to retain access to existing browser storage. If changing the origin, export lenses from the old site and import them on the new site first. Named lenses remain browser-local; this migration does not upload or persist a server-side lens library. API requests send the current design for calculation, and each calculation process is discarded afterward.

## Structure

```text
frontend/
  index.html           Interface and dialogs
  styles.css           Styles
  app.js               Editing, browser storage, file IO, and plot rendering
shared/
  catalogs.js          Existing SCHOTT and Special dispersion data
  examples.js          Protected PNP example
  optics.js            Existing optical engine and lens-document/SEQ handling
backend/
  app.py               FastAPI routes and static frontend hosting
  engine/
    legacy.py          Calculation process lifecycle and concurrency
    worker.cjs         Node adapter for the existing optical engine
Dockerfile
compose.yaml
tests/
```

This first migration preserves the JavaScript numerical engine instead of translating its formulas into Python. Layout tracing, the full-zoom Auto-aperture scan, focus curves, automatic vignetting, and performance calculations run in isolated Node processes behind the Python API. The browser uses shared model/geometry helpers for editing and drawing and renders the returned results. Heavy calculations do not execute in the API event loop or in the browser's UI thread. Invalidated browser requests are cancelled, and calculation processes have a time limit.

Future Python optical libraries can be integrated behind `app.state.engine` without changing the editor or the HTTP contract. The engine currently exposes `layout(document)` and `stream(operation, document)`. Keep results compatible with the existing lens JSON document and plot-data responses; compare replacement numerical models against the regression cases before switching the adapter.

[AutoLens](https://github.com/AI4Optics/AutoLens) was reviewed as a future integration candidate. It uses the DeepLens/PyTorch differentiable optics stack and targets automated design/optimization. It is not installed or copied into this migration. No new optimization or zoom-solving algorithms are included.

## API

The interactive API schema is available at `/docs`.

- `GET /api/health`: service status and engine name.
- `POST /api/layout`: accepts `{"document": <ZoomLens design>}` and returns traced layout rays, first-order rows, Auto apertures, vignetting factors, and focus-curve samples. With `"stream": true`, it streams `current` and `complete` NDJSON records: the current-position drawing and first-order data arrive before the full-range Auto apertures and curves. `"current_only": true` omits the range scan when the frontend already has a completed scan for the same design.
- `POST /api/performance`: same input, with a newline-delimited JSON response. Each record has `stage` and `data`; stages are `coefficients`, `fans`, `field`, `spot`, and `mtf`. Errors after streaming starts are returned as `{"error": "..."}` records.

Layout calculations remain in the backend. The editor renders the current-position result as soon as it arrives, then updates Auto outlines and curves when the full-range result finishes. Moving the zoom slider reuses the completed range scan; changing the prescription, motion polynomials, or specifications invalidates it.

Performance calculations begin only when the Performance tab is opened. Maximum MTF frequency, frequency step, field selection, and plot pan/zoom operate on returned data without rerunning the engine.

API numeric results preserve non-finite values using objects such as `{"$number":"Infinity"}`, `{"$number":"-Infinity"}`, and `{"$number":"NaN"}`. `encodeNumber`/`decodeNumber` in the shared engine handle these values. JSON/device files use version 3. Versions 1 and 2 remain importable.

## Zoom coordinates

The zoom coordinate runs from −1 to +1. Zero is the nominal prescription: group displacements are measured relative to that position. EFL and F/# are displayed at the current position and plotted over the range; specifying image-space NA switches the aperture readout and plot to NA. Dotted lines mark the nominal position and dashed lines mark the current position.

Older 0–1 designs are mapped using `new = 2 * old - 1`. Their motion polynomials and lens thicknesses are rebased at the midpoint, preserving their physical zoom configurations. Imported CODE V zoom configurations use the same mapping. Zoom-dependent vignetting factors span the signed range as well. Auto apertures sample all 2,001 slider positions over −1…1. The EFL, aperture, and focus curves sample 201 positions plus the current position.

## Develop without Docker

Use Python 3.12+ and Node.js 24:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
.venv/bin/python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8080
```

Open the HTTP URL rather than opening the HTML file directly.

## Checks

```sh
node --test tests/*.test.cjs
.venv/bin/python -m unittest discover -s tests -v
docker compose config --quiet
```

`tests/fixtures.json` stores designs and SHA-256 result fingerprints generated from the pre-migration engine at commit `d23c75c`. The regressions cover blank and ideal paraxial lenses, PNP at three zoom positions, glass, a finite-conjugate asphere, IRG24, automatic vignetting, and image-space NA. Fingerprints round finite values to 10 significant digits and treat magnitudes below 1e-9 as zero to allow insignificant platform differences. Static-layout comparisons cover rays, aperture envelopes, and aperture specifications; moving-layout comparisons retain current-ray and aperture-specification checks while separately testing the signed-range envelope and legacy-coordinate conversion; performance comparisons cover all five stages' final data. Separate tests cover SEQ import, browser library operations, API routing, concurrency isolation, timeouts, cancellation, and lazy performance loading.

GitHub Actions runs these checks and builds/starts the Compose service, then tests the frontend and both calculation endpoints inside the container.
