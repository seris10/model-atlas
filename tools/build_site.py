"""Stage an allowlisted public atlas, source archive, and Cloudflare Pages backend.

Only the explicit public files below are published. Raw NWB binaries retain their source URLs.
The staged tree is self-contained and can be deployed from any working directory.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


def build_site(output):
    output = output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError("Stage outside the source repository")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a new empty stage; this prevents publishing stale or unlisted files")
    output.mkdir(parents=True, exist_ok=True)
    # Parse the generated browser data without executing JavaScript.
    data_text = (ROOT / "visualization/data.js").read_text()
    data = json.loads(data_text.split("window.ATLAS_DATA=", 1)[1].rstrip(";\n"))
    for name in ["index.html", "atlas.css", "data.js", "model.js", "audio.js", "atlas.js", "agent.js"]:
        shutil.copyfile(ROOT / "visualization" / name, output / name)
    write_json(output / "data/thermal.json", data["thermal"])
    write_json(output / "data/neural.json", data["neural"])
    write_json(output / "research.json", data["research"])
    traces = []
    for cell_index, cell in enumerate(data["membrane"]["cells"]):
        for trace in cell["traces"]:
            key = f"cell-{cell_index + 1}-sweep-{trace['id']}"
            url = f"/data/traces/{key}.json"
            write_json(output / url[1:], trace)
            traces.append({"id": key, "url": url, "kind": "recorded", "cell": cell["id"], "sweep": trace["id"],
                           "amplitude_pa": trace["amplitude_pa"], "spike_count": trace["spike_count"],
                           "asset_id": cell["asset"], "source_sha256": cell["sha256"]})
    # Node evaluates the same checked RK4 browser equations for public reference trajectories.
    import subprocess
    node = subprocess.run(["node", "-e", "const M=require(process.argv[1]);const checks=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(checks.map(c=>M.hhTrace(c.drive,c.sodium,c.potassium,c))));",
                           str(ROOT / "visualization/model.js"), json.dumps(data["hh"]["checks"])],
                          capture_output=True, text=True, check=True)
    for index, trace in enumerate(json.loads(node.stdout)):
        key = f"hh-{index + 1}"
        url = f"/data/traces/{key}.json"
        write_json(output / url[1:], trace)
        traces.append({"id": key, "url": url, "kind": "Hodgkin-Huxley reference", "drive": trace["drive"],
                       "sodium": trace["sodium"], "potassium": trace["potassium"], "spike_count": trace["spike_count"],
                       "temperature": trace["temperature"], "protocol":trace["protocol"], "interval":trace["interval"]})
    public = [ROOT / name for name in [
        "README.md", "third-party-notices.txt", "licenses/gpl-3.0.txt",
        "package.json", "requirements-checks.txt", "wrangler.toml",
        "visualization/index.html", "visualization/atlas.css", "visualization/model.js",
        "visualization/audio.js", "visualization/atlas.js", "visualization/agent.js",
        "visualization/research.json", "backend/worker.js", "backend/schema.sql", "backend/agent.html",
        "tools/build_site.py", "tools/build_visualization.py", "tools/check_agent_access.py",
        "tools/check_extensions.py", "tools/check_visualization.py",
    ]]
    files = []
    for path in sorted(set(public)):
        if not path.exists():
            continue
        key = str(path.relative_to(ROOT))
        text = path.read_text()
        published = text
        target = output / "source" / (key + ".txt")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(published)
        files.append({"path": key, "url": "/source/" + key + ".txt", "kind": path.suffix[1:],
                      "bytes": len(published.encode()), "sha256": hashlib.sha256(published.encode()).hexdigest(),
                      "local_paths_redacted": published != text})
    files.append({"path":"visualization/data.js", "url":"/data.js", "kind":"generated data",
                  "bytes":len(data_text.encode()), "sha256":hashlib.sha256(data_text.encode()).hexdigest(),
                  "local_paths_redacted":False})
    behavior = {
        "common": {"renderer": "Canvas 2D with requestAnimationFrame", "state_api": "window.livingSystems.snapshot(), .inspect(), .trace()",
                   "frame_api": "window.AtlasAgent.frame()", "audio": "Web Audio synthesis, explicit enable, no microphone",
                   "motion": "Pause/Play, visibility suspension, reduced-motion starts paused", "source": "/source/visualization/atlas.js.txt"},
        "scenes": {
            "thermal": {"background": "#102a2b", "accent": "#dbe8a0", "axes": ["assay temperature °C", "predicted rate µmol O2/µg C/h", "acclimation cohort"],
                        "animation": "Assay temperature advances at 1.4 °C/s, wraps from 54 to 11 °C; a vertical plane intersects fitted ridges. Particles illustrate normalized response.",
                        "data_encoding": "Ridge height is rate; shared y-axis preserves magnitude, normalized mode rescales each curve. Dots are observed, crosses excluded, dashes extrapolated. Bands are conditional bootstrap intervals.",
                        "interactions": ["temperature slider / horizontal scrub", "curve/cohort selection", "vertical magnification", "model family", "model comparison", "residuals", "uncertainty"],
                        "audio": "Pitch = 110*2^((acclimation-20)/8) Hz; gain = relative fitted response *0.12; illustrative sonification."},
            "membrane": {"background": "#17252e", "accent": "#cbbeef", "axes": ["time s", "voltage mV", "phase dV/dt mV/ms"],
                         "animation": "Playback advances at chosen speed through recorded voltage or HH simulation. Soma color maps voltage; spike rings are schematic.",
                         "data_encoding": "Voltage and current trace; raster marks source threshold times or model 0 mV crossings; phase portrait V versus dV/dt; HH meters display gNa*m^3*h and gK*n^4.",
                         "interactions": ["cell/sweep selection", "time scrub / trace zoom / next spike", "passive training fit", "HH conductance and current sliders", "soma drag changes current", "channel meter toggles conductance"],
                         "equations": "C*dV/dt = I - gNa*m^3*h*(V-ENa) - gK*n^4*(V-EK) - gL*(V-EL); gate dx/dt = alpha*(1-x)-beta*x; C1,gNa120,gK36,gL0.3; ENa50,EK-77,EL-54.387.",
                         "audio": "Spike clicks preserve inter-event spacings divided by playback speed. Voltage pitch: 110*16^clamp((V+100)/140,0,1) Hz."},
            "neural": {"background": "#292925", "accent": "#f6c085", "axes": ["process hierarchy", "absolute ATP demand µmol/g/min"],
                       "animation": "Particles move through accounting ribbons; particle geometry is illustrative, not measured molecular transport.",
                       "data_encoding": "Width scales absolute ATP demand with a fixed physical scale. Reference widths use 4Hz, p0.25, overlap1.24. Branches resolve receptors and compartments.",
                       "interactions": ["firing / release / overlap sliders", "reference/sleep/running/zero scenario", "process highlight", "housekeeping toggle", "direct ATP-node drag changes firing"],
                       "equations": "Release-dependent coefficients multiply firing*release; AP coefficients multiply firing*overlap; resting coefficients remain constant. Housekeeping = signaling/3 in this reference model.",
                       "audio": "Six process pitches 110*2^(i/2) Hz with bounded gain proportional to ATP demand."}
        }
    }
    write_json(output / "behavior.json", behavior)
    behavior["scenes"]["thermal"]["extensions"] = {"temperature_cycle": "Mean fixed; instantaneous T=mean+A*sin(2π*clock/12). 12 animation seconds represents one phase cycle; no biological exposure-duration claim. Amber line is the cycle-averaged rate; range shading is temperature variation, not a confidence band."}
    behavior["scenes"]["membrane"]["extensions"] = {"temperature": "Squid-axon kinetic factor 3^((T-6.3)/10); reversal potentials fixed.", "pulse_pair": "Two 2 ms pulses at 50 ms and 50 ms+interval; gate h reports sodium availability and n potassium activation before pulse 2."}
    behavior["scenes"]["neural"]["extensions"] = {"depletion": "Optional one-pool mean-field resource model: R'=(1-R)/tau-U*f*R. Available-resource dots and U×R update ATP widths; source per-event cost assumptions retained. Model time advances only while this scene plays."}
    write_json(output / "behavior.json", behavior)
    version = hashlib.sha256("".join(f["sha256"] for f in files).encode()).hexdigest()[:16]
    catalog = {"name": "Model Atlas", "schema": "atlas.access/1", "version": version,
               "built_at": datetime.now(timezone.utc).isoformat(), "canonical_url": "https://atlas.relay70.dev",
               "scenes": list(behavior["scenes"]), "files": files, "traces": traces,
               "citations": [{"scene": key, "citation": data[key]["citation"], "url": data[key]["source_url"], "limitations": data[key]["note"]} for key in ["thermal", "membrane", "neural", "hh"]],
               "access": {"mcp": "/mcp", "rest": "/api/catalog", "behavior": "/api/behavior", "source": "/api/source?path=visualization/atlas.js",
                          "experiment": "/api/experiment", "views": "/api/views/{id}", "browser": "window.livingSystems.inspect()"},
               "data": {"thermal": "/data/thermal.json", "neural": "/data/neural.json", "recordings": "See traces; pinned NWB binary source URLs remain with DANDI."}}
    catalog["research"] = data["research"]
    write_json(output / "manifest.json", catalog)
    model_code = (ROOT / "visualization/model.js").read_text()
    model_code = re.sub(r'  if \(typeof module[^\n]+\n', '', model_code)
    worker = model_code + "\n" + (ROOT / "backend/worker.js").read_text()
    (output / "_worker.js").write_text(worker)
    write_json(output / "_routes.json", {"version": 1, "include": ["/api/*", "/mcp"], "exclude": []})
    (output / "_headers").write_text("/*\n  Cache-Control: public, no-cache, no-transform\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: microphone=(), camera=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'self' https://sound-toy.pages.dev\n/source/*\n  Content-Type: text/plain; charset=utf-8\n  Access-Control-Allow-Origin: *\n/data/*\n  Access-Control-Allow-Origin: *\n")
    (output / "llms.txt").write_text("# Model Atlas\n\nScientific thermal response, recorded membrane voltage, Hodgkin–Huxley simulations and cortical ATP budgets.\n\n- [Catalog](https://atlas.relay70.dev/api/catalog)\n- [Animation and interactions](https://atlas.relay70.dev/api/behavior)\n- [Agent access](https://atlas.relay70.dev/agent.html)\n- [MCP](https://atlas.relay70.dev/mcp)\n\nMCP is public read-only Streamable HTTP. Inspect a live browser only when given its Share view link. Source text, CSS, model data, citations and limits are public. No external model API or API key is required.\n")
    shutil.copyfile(ROOT / "backend/agent.html", output / "agent.html")
    (output / "404.html").write_text('<!doctype html><title>Not found</title><body style="background:#102a2b;color:#e7eddf;font:16px sans-serif;padding:40px"><h1>Not found</h1><a style="color:inherit" href="/">Atlas</a></body>')
    print(f"Staged atlas {version}: {len(files)} source files, {len(traces)} traces at {output}")
    return catalog


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    build_site(parser.parse_args().output)
