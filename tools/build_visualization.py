"""Build the Model Atlas browser dataset from checked package outputs and pinned NWB files.

Run from the portfolio environment; no network, browser libraries or model refits are needed.
The standalone HTML embeds the same assets as visualization/index.html.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.integrate import solve_ivp

from membrane_report.recording import read_nwb
from membrane_report.synthetic import _hh_rhs
from membrane_report.hh import simulate_hh
from neural_budget.synapse import resource_state, depleted_budget
from thermal_response.derived import cycle_average
from neural_budget.model import ACTIVITY_DEPENDENT, GROUPS, cortical_budget
from neural_budget.params import reference_parameters, values
from thermal_response.models import get_model

ROOT = Path(__file__).resolve().parents[1]


def package_dir(root, name):
    original = root / name
    return original if original.exists() else root / name.replace("_", "-")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rounded(a, digits=6):
    a = np.asarray(a, float)
    if not np.all(np.isfinite(a)):
        raise ValueError("visualization samples must be finite")
    return np.round(a, digits).tolist()


def thermal_data(root):
    folder = package_dir(root, "thermal_response") / "reports/chlorella_tpc"
    run = json.loads((folder / "run.json").read_text())
    obs = pd.read_csv(folder / "observations.csv", dtype={"source_record_id": str})
    bands = pd.read_csv(folder / "predictions.csv")
    curves = []
    grid = np.linspace(11, 54, 431)
    for curve_id in run["selected_curves"]:
        fits = [c for c in run["curves"] if c["curve_id"] == curve_id and c["variant"] == "analysis"]
        points = obs[obs.curve_id == curve_id].drop_duplicates("source_record_id")
        models = {}
        for fit in fits:
            if fit["fit_status"] not in ("converged", "converged_at_bound"):
                raise ValueError(f"cannot visualize failed fit: {curve_id}")
            spec = get_model(fit["model"])
            theta = [fit["params"][p] for p in spec.params]
            rate = spec.predict(grid, theta, **fit["constants"])
            ci = bands[(bands.curve_id == curve_id) & (bands.variant == "analysis") &
                       (bands.model == spec.name)].sort_values("temperature_c")
            if ci.empty:
                raise ValueError(f"missing interval grid: {curve_id}/{spec.name}")
            def display_band(column):
                interpolated = np.interp(grid, ci.temperature_c, ci[column])
                return [round(float(x), 6) if ci.temperature_c.min() <= t <= ci.temperature_c.max()
                        else None for t, x in zip(grid, interpolated, strict=True)]
            models[spec.name] = {
                "rate": rounded(rate),
                "lo": display_band("ci95_lower"),
                "hi": display_band("ci95_upper"),
                "domain": fit["temp_range_c"],
                "optimum": fit["optimum"],
                "params": fit["params"], "constants": fit["constants"],
                "cycle_checks": [cycle_average(lambda t: spec.predict(t, theta, **fit["constants"]), mean, amplitude,
                                               observed_domain=fit["temp_range_c"])
                                 for mean, amplitude in [(25, 0), (25, 5), (30, 6), (40, 6)]],
            }
        meta = fits[0]["meta"]
        curves.append({
            "id": curve_id,
            "trait": "Photosynthesis" if "photosynthesis" in meta["trait"] else "Respiration",
            "rearing_c": meta["rearing_temperature"],
            "models": models,
            "observations": [{"t": float(row.temperature_c), "rate": float(row.response),
                              "id": row.source_record_id,
                              "excluded": bool(pd.notna(row.quality_flag) and str(row.quality_flag).strip())}
                             for row in points.itertuples()],
        })
    return {"temperatures": rounded(grid, 2), "curves": curves, "unit": "µmol O₂ / µg C / h",
            "citation": "Padfield et al. (2016), rTPC 1.1.0 cleaned Chlorella data",
            "source_url": "https://padpadpadpad.github.io/rTPC/reference/chlorella_tpc.html",
            "run_sha256": sha256(folder / "run.json"),
            "note": "Gaussian and Sharpe–Schoolfield fits to cleaned Chlorella observations. The shared y-scale preserves rate differences; peak normalization scales each curve separately. Crosses identify flagged, excluded values. Dashed sections extrapolate beyond each curve's observed temperature range. The 95% bands use a conditional bootstrap whose tested coverage was 87–91%. Residual lines connect observations to their fitted values. Sonification maps each cohort's relative response to oscillator gain; pitch identifies acclimation temperature."}


def peak_indices(v, start, stop, bins=2200):
    """Keep each time bin's actual minimum and maximum, ordered in original sample time."""
    if stop <= start or not np.all(np.isfinite(v[start:stop])):
        raise ValueError("a display window must contain finite recorded voltage")
    edges = np.unique(np.linspace(start, stop, min(bins, stop - start) + 1).astype(int))
    out = {start, stop - 1}
    for a, b in zip(edges[:-1], edges[1:]):
        chunk = v[a:b]
        out.update((a + int(np.argmin(chunk)), a + int(np.argmax(chunk))))
    return np.array(sorted(out))


