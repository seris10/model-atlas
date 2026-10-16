/* Optional browser-to-agent view sharing. No state is sent before explicit Share live view. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id), samples = [];
  let view = null, timer = null, sampling = null, busy = false, version = null;
  function frame() {
    const original = $("world"), image = document.createElement("canvas");
    image.width = Math.min(900, original.width); image.height = Math.round(original.height / original.width * image.width);
    image.getContext("2d").drawImage(original, 0, 0, image.width, image.height);
    return image.toDataURL("image/webp", 0.65);
  }
  function sample() {
    const v = window.livingSystems.inspect();
    samples.push({ captured_at: v.captured_at, clock_s: v.state.clock, scene: v.state.scene,
      temperature_c: v.result.temperature_c, mean_temperature_c: v.result.mean_temperature_c,
      time_s: v.result.time_s, voltage_mv: v.result.voltage_mv, gates: v.result.gates,
      ina_ua_cm2: v.result.ina_ua_cm2, ik_ua_cm2: v.result.ik_ua_cm2, rate: v.result.rate, atp_total: v.result.total,
      available_resource: v.result.resources?.available, effective_release: v.result.effective_release });
    while (samples.length > 20) samples.shift();
  }
  function payload() { const v = window.livingSystems.inspect(); return { state: v.state, result: v.result,
    readouts: v.readouts, viewport: v.viewport, captured_at: v.captured_at, timeline: samples, image: frame(), version }; }
  async function request(path, method, data, token) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: data ? JSON.stringify(data) : undefined, cache: "no-store", referrerPolicy: "no-referrer" });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || "View access unavailable"); return value;
  }
  async function publish() {
    if (!view || busy || document.hidden) return; busy = true; const target = view;
    try { await request(`/api/views/${target.id}`, "PUT", payload(), target.write_token);
      if (view === target) $("share-status").textContent = `Sharing · expires ${new Date(target.expires_at).toLocaleTimeString()}`; }
    catch (e) { if (view === target) $("share-status").textContent = e.message; }
    finally { busy = false; }
  }
  async function stop() {
    clearInterval(timer); clearInterval(sampling); timer = sampling = null;
    if (view) await request(`/api/views/${view.id}`, "DELETE", null, view.write_token);
    view = null; samples.length = 0; $("stop-view").hidden = true; $("share-view").hidden = false;
    $("view-link").closest("label").hidden = true; $("view-link").value = ""; $("share-status").textContent = "Sharing stopped";
  }
  $("agent-button").addEventListener("click", () => $("agent-dialog").showModal());
  $("close-agent").addEventListener("click", () => $("agent-dialog").close());
  $("view-link").addEventListener("click", e => e.target.select());
  if (location.protocol === "file:") {
    $("share-view").disabled = true; $("share-status").textContent = "Live sharing is available at atlas.relay70.dev";
    $("agent-dialog").querySelector("a").href = "https://atlas.relay70.dev/agent.html";
  }
  $("share-view").addEventListener("click", async () => {
    $("share-view").disabled = true;
    try {
      const manifest = await fetch("/api/catalog").then(r => r.json()); version = manifest.version;
      sample(); view = await request("/api/views", "POST", payload());
      $("view-link").value = view.url; $("view-link").closest("label").hidden = false;
      $("share-view").hidden = true; $("stop-view").hidden = false;
      $("share-status").textContent = `Sharing · expires ${new Date(view.expires_at).toLocaleTimeString()}`;
      sampling = setInterval(sample, 200); timer = setInterval(publish, 5000);
    } catch (e) { $("share-status").textContent = e.message; }
    finally { $("share-view").disabled = false; }
  });
  $("stop-view").addEventListener("click", () => stop().catch(e => $("share-status").textContent = e.message));
  window.AtlasAgent = Object.freeze({ frame, inspect: () => window.livingSystems.inspect(), sharing: () => Boolean(view) });
})();
