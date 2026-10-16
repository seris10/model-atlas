# Model Atlas

Work in progress; development and validation are ongoing.

A browser visualization of thermal performance curves, neuronal membrane recordings, Hodgkin–Huxley simulations, and cortical ATP budgets. Canvas rendering and Web Audio synthesis run locally in the browser. The Cloudflare Pages backend provides model calculations, source access, and optional expiring links to a shared browser view.

[Open Model Atlas](https://atlas.relay70.dev/).

## Run locally

The checked-in browser dataset is sufficient to build the site. Building requires Python 3.11 or later and Node.js 22 or later; it uses the Python standard library and the browser model equations. Node.js dependencies are for the local Cloudflare runtime.

```sh
npm ci
npm run build
npm run db:init
npm run dev
```

Open `http://localhost:8791`. The local D1 configuration uses a placeholder database ID and stores data under `.wrangler/`. The build is written to the adjacent `model-atlas-build` directory. The builder requires an empty output directory to prevent stale files from entering a deployment; provide a new path with `python3 tools/build_site.py ../another-build` for subsequent builds.

For a static preview, run `python3 -m http.server 8791 --directory visualization`. The visualization works in this mode; HTTP model/source routes and shared-view storage require the Worker runtime above.

## Data and models

- **Thermal:** six selected cleaned *Chlorella vulgaris* curves, fitted by Gaussian and Sharpe–Schoolfield models. Controls compare model families, residuals, uncertainty bands, and time averages under a sinusoidal temperature cycle.
- **Membrane:** sampled voltage/current traces from five Allen Institute mouse cells, with source asset identifiers and checksums. A separate squid-axon Hodgkin–Huxley model supports conductance changes, temperature scaling, and paired pulses.
- **Energy:** the Howarth et al. cortical ATP budget, with firing-rate, release-probability, sodium-overlap, housekeeping, and optional synaptic-depletion controls.

Source and model limitations are available through the Sources control. Motion, cell geometry, particles, and sonification are illustrative. The recorded traces remain distinct from simulated trajectories. Numerical agreement with published equations does not establish physiological or predictive accuracy.

`visualization/data.js` contains the browser dataset, numerical reference cases, citations, and provenance. `visualization/research.json` identifies the temperature-cycle and synaptic-resource extensions. The original NWB recordings and XLS workbook are not bundled.

## Python packages and data regeneration

The Python implementations are independently installable repositories:

- [thermal-response](https://github.com/seris10/thermal-response)
- [membrane-report](https://github.com/seris10/membrane-report)
- [neural-budget](https://github.com/seris10/neural-budget)

For regeneration, place these three repositories beside `model-atlas`. From this repository, install all three into one environment:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r ../thermal-response/requirements-tested.txt -r ../membrane-report/requirements-tested.txt -r ../neural-budget/requirements-tested.txt ../thermal-response ../membrane-report ../neural-budget
source .venv/bin/activate
```

Produce the analysis outputs from each package root using that environment:

```sh
(cd ../thermal-response && thermal-response fit examples/chlorella_tpc_observations.csv --config examples/analysis.toml --out reports/chlorella_tpc)
(cd ../membrane-report && membrane-report fetch --config examples/cells.json)
(cd ../membrane-report && membrane-report analyze --config examples/cells.json --out reports/dandi000020)
python tools/build_visualization.py --package-root ..
python tools/build_site.py ../new-build
```

The generator rewrites `visualization/data.js`; the site builder stages the resulting application. Thermal and membrane analysis outputs are inputs to the generator and are not published by the site builder. The neural coefficients are computed directly from its packaged reference parameters. Data regeneration with the pinned source files reproduces the included browser dataset; the thermal fit and bootstrap calculation take substantially longer than staging the site.

## Checks

With the local Worker running, install browser-test dependencies in a virtual environment:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements-checks.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python tools/check_agent_access.py http://localhost:8791
```

The browser checks use Playwright Chromium. Set `ATLAS_BROWSER_CHANNEL=chrome` to use an existing Google Chrome installation instead. The HTTP/MCP check exercises model calculations, source pagination and path guards, view sharing, writer authorization, revocation, and narrow layouts. It creates and deletes a local temporary shared view.

With all three Python packages installed in that environment, `python tools/check_extensions.py http://localhost:8791` compares browser models with Python results and checks the temperature-cycle, pulse-pair, and depletion controls. After regenerating the data from the pinned sources, `python tools/check_visualization.py --package-root ..` checks samples against NWB files, model parity, controls, audio signals, and layouts. Browser emulation does not establish physical-device, Safari, or screen-reader behavior.

## Deployment and backend

Deploy only a fresh output from `tools/build_site.py`. The application uses Cloudflare Pages advanced mode, and the optional sharing feature requires a D1 binding named `ATLAS_SESSIONS` initialized with `backend/schema.sql`. The local placeholder configuration is not a production database configuration.

For the existing hosted project, change into the staged build directory and run `wrangler pages deploy . --project-name=relay70-atlas --branch=main` with authorized Cloudflare credentials and its existing production D1 binding. A new project needs its own D1 database and binding. Check `/api/health`, `/api/catalog`, all three scenes, and the published source hashes after deployment. The builder emits `no-transform` cache headers so host-injected scripts do not change HTML bytes.

The backend exposes `/api/catalog`, `/api/source`, `/api/behavior`, `/api/experiment`, and `/mcp`. Public source access is an explicit file allowlist. Sharing starts only through the Share live view button. Browser memory holds a writer capability; read links expire after one hour, and Stop sharing deletes the stored view.

## Sources and licensing

See [third-party-notices.txt](third-party-notices.txt) for data and model attribution. Thermal data/equations derived from rTPC retain GPL-3.0-or-later terms; Allen Institute recording derivatives retain CC-BY-4.0 attribution; the Howarth workbook's source-use terms remain attached to its extracted values. No additional reuse license is granted for the remaining atlas interface and backend.