def membrane_data(root):
    pkg = package_dir(root, "membrane_report")
    config = json.loads((pkg / "examples/cells.json").read_text())
    report = json.loads((pkg / "reports/dandi000020/cells.json").read_text())
    features = pd.read_csv(pkg / "reports/dandi000020/sweep_features.csv")
    qc = pd.read_csv(pkg / "reports/dandi000020/sweep_qc.csv")
    cells = []
    for entry, result in zip(config["cells"], report, strict=True):
        path = pkg / entry["path"]
        if sha256(path) != entry["sha256"]:
            raise ValueError(f"source checksum differs: {path}")
        cell, sweeps = read_nwb(path, entry["asset_id"],
                                {"X1PS_SubThresh", "X3LP_Rheo", "X4PS_SupraThresh"})
        if cell["cell_id"] != result["cell"]["cell_id"]:
            raise ValueError("NWB cell does not match the saved analysis")
        usable = features[(features.cell_id == cell["cell_id"]) & features.qc_pass].sort_values(
            "stimulus_amplitude_pa")
        passive = usable[usable.stimulus_amplitude_pa < 0]
        firing = usable[usable.spike_count > 0]
        picks = set()
        if len(passive):
            picks.update(int(x) for x in passive.iloc[[0, -1]].sweep_id)
        if len(firing):
            picks.update(int(x) for x in firing.iloc[[0, -1]].sweep_id)
        if not picks:
            raise ValueError(f"no QC-passing sweeps for {cell['cell_id']}")
        traces = []
        for sweep in sweeps:
            if sweep.sweep_id not in picks:
                continue
            f = usable[usable.sweep_id == sweep.sweep_id].iloc[0]
            q = qc[(qc.cell_id == cell["cell_id"]) & (qc.sweep_id == sweep.sweep_id)].iloc[0]
            # Show the main pulse plus baseline/recovery, not the initial test pulse or trailing zeros.
            start_s = max(0.0, float(q.stimulus_start_s) - 0.18)
            end_s = min(float(q.recording_end_s), float(q.stimulus_end_s) + 0.28)
            hz = sweep.sampling_rate_hz
            start, stop = int(round(start_s * hz)), int(round(end_s * hz))
            indices = peak_indices(sweep.voltage_volts, start, stop)
            # Retain both sides of command transitions even if voltage extrema omit them.
            transitions = [int(round(float(edge) * hz)) for edge in
                           (q.stimulus_start_s, q.stimulus_end_s)]
            extra = [i for edge in transitions for i in (edge - 1, edge)
                     if start <= i < stop]
            indices = np.union1d(indices, extra)
            ipfx = next(s for s in result["ipfx"]["sweeps"] if s["sweep_id"] == sweep.sweep_id)
            spikes = [float(q.stimulus_start_s) + t - start_s
                      for t in ipfx["spike_threshold_times_from_onset_s"]]
            role = next((p.get("role") for p in result["passive_sweeps"]
                         if p["sweep_id"] == sweep.sweep_id), "excluded")
            traces.append({
                "id": sweep.sweep_id, "protocol": sweep.protocol_name,
                "amplitude_pa": float(f.stimulus_amplitude_pa), "spikes": spikes,
                "spike_count": int(f.spike_count), "rate_hz": float(f.rate_hz), "qc_pass": True,
                "baseline_mv": float(f.baseline_v * 1000),
                "model_baseline_mv": float(np.mean(sweep.voltage_volts[
                    int(round((float(q.stimulus_start_s) - 0.1) * hz)):
                    int(round(float(q.stimulus_start_s) * hz))]) * 1000),
                "t": rounded(indices / hz - start_s),
                "v": rounded(sweep.voltage_volts[indices] * 1000, 4),
                "dvdt": rounded(np.gradient(sweep.voltage_volts * 1000,
                                              1000 / hz)[indices], 4),
                "i": rounded(sweep.injected_current_amperes[indices] * 1e12, 2),
                "on": float(q.stimulus_start_s) - start_s,
                "off": float(q.stimulus_end_s) - start_s,
                "duration": float((stop - 1) / hz - start_s), "sampling_hz": hz,
                "original_window_s": [start_s, end_s],
                "passive_role": role if role in ("train", "test") else None,
            })
        cells.append({"id": cell["cell_id"], "subject": cell["subject_id"],
                      "asset": entry["asset_id"], "sha256": entry["sha256"],
                      "fit": result["fit_train"], "traces": traces})
    return {"cells": cells, "citation": "Allen Institute · DANDI 000020 · v0.210913.1639",
            "source_url": "https://dandiarchive.org/dandiset/000020/0.210913.1639",
            "note": "Current-clamp voltage and command current from five mouse cells, restricted to QC-passing sweeps. Display sampling retains voltage extrema and command transitions. The phase plot uses derivatives computed on the original 50 kHz voltage samples. Spike markers and audio clicks use IPFX threshold times. The passive overlay uses the saved training fit on eligible subthreshold sweeps. The cell geometry is schematic. Voltage sonification maps −100 to +40 mV onto a logarithmic 110–1760 Hz pitch range."}


