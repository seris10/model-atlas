"""Validate paper-informed extensions against independent Python results and browser behavior."""
from __future__ import annotations
import os
import argparse, json
from pathlib import Path
import numpy as np
from playwright.sync_api import sync_playwright, expect
from thermal_response.models import get_model

ROOT = Path(__file__).resolve().parents[1]


def check(base, screenshots=None):
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("ATLAS_BROWSER_CHANNEL"), headless=True)
        page = browser.new_page(viewport={"width":1440,"height":1000}, reduced_motion="reduce")
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base, wait_until="networkidle")
        expect(page.locator("#world-title")).to_have_text("Thermal response")
        data = page.evaluate("ATLAS_DATA")
        def value(selector, v):
            page.locator(selector).evaluate("(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))}",v)
        for curve in data["thermal"]["curves"]:
            for name, fit in curve["models"].items():
                spec = get_model(name); theta = [fit["params"][n] for n in spec.params]
                temps = np.linspace(11,54,37)
                expected = spec.predict(temps,theta,**fit["constants"])
                actual = page.evaluate("([fit,t])=>t.map(x=>AtlasModel.thermalRate(fit,x))",[fit,temps.tolist()])
                np.testing.assert_allclose(actual,expected,rtol=2e-13,atol=1e-14)
                for case in fit["cycle_checks"]:
                    result = page.evaluate("([fit,c])=>AtlasModel.cycleAverage(fit,c.mean_c,c.amplitude_c)",[fit,case])
                    assert abs(result["cycle_mean_rate"]-case["cycle_mean_rate"]) < 1e-9
                    assert result["extrapolated"] == case["extrapolated"]
        value("#thermal-amplitude",6)
        initial = page.evaluate("livingSystems.inspect()")
        page.locator("#motion-toggle").click(); page.wait_for_timeout(350)
        moving = page.evaluate("livingSystems.inspect()")
        assert moving["state"]["temperature"] == initial["state"]["temperature"]
        assert moving["result"]["temperature_c"] != initial["result"]["temperature_c"]
        assert moving["result"]["cycle"]["cycle_mean_rate"] == initial["result"]["cycle"]["cycle_mean_rate"]
        page.locator("#motion-toggle").click()
        value("#temperature",11); bounded = page.evaluate("livingSystems.inspect()")
        assert bounded["state"]["temperature"] - 6 >= 11
        if screenshots:
            screenshots.mkdir(parents=True,exist_ok=True); value("#temperature",39)
            page.screenshot(path=str(screenshots/"thermal-cycle-desktop.png"),full_page=True)
        page.locator('[data-scene="membrane"]').click(); page.locator("#membrane-mode").select_option("hh")
        page.locator("#hh-protocol").select_option("pair"); value("#pulse-interval",4)
        short = page.evaluate("livingSystems.trace()")
        assert short["spike_count"] == 1 and len(short["pulses"]) == 2
        value("#pulse-interval",25); long = page.evaluate("livingSystems.trace()")
        assert long["spike_count"] == 2
        assert page.evaluate("livingSystems.inspect().result.spike_count") == 2
        value("#hh-temperature",16.3)
        assert page.evaluate("livingSystems.trace().kinetic_factor") == 3
        value("#hh-temperature",6.3)
        if screenshots:
            value("#time",258); page.screenshot(path=str(screenshots/"pulse-pair-desktop.png"),full_page=True)
        page.locator('[data-scene="neural"]').click()
        for case in data["neural"]["resource_checks"]:
            resource = page.evaluate("c=>AtlasModel.resourceState(c.firing,c.release,c.recovery,c.initial,c.elapsed)",case)
            assert abs(resource-case["resource"]) < 1e-14
            budget = page.evaluate("([d,c,r])=>AtlasModel.budget(d,c.firing,c.release*r,1.24,true)",[data["neural"],case,resource])
            for key,v in case["components"].items():
                assert abs(budget["components"][key]-v*data["neural"]["conversion"]) < 1e-11
            assert abs(budget["total"]-case["total"]) < 1e-10
        value("#firing",12); page.locator("#depletion-toggle").click()
        assert page.evaluate("livingSystems.snapshot().resource") == 1
        page.locator("#motion-toggle").click(); page.wait_for_timeout(1100)
        live = page.evaluate("livingSystems.inspect()")
        expected = page.evaluate("s=>AtlasModel.resourceState(s.firing,s.release,s.recovery,1,s.resourceTime)",live["state"])
        assert abs(expected-live["state"]["resource"]) < 1e-12
        assert live["state"]["resource"] < .5
        assert live["result"]["effective_release"] < live["state"]["release"]
        value("#firing",0); before = page.evaluate("livingSystems.snapshot()")
        page.wait_for_timeout(600); after = page.evaluate("livingSystems.snapshot()")
        expected = page.evaluate("([a,b])=>AtlasModel.resourceState(0,a.release,a.recovery,a.resource,b.resourceTime-a.resourceTime)",[before,after])
        assert abs(expected-after["resource"]) < 1e-12 and after["resource"] > before["resource"]
        page.locator("#motion-toggle").click(); value("#firing",7.8)
        if screenshots: page.screenshot(path=str(screenshots/"vesicle-depletion-desktop.png"),full_page=True)
        page.locator("#reset").click(); assert not page.evaluate("livingSystems.snapshot().depletion")
        for width in [390,320]:
            page.set_viewport_size({"width":width,"height":844})
            for scene in ["thermal","membrane","neural"]:
                page.locator(f'[data-scene="{scene}"]').click()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                if screenshots and width==390:
                    page.screenshot(path=str(screenshots/f"{scene}-extended-phone.png"),full_page=True)
        assert not errors,errors
        browser.close()
    print("PASS: 12 analytic thermal fits, 48 cycle integrals, sinusoidal motion/bounds, pulse recovery/temperature, 4 resource/ATP cases, transient depletion/recovery and mobile scenes")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("base"); parser.add_argument("--screenshots",type=Path)
    args=parser.parse_args(); check(args.base,args.screenshots)
