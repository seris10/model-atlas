"""Check atlas source fidelity, browser/Python numerical parity and interactive behavior.

Requires the portfolio environment (including Playwright) and installed Chrome.
Run after build_visualization.py; optional --standalone checks the exported offline HTML too.
"""

from __future__ import annotations
import os

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

from membrane_report.passive import step_response
from membrane_report.recording import read_nwb
from neural_budget.model import cortical_budget
from neural_budget.params import reference_parameters, values
from thermal_response.models import get_model

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT.parent


def package_dir(name):
    original = PACKAGE_ROOT / name
    return original if original.exists() else PACKAGE_ROOT / name.replace("_", "-")


def atlas_data():
    source = (ROOT / "visualization/data.js").read_text()
    return json.loads(source.split("window.ATLAS_DATA=", 1)[1].rstrip(";\n"))


def check_thermal(data):
    folder = package_dir("thermal_response") / "reports/chlorella_tpc"
    run_path = folder / "run.json"
    assert hashlib.sha256(run_path.read_bytes()).hexdigest() == data["thermal"]["run_sha256"]
    run = json.loads(run_path.read_text())
    grid = data["thermal"]["temperatures"]
    assert len(data["thermal"]["curves"]) == 6
    for curve in data["thermal"]["curves"]:
        for name, samples in curve["models"].items():
            fit = next(c for c in run["curves"] if c["curve_id"] == curve["id"] and
                       c["model"] == name and c["variant"] == "analysis")
            model = get_model(name)
            expected = model.predict(grid, [fit["params"][p] for p in model.params], **fit["constants"])
            np.testing.assert_allclose(samples["rate"], expected, atol=5.01e-7, rtol=0)
            assert samples["domain"] == fit["temp_range_c"]
            assert samples["optimum"]["support"] == fit["optimum"]["support"]
    print("PASS: 12 thermal model grids, observation domains and optimum support")