def hh_data():
    checks = []
    for drive, sodium, potassium in [(2, 120, 36), (7, 120, 36), (15, 120, 36),
                                     (7, 0, 36), (7, 120, 0), (7, 120, 18), (7, 180, 54)]:
        state = [-65, 0.0529, 0.5961, 0.3177]
        pieces = []
        for start, end, current in [(0, 50, 0), (50, 250, drive), (250, 300, 0)]:
            def rhs(t, y):
                v, m, h, n = y
                adjustment = (120 - sodium) * m ** 3 * h * (v - 50) + (36 - potassium) * n ** 4 * (v + 77)
                return _hh_rhs(t, y, lambda _: current + adjustment)
            grid = np.linspace(start, end, int((end - start) * 10) + 1)
            sol = solve_ivp(rhs, (start, end), state, t_eval=grid, method="DOP853",
                            max_step=0.05, rtol=1e-10, atol=1e-12)
            if not sol.success:
                raise ValueError("Hodgkin–Huxley reference integration failed")
            state = sol.y[:, -1]
            pieces.append((grid[:-1], sol.y[:, :-1]))
        t = np.concatenate([p[0] for p in pieces] + [np.array([300.0])])
        y = np.concatenate([p[1] for p in pieces] + [np.asarray(state)[:, None]], axis=1)
        crossing = (y[0, :-1] < 0) & (y[0, 1:] >= 0) & (t[1:] >= 50) & (t[1:] < 250)
        checks.append({"drive": drive, "sodium": sodium, "potassium": potassium,
                       "t": rounded(t[::10] / 1000), "state": rounded(y[:, ::10].T, 9),
                       "spike_count": int(crossing.sum())})
    for temperature, protocol, interval in [(16.3, "step", 12), (18.3, "step", 12),
                                            (6.3, "pair", 4), (6.3, "pair", 12), (6.3, "pair", 25),
                                            (16.3, "pair", 12)]:
        drive = 20 if protocol == "pair" else 7
        result = simulate_hh(drive, temperature_c=temperature, protocol=protocol, interval_ms=interval)
        checks.append({"drive": drive, "sodium": 120, "potassium": 36,
                       "temperature": temperature, "protocol": protocol, "interval": interval,
                       "t": rounded(result["t_ms"][::10] / 1000), "state": rounded(result["state"][::10], 9),
                       "spike_count": result["spike_count"]})
    return {"checks": checks, "citation": "Hodgkin–Huxley equations · membrane_report synthetic model",
            "source_url": "https://pubmed.ncbi.nlm.nih.gov/12991237/",
            "note": "A single-compartment Hodgkin–Huxley simulation with C = 1 µF/cm², gNa = 120, gK = 36 and gL = 0.3 mS/cm², and reversal potentials +50, −77 and −54.387 mV. The current step lasts from 50 to 250 ms. Controls vary current density and maximal channel conductance. Effective channel conductance is gNa × m³h or gK × n⁴, shown in the meters. Spike counts use upward 0 mV crossings. Browser integration uses RK4 at 0.01 ms and is checked against SciPy DOP853. Geometry is schematic. Audio clicks follow model spike times."}


