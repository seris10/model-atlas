"""Check real HTTP/MCP routes and a browser-published live view. Local or deployed base URL."""
from __future__ import annotations
import os
import argparse, hashlib, json, re, time, urllib.request, urllib.error
from pathlib import Path

def check_behavior_source(base):
    def read(path):
        request = urllib.request.Request(base + path, headers={"Cache-Control": "no-cache", "User-Agent": "Relay70AtlasInspector/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            assert response.status == 200
            return response.read(), response.headers.get_content_type()

    behavior = json.loads(read("/api/behavior")[0])
    catalog = json.loads(read("/api/catalog")[0])
    entry = next(item for item in catalog["files"] if item["path"] == "visualization/atlas.js")
    source, content_type = read(behavior["common"]["source"])
    assert content_type == "text/plain", content_type
    assert hashlib.sha256(source).hexdigest() == entry["sha256"]
    expected = Path(__file__).resolve().parents[1] / "visualization/atlas.js"
    assert source == expected.read_bytes(), "Behavior source URL must return the actual atlas JavaScript bytes"
    print(f"Behavior source URL returns verified JavaScript: {base}{behavior['common']['source']}")


def check(base):
    from playwright.sync_api import sync_playwright, expect
    check_behavior_source(base)
    def request(path, value=None, headers=None, method=None):
        h = {"Content-Type": "application/json", "User-Agent":"Relay70AtlasInspector/1.0", "Cache-Control":"no-cache", **(headers or {})}
        req = urllib.request.Request(base + path, data=json.dumps(value).encode() if value is not None else None, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e: return e.code, json.load(e)
    assert request("/api/health")[1]["view_storage"]
    status, catalog = request("/api/catalog"); assert status == 200 and {"visualization/index.html", "visualization/atlas.js", "visualization/atlas.css", "visualization/data.js", "backend/worker.js"} <= {f["path"] for f in catalog["files"]}
    assert request("/api/source?path=visualization/atlas.css")[1]["sha256"]
    assert "<!doctype html>" in request("/api/source?path=visualization/index.html&limit=5")[1]["content"]
    generated = request("/api/source?path=visualization/data.js&max_chars=200")[1]
    assert len(generated["content"]) == 200 and generated["next_offset"] == 200
    assert request("/api/source?path=visualization/data.js&offset=200&max_chars=100")[1]["offset"] == 200
    assert request("/api/source?path=../backend/worker.js")[0] == 404
    assert request("/api/no-such-route")[0] == 404
    assert request("/api/experiment", {"scene": "neural", "firing": -1})[0] == 400
    assert request("/api/experiment", {"scene": "thermal", "temperature": 30})[1]["predicted_rate"] > 0
    cycle = request("/api/experiment", {"scene":"thermal", "temperature":39, "amplitude":6})[1]["cycle"]
    assert cycle["cycle_mean_rate"] != cycle["constant_rate"]
    depleted = request("/api/experiment", {"scene":"neural", "firing":12, "depletion":True,"elapsed":2})[1]
    assert depleted["resources"]["available"] < .5 and depleted["effective_release"] < .25
    pair = next(t for t in catalog["traces"] if t.get("protocol")=="pair" and t.get("interval")==25)
    assert request("/api/experiment", {"scene":"membrane","trace":pair["id"],"time":.06})[1]["current"] == 0
    neural = request("/api/experiment", {"scene": "neural", "firing": 0})[1]
    assert neural["total"] > 0 and neural["groups"]["action potentials"] == 0
    def rpc(method, params=None): return request("/mcp", {"jsonrpc":"2.0", "id":1, "method":method, "params":params or {}}, {"Accept":"application/json, text/event-stream"})
    assert rpc("initialize", {"protocolVersion":"2025-06-18", "capabilities":{}, "clientInfo":{"name":"atlas-qa", "version":"1"}})[1]["result"]["protocolVersion"] == "2025-06-18"
    assert len(rpc("tools/list")[1]["result"]["tools"]) == 7
    assert len(rpc("resources/list")[1]["result"]["resources"]) == len(catalog["files"]) + 2
    assert "<!doctype html>" in rpc("resources/read",{"uri":"atlas://source/visualization/index.html"})[1]["result"]["contents"][0]["text"]
    assert "requestAnimationFrame" in rpc("tools/call", {"name":"atlas_behavior", "arguments":{"scene":"thermal"}})[1]["result"]["content"][0]["text"]
    assert rpc("tools/call", {"name":"atlas_experiment", "arguments":{"scene":"neural", "firing":4}})[1]["result"]["structuredContent"]["total"] > 20
    assert rpc("tools/call", {"name":"atlas_experiment", "arguments":{"scene":"neural", "firing":"bad"}})[1]["result"]["isError"]
    assert request("/mcp", {"jsonrpc":"2.0", "id":1, "method":"tools/list"}, {"Origin":"https://untrusted.invalid"})[0] == 403
    assert request("/mcp", {"jsonrpc":"2.0", "id":1, "method":"ping"}, {"MCP-Protocol-Version":"invalid"})[0] == 400
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("ATLAS_BROWSER_CHANNEL"), headless=True)
        page = browser.new_page(viewport={"width":1440,"height":1000}, reduced_motion="reduce")
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/?mode=hh#membrane", wait_until="networkidle")
        expect(page.locator("#world-title")).to_have_text("Hodgkin–Huxley")
        state = page.evaluate("livingSystems.inspect()")
        assert not state["state"]["playing"] and state["result"]["gates"]
        assert not page.evaluate("AtlasAgent.sharing()")
        page.locator("#agent-button").click(); page.locator("#share-view").click()
        expect(page.locator("#view-link")).to_have_value(re.compile(r".*/api/views/.*"))
        link = page.locator("#view-link").input_value(); path = link.replace(base, "")
        status, view = request(path); assert status == 200 and view["fresh"] and view["state"]["membraneMode"] == "hh"
        assert "write_token" not in view
        assert request(path, {}, {"Origin":base}, "PUT")[0] == 401
        assert request(path, {}, {"Origin":base,"Authorization":"Bearer guessed"}, "PUT")[0] == 403
        assert request("/api/views", {"state":{"scene":"membrane"},"timeline":[]})[0] == 403
        tool = rpc("tools/call", {"name":"atlas_view", "arguments":{"id":view["id"],"include_frame":True}})[1]["result"]
        assert tool["isError"] is False and any(c["type"] == "image" for c in tool["content"])
        page.locator("#close-agent").click(); page.locator("#motion-toggle").click()
        assert page.evaluate("livingSystems.snapshot().playing")
        deadline = time.monotonic() + 20
        while True:
            updated = request(path)[1]
            if len(updated["timeline"]) == 20 and updated["state"]["playing"]: break
            assert time.monotonic() < deadline, {"samples":len(updated["timeline"]), "playing":updated["state"]["playing"],
                "age_ms":updated["age_ms"], "ui_status":page.locator("#share-status").inner_text()}
            page.wait_for_timeout(400)
        assert len({s.get("voltage_mv") for s in updated["timeline"]}) > 1
        page.locator("#agent-button").click(); page.locator("#stop-view").click()
        expect(page.locator("#share-view")).to_be_visible()
        assert not page.evaluate("AtlasAgent.sharing()")
        assert request(path)[0] == 404
        for width in [390, 320]:
            page.set_viewport_size({"width":width,"height":844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert not errors, errors
        browser.close()
    print(f"HTTP, MCP, source guards, model calculations, shared animation/frame, writer isolation, stop and mobile layout passed: {base}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base")
    parser.add_argument("--source-only", action="store_true", help="verify the advertised behavior source URL and bytes")
    args = parser.parse_args()
    (check_behavior_source if args.source_only else check)(args.base.rstrip("/"))