def check_recordings(data):
    config = json.loads((package_dir("membrane_report") / "examples/cells.json").read_text())
    count = 0
    for entry, display in zip(config["cells"], data["membrane"]["cells"], strict=True):
        path = package_dir("membrane_report") / entry["path"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == display["sha256"]
        cell, sweeps = read_nwb(path, entry["asset_id"],
                                {"X1PS_SubThresh", "X3LP_Rheo", "X4PS_SupraThresh"})
        assert cell["cell_id"] == display["id"]
        for trace in display["traces"]:
            raw = next(s for s in sweeps if s.sweep_id == trace["id"])
            start, end = trace["original_window_s"]
            indices = np.rint((np.array(trace["t"]) + start) * raw.sampling_rate_hz).astype(int)
            assert np.all(np.diff(trace["t"]) > 0) and trace["qc_pass"]
            np.testing.assert_allclose(trace["v"], raw.voltage_volts[indices] * 1000, atol=5.01e-5, rtol=0)
            np.testing.assert_allclose(trace["i"], raw.injected_current_amperes[indices] * 1e12, atol=0.00501, rtol=0)
            derivative = np.gradient(raw.voltage_volts * 1000, 1000 / raw.sampling_rate_hz)
            np.testing.assert_allclose(trace["dvdt"], derivative[indices], atol=5.01e-5, rtol=0)
            a, b = int(round(start * raw.sampling_rate_hz)), int(round(end * raw.sampling_rate_hz))
            assert abs(min(trace["v"]) - raw.voltage_volts[a:b].min() * 1000) < 5.01e-5
            assert abs(max(trace["v"]) - raw.voltage_volts[a:b].max() * 1000) < 5.01e-5
            count += 1
    assert count == 20
    print("PASS: 20 recorded sweeps match pinned NWB samples, units, voltage extrema and derivatives")


def set_range(page, selector, value):
    page.locator(selector).evaluate("(element, value) => { element.value = value; element.dispatchEvent(new Event('input', {bubbles:true})); }", value)


def check_browser(data, standalone=None, screenshots=None):
    errors, failures, requests = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("ATLAS_BROWSER_CHANNEL"), headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("requestfailed", lambda r: failures.append(r.url))
        page.on("request", lambda r: requests.append(r.url))
        page.goto((ROOT / "visualization/index.html").as_uri())
        page.wait_for_function("!!window.livingSystems")
        assert not page.evaluate("livingSystems.snapshot().playing")
        assert page.evaluate("livingSystems.snapshot().audio.state") == "uninitialized"

        # Compare displayed rates across every source curve and both model families.
        for curve in data["thermal"]["curves"]:
            page.locator("#curve").select_option(curve["id"])
            for model, samples in curve["models"].items():
                page.locator(f'[data-model="{model}"]').click()
                for temp in (11, 30, 54):
                    set_range(page, "#temperature", temp)
                    expected = np.interp(temp, data["thermal"]["temperatures"], samples["rate"])
                    assert abs(float(page.locator("#secondary-value").inner_text()) - expected) <= 0.000501
                    outside = not samples["domain"][0] <= temp <= samples["domain"][1]
                    assert ("Extrapolated" in page.locator("#result-state").inner_text()) == outside
                assert ("not located" in page.locator("#result-detail").inner_text()) == (samples["optimum"]["support"] != "supported")
        # Pointer and keyboard scrubbing must change the same authoritative state.
        page.locator("#world").click(position={"x": 600, "y": 350})
        before = page.evaluate("livingSystems.snapshot().temperature")
        page.locator("#world").press("ArrowRight")
        assert page.evaluate("livingSystems.snapshot().temperature") > before
        page.locator('[data-model="gaussian_1987"]').click()
        page.locator("#uncertainty-toggle").click()
        page.locator("#reset").click()
        reset = page.evaluate("livingSystems.snapshot()")
        assert reset["temperature"] == 30 and reset["curve"] == "chlorella_tpc:49"
        assert reset["model"] == "sharpeschoolhigh_1981" and reset["uncertainty"]
        initial_rate = page.locator("#secondary-value").inner_text()
        initial_image = page.locator("#world").evaluate("el => el.toDataURL()")
        set_range(page, "#vertical-zoom", 1.5)
        page.locator("#model-compare").click()
        page.locator("#residual-toggle").click()
        page.locator("#rate-scale").select_option("normalized")
        assert page.locator("#secondary-value").inner_text() == initial_rate
        assert page.locator("#world").evaluate("el => el.toDataURL()") != initial_image
        page.locator("#reset").click()

        page.locator('[data-scene="membrane"]').click()
        for i, cell in enumerate(data["membrane"]["cells"]):
            page.locator("#cell").select_option(str(i))
            for j, trace in enumerate(cell["traces"]):
                page.locator("#sweep").select_option(str(j))
                set_range(page, "#time", 500)
                expected = np.interp(trace["duration"] / 2, trace["t"], trace["v"])
                assert abs(float(page.locator("#primary-value").inner_text()) - expected) <= 0.051
                eligible = bool(trace["passive_role"])
                assert page.locator("#passive-toggle").is_enabled() == eligible
                if eligible:
                    page.locator("#passive-toggle").click()
                    times = [0, trace["on"], trace["on"] + 0.002, trace["off"], trace["off"] + 0.02]
                    expected = step_response(times, trace["on"], trace["off"], trace["amplitude_pa"] * 1e-12,
                                             cell["fit"]["r_in_mohm"] * 1e6, cell["fit"]["tau_ms"] / 1000,
                                             trace["model_baseline_mv"] / 1000) * 1000
                    actual = page.evaluate("([trace, fit, times]) => times.map(t => AtlasModel.passive(trace, fit, t))",
                                           [trace, cell["fit"], times])
                    np.testing.assert_allclose(actual, expected, atol=1e-11, rtol=1e-12)
        page.locator("#cell").select_option("0")
        selected = page.evaluate("livingSystems.snapshot().sweep")
        assert data["membrane"]["cells"][0]["traces"][selected]["spike_count"] == max(
            t["spike_count"] for t in data["membrane"]["cells"][0]["traces"])
        page.locator("#motion-toggle").click()
        before = page.evaluate("livingSystems.snapshot().time")
        page.wait_for_function("previous => livingSystems.snapshot().time !== previous", arg=before)
        page.locator("#motion-toggle").click()
        paused = page.evaluate("livingSystems.snapshot()")
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        assert page.evaluate("livingSystems.snapshot().time") == paused["time"]
        page.locator("#next-spike").click()
        spike_view = page.evaluate("livingSystems.snapshot()")
        assert spike_view["window"] == 0.02
        trace = data["membrane"]["cells"][0]["traces"][spike_view["sweep"]]
        assert min(abs(spike_view["time"] * trace["duration"] - ts - 0.001) for ts in trace["spikes"]) < 1e-10

        page.locator("#membrane-mode").select_option("hh")
        assert page.locator("#passive-toggle").is_disabled()
        for case in data["hh"]["checks"]:
            actual = page.evaluate("c => { const tr = AtlasModel.hhTrace(c.drive,c.sodium,c.potassium,c); return {v:c.t.map(t=>AtlasModel.interpolate(tr.t,tr.v,t)),spikes:tr.spike_count,gates:tr.gates} }", case)
            np.testing.assert_allclose(actual["v"], np.array(case["state"])[:, 0], atol=0.0002, rtol=0)
            assert actual["spikes"] == case["spike_count"]
            assert np.all((np.array(actual["gates"]) >= 0) & (np.array(actual["gates"]) <= 1))
        set_range(page, "#hh-current", 7)
        set_range(page, "#sodium", 0)
        assert "0 spikes" in page.locator("#result-detail").inner_text()
        set_range(page, "#sodium", 120)
        assert "12 spikes" in page.locator("#result-detail").inner_text()
        page.locator("#world").focus()
        page.locator("#world").press("ArrowUp")
        assert page.evaluate("livingSystems.snapshot().hhCurrent") == 7.5
        set_range(page, "#hh-current", 7)
        # Canvas channel meters operate the same conductances as the sliders.
        page.locator("#world").click(position={"x": 1144, "y": 358})
        assert page.evaluate("livingSystems.snapshot().sodium") == 0
        page.locator("#world").click(position={"x": 1144, "y": 358})
        assert page.evaluate("livingSystems.snapshot().sodium") == 120
        page.locator("#source-button").click()
        assert "0.01 ms" in page.locator("#source-note").inner_text()
        page.locator("#close-sources").click()
        page.locator("#membrane-mode").select_option("recorded")

        page.locator('[data-scene="neural"]').click()
        base = values(reference_parameters())
        for case in data["neural"]["checks"]:
            for name in ("firing", "release", "overlap"):
                set_range(page, f"#{name}", case[name])
            expected = cortical_budget(dict(base, firing_rate=case["firing"], release_probability=case["release"],
                                             na_overlap_factor=case["overlap"]))
            actual = page.evaluate("livingSystems.snapshot().budget")
            for key, value in expected.components.items():
                assert np.isclose(actual["components"][key], expected.umol_per_g_min(value), rtol=1e-12, atol=1e-12)
            assert np.isclose(actual["total"], expected.umol_per_g_min(expected.total), rtol=1e-12)
            assert abs(float(page.locator("#primary-value").inner_text()) - actual["total"]) <= 0.00501
        page.locator("#scenario").select_option("silent")
        zero = page.evaluate("livingSystems.snapshot().budget")
        for group in ("glutamate recycling", "postsynaptic receptors", "presynaptic Ca2+ and vesicles", "action potentials"):
            assert zero["groups"][group] == 0
        assert zero["groups"]["resting potentials"] > 0 and zero["housekeeping"] > 0
        page.locator("#housekeeping-toggle").click()
        assert page.evaluate("livingSystems.snapshot().budget.housekeeping") == 0
        page.locator("#reset").click()
        assert page.evaluate("livingSystems.snapshot().firing") == 4
        page.locator("#process").select_option("action potentials")
        assert page.locator("#result-state").inner_text() == "Action potentials"
        page.locator("#source-button").click()
        assert page.locator("#sources-dialog").evaluate("el => el.open")
        assert "Howarth" in page.locator("#source-citation").inner_text()
        page.locator("#close-sources").press("Escape")
        assert not page.locator("#sources-dialog").evaluate("el => el.open")
        assert page.locator("#source-button").evaluate("el => el === document.activeElement")
        old_rate = page.evaluate("livingSystems.snapshot().firing")
        page.locator("#world").focus()
        page.locator("#world").press("ArrowRight")
        assert page.evaluate("livingSystems.snapshot().firing") > old_rate
        page.locator("#reset").click()

        # Real Web Audio nodes must produce a signal, follow source spike timing and stop on mute.
        page.locator('[data-scene="thermal"]').click()
        page.locator("#motion-toggle").click()
        page.locator("#audio-toggle").click()
        page.wait_for_function("livingSystems.snapshot().audio.rms > 0.0001")
        page.locator('[data-scene="membrane"]').click()
        page.wait_for_function("livingSystems.snapshot().audio.scheduled.length >= 3")
        scheduled = page.evaluate("livingSystems.snapshot().audio.scheduled")
        for a, b in zip(scheduled, scheduled[1:]):
            if a["key"] == b["key"]:
                assert abs((b["audioTime"] - a["audioTime"]) - (b["dataTime"] - a["dataTime"]) / a["speed"]) < 1e-9
        page.locator("#audio-mode").select_option("voltage")
        page.wait_for_function("livingSystems.snapshot().audio.rms > 0.0001")
        page.locator("#audio-toggle").click()
        page.wait_for_function('livingSystems.snapshot().audio.state === "suspended"')
        muted = page.evaluate("livingSystems.snapshot().audio")
        assert not muted["enabled"] and muted["pending"] == 0 and muted["rms"] < 0.0001
        page.locator("#motion-toggle").click()
        pcm = page.evaluate("async () => { const b=await AtlasAudio.renderSpikes([0.02,0.10,0.19],1,0.3);return Array.from(b.getChannelData(0)); }")
        assert max(abs(x) for x in pcm[:int(0.019 * 22050)]) == 0
        for start in (0.02, 0.10, 0.19):
            assert max(abs(x) for x in pcm[int(start * 22050):int((start + 0.024) * 22050)]) > 0.05
        assert max(abs(x) for x in pcm[int(0.22 * 22050):]) == 0

        for viewport in [{"width": 1440, "height": 1000}, {"width": 768, "height": 1024}, {"width": 390, "height": 844}, {"width": 320, "height": 700}]:
            page.set_viewport_size(viewport)
            for scene in ("thermal", "membrane", "neural"):
                page.locator(f'button[data-scene="{scene}"]').click()
                assert page.evaluate("document.documentElement.scrollWidth") <= viewport["width"]
                for control in page.locator(f"#{scene}-controls input, #{scene}-controls select, #{scene}-controls button").all():
                    if control.is_visible():
                        box = control.bounding_box()
                        assert box["x"] >= 0 and box["x"] + box["width"] <= viewport["width"] + 0.1
                if screenshots and viewport["width"] in (1440, 390):
                    page.screenshot(path=str(screenshots / f"atlas-{scene}-{viewport['width']}.png"), full_page=True)
            page.locator('[data-scene="membrane"]').click()
            page.locator("#membrane-mode").select_option("hh")
            assert page.evaluate("document.documentElement.scrollWidth") <= viewport["width"]
            if screenshots and viewport["width"] in (1440, 390):
                page.screenshot(path=str(screenshots / f"atlas-hh-{viewport['width']}.png"), full_page=True)
            page.locator("#membrane-mode").select_option("recorded")
        if standalone:
            page.goto(Path(standalone).resolve().as_uri())
            page.wait_for_function("!!window.livingSystems")
            page.locator('[data-scene="neural"]').click()
            assert page.locator("#primary-value").inner_text() == "27.16"
            for scene in ("thermal", "membrane", "neural"):
                page.locator(f'button[data-scene="{scene}"]').click()
                page.locator("#source-button").click()
                assert page.locator("#source-note").inner_text()
                page.locator("#close-sources").click()
        assert not errors, errors
        assert not failures, failures
        assert not [u for u in requests if u.startswith(("http:", "https:"))], "unexpected external request"
        browser.close()
    print("PASS: browser/Python parity, all controls, playback, keyboard, source dialog and reduced motion")
    print(f"PASS: {len(data['hh']['checks'])} Hodgkin–Huxley cases vs SciPy, channel perturbations and spike detail")
    print("PASS: Web Audio signal, source event timing, mute and offline pulse rendering")
    print("PASS: desktop/tablet/phone layouts (1440, 768, 390, 320 px), no external requests or browser errors")
    if standalone:
        print("PASS: standalone offline HTML")


def main():
    global PACKAGE_ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--standalone", type=Path)
    parser.add_argument("--screenshots", type=Path, help="optional QA screenshot directory")
    parser.add_argument("--package-root", type=Path, default=ROOT.parent)
    args = parser.parse_args()
    PACKAGE_ROOT = args.package_root
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    data = atlas_data()
    assert data["schema"] == "living_systems.atlas/1"
    check_thermal(data)
    check_recordings(data)
    check_browser(data, args.standalone, args.screenshots)


if __name__ == "__main__":
    main()