def neural_data():
    v = values(reference_parameters())
    base = cortical_budget(v)
    release_keys = set(GROUPS["glutamate recycling"] + GROUPS["postsynaptic receptors"] +
                       GROUPS["presynaptic Ca2+ and vesicles"])
    ap_keys = set(GROUPS["action potentials"])
    coefficients = {}
    for name, value in base.components.items():
        if name in release_keys:
            coefficients[name] = {"kind": "release", "value": value / v["firing_rate"] / v["release_probability"]}
        elif name in ap_keys:
            coefficients[name] = {"kind": "spike", "value": value / v["firing_rate"] / v["na_overlap_factor"]}
        else:
            assert name not in ACTIVITY_DEPENDENT
            coefficients[name] = {"kind": "constant", "value": value}
    cases = []
    for firing, release, overlap in [(0, 0.25, 1.24), (3.8, 0.25, 1.24), (4, 0.25, 1.24),
                                      (7.8, 0.25, 1.24), (12, 1, 4), (2.5, 0, 2), (6.3, 0.62, 2.17)]:
        changed = dict(v, firing_rate=firing, release_probability=release, na_overlap_factor=overlap)
        budget = cortical_budget(changed)
        cases.append({"firing": firing, "release": release, "overlap": overlap,
                      "components": budget.components, "total": budget.umol_per_g_min(budget.total)})
    resource_checks = []
    for firing, release, recovery, initial, elapsed in [(4,.25,.8,1,0), (12,.25,.8,1,2),
                                                      (0,.25,.8,.2,.8), (7.8,.6,1.5,.7,1.2)]:
        resource = resource_state(firing, release, recovery, initial=initial, elapsed_s=elapsed)
        budget, result = depleted_budget(dict(v, firing_rate=firing, release_probability=release), recovery, resource=resource)
        resource_checks.append({"firing":firing, "release":release, "recovery":recovery, "initial":initial,
                                "elapsed":elapsed, **result, "components":budget.components,
                                "total":budget.umol_per_g_min(budget.total)})
    return {"coefficients": coefficients, "groups": GROUPS,
            "conversion": base.umol_per_g_min(1), "housekeeping_fraction": base.housekeeping_fraction,
            "reference": {"firing": v["firing_rate"], "release": v["release_probability"],
                          "overlap": v["na_overlap_factor"]}, "checks": cases, "resource_checks":resource_checks,
            "citation": "Howarth, Gleeson & Attwell (2012) · rodent cortex model",
            "source_url": "https://doi.org/10.1038/jcbfm.2012.35",
            "note": "ATP demand calculated from the Howarth et al. cortical budget. Ribbons split process totals into receptor types, neuronal compartments and resting costs; width follows absolute demand. Gray ribbons show the 4 Hz reference. Firing rate, release probability and Na⁺ overlap update exported Python coefficients. Source assumptions include doubled vesicle costs and spreadsheet glial scaling. Housekeeping is one third of signaling demand. Source parameter uncertainty is unspecified. Sonification assigns a pitch to each process and maps demand to bounded oscillator gain."}


def build(root=ROOT, output=None, toy_output=None):
    directory = ROOT / "visualization"
    data = {"schema": "living_systems.atlas/1", "thermal": thermal_data(root),
            "membrane": membrane_data(root), "neural": neural_data(), "hh": hh_data()}
    data["research"] = json.loads((directory / "research.json").read_text())
    data["thermal"]["note"] += " Temperature variation averages the instantaneous fit over a sinusoidal cycle; it does not model acclimation, damage or exposure duration."
    data["hh"]["note"] += " This is the classic squid-axon model at 6.3 °C. Temperature scales all gate rates by 3^((T−6.3)/10), while reversal potentials remain fixed. Paired-pulse mode applies two 2 ms pulses; the interval is measured onset to onset."
    data["neural"]["note"] += " Optional vesicle depletion uses a reduced mean-field resource model and effective release U×R. Recovery time is an illustrative control; facilitation and activity-dependent recovery are omitted."
    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    # Prevent script termination if a future source label contains HTML.
    encoded = encoded.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    data_js = "// Generated by tools/build_visualization.py; source data stays unchanged.\nwindow.ATLAS_DATA=" + encoded + ";\n"
    (directory / "data.js").write_text(data_js)
    if output or toy_output:
        html = (directory / "index.html").read_text()
        css = (directory / "atlas.css").read_text()
        model_js = (directory / "model.js").read_text()
        audio_js = (directory / "audio.js").read_text()
        app_js = (directory / "atlas.js").read_text()
        html = html.replace('<link rel="stylesheet" href="atlas.css">', f"<style>{css}</style>")
        agent_js = (directory / "agent.js").read_text()
        for name, source in [("data.js", data_js), ("model.js", model_js), ("audio.js", audio_js), ("atlas.js", app_js), ("agent.js", agent_js)]:
            html = html.replace(f'<script src="{name}" defer></script>', f"<script defer>{source}</script>")
        if output:
            output = Path(output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(html)
        if toy_output:
            toy = html.replace('<body data-scene="thermal">', '<body data-scene="membrane" data-default-scene="membrane" data-default-mode="hh">')
            toy = toy.replace("<title>Model Atlas</title>", "<title>Biological Models — Sound Toys</title>")
            toy_output = Path(toy_output)
            toy_output.parent.mkdir(parents=True, exist_ok=True)
            toy_output.write_text(toy)
    print(f"Built {len(data['thermal']['curves'])} curves, {len(data['membrane']['cells'])} cells, "
          f"{sum(len(c['traces']) for c in data['membrane']['cells'])} recorded sweeps. "
          f"Data: {len(data_js):,} characters.")
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="also write a self-contained offline HTML")
    parser.add_argument("--toy-output", type=Path, help="write the Sound Toys version, opening the HH simulation")
    parser.add_argument("--package-root", type=Path, required=True, help="parent directory containing the three Python package repositories")
    args = parser.parse_args()
    build(root=args.package_root, output=args.output, toy_output=args.toy_output)
