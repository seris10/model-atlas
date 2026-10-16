/* Living Systems — no runtime dependencies or external data requests. */
(function () {
  "use strict";
  const D = window.ATLAS_DATA, M = window.AtlasModel;
  const $ = id => document.getElementById(id);
  const canvas = $("world"), ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx || !D || !M) { $("world-title").textContent = "Canvas unavailable"; return; }
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const S = { scene: "thermal", playing: !motionPreference.matches, clock: 0, temperature: 30,
    curve: "chlorella_tpc:49", model: "sharpeschoolhigh_1981", uncertainty: true,
    cell: 0, sweep: 0, time: 0.24, speed: 0.25, passive: false,
    firing: D.neural.reference.firing, release: D.neural.reference.release,
    overlap: D.neural.reference.overlap, housekeeping: true, process: "all", scale: "shared", verticalZoom: 1,
    compareModels: false, residuals: false, membraneMode: "recorded", hhCurrent: 7, sodium: 120, potassium: 36,
    window: 0, audioMode: "spikes", compareBudget: true, thermalAmplitude: 0,
    hhTemperature: 6.3, hhProtocol: "step", pulseInterval: 12,
    depletion: false, recovery: 0.8, resource: 1, resourceTime: 0 };
  const audio = new window.AtlasAudio();
  let hh = M.hhTrace();
  let currentDrag = null;
  const channelRestore = { sodium: 120, potassium: 36 };
  const TAU = Math.PI * 2;
  const colors = { thermal: "#dce8a0", membrane: "#cbbdee", neural: "#f6c085" };
  const flows = [
    { key: "postsynaptic receptors", label: "Postsynaptic", short: "RECEPTORS", color: "#d3b0df" },
    { key: "action potentials", label: "Action potentials", short: "SPIKES", color: "#edbd7c" },
    { key: "resting potentials", label: "Resting potentials", short: "RESTING", color: "#8dc6b7" },
    { key: "presynaptic Ca2+ and vesicles", label: "Presynaptic", short: "VESICLES", color: "#df937d" },
    { key: "glutamate recycling", label: "Glutamate recycling", short: "RECYCLING", color: "#b5ca86" },
    { key: "housekeeping", label: "Housekeeping", short: "MAINTENANCE", color: "#a5b3c5" },
  ];
  const componentLabels = { postsynaptic_ampa: "AMPA", postsynaptic_nmda: "NMDA", postsynaptic_mglur: "mGluR",
    action_potential_axon: "Axon", action_potential_soma: "Soma", action_potential_dendrite: "Dendrites",
    resting_potential_neuron: "Neuron", resting_potential_glia: "Glia", presynaptic: "Ca²⁺ / vesicles",
    glutamate_recycling: "Glutamate", housekeeping: "Housekeeping" };
  const referenceBudget = M.budget(D.neural, 4, 0.25, 1.24, true);
  const thermalTemperature = () => S.temperature + S.thermalAmplitude * Math.sin(S.clock * TAU / 12);
  const effectiveRelease = () => S.release * (S.depletion ? S.resource : 1);
  const currentBudget = () => M.budget(D.neural, S.firing, effectiveRelease(), S.overlap, S.housekeeping);
  const currentAt = (trace, t) => (trace.pulses || [[trace.on, trace.off]]).some(([a,b]) => t >= a && t < b) ? trace.amplitude_pa : 0;
  const regenerateHH = () => { hh = M.hhTrace(S.hhCurrent, S.sodium, S.potassium,
    { temperature: S.hhTemperature, protocol: S.hhProtocol, interval: S.pulseInterval }); audio.resetClock(); };
  let cycleCache = null;
  function thermalCycle() {
    const key = [S.curve, S.model, S.temperature, S.thermalAmplitude].join("/");
    if (cycleCache?.key !== key) cycleCache = { key, value: M.cycleAverage(D.thermal.curves.find(c => c.id === S.curve).models[S.model], S.temperature, S.thermalAmplitude) };
    return cycleCache.value;
  }
  function cycleBounds() {
    const low = 11 + S.thermalAmplitude, high = 54 - S.thermalAmplitude;
    S.temperature = clamp(S.temperature, low, high); $("temperature").min = low; $("temperature").max = high;
    const ends = $("temperature").parentElement.querySelectorAll(".range-ends span");
    ends[0].textContent = `${low} °C`; ends[1].textContent = `${high} °C`;
  }
  let width = 0, height = 0, dpr = 1, raf = 0, last = 0, lastUI = 0, dragging = false;
  let hitAreas = [], geometry = {}, liveBudget = null;
  const seeded = n => { const x = Math.sin(n * 127.17 + 19.7) * 43758.5453; return x - Math.floor(x); };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const blend = (a, b, f) => "#" + rgb(a).map((v, i) => Math.round(mix(v, rgb(b)[i], clamp(f, 0, 1))).toString(16).padStart(2, "0")).join("");
  const alpha = (hex, a) => `rgba(${rgb(hex).join(",")},${a})`;
  function text(str, x, y, { color = "#c5d4c9", size = 9, align = "left", serif = false } = {}) {
    ctx.fillStyle = color; ctx.font = `${size}px ${serif ? "Georgia,serif" : "Menlo,Consolas,monospace"}`;
    ctx.textAlign = align; ctx.fillText(str, x, y); ctx.textAlign = "left";
  }
  function line(x1, y1, x2, y2, color, thickness = 1) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = color;
    ctx.lineWidth = thickness; ctx.stroke();
  }
  function dot(x, y, r, color) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = color; ctx.fill(); }
  function glow(x, y, r, color, strength = 0.2) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, alpha(color, strength)); g.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function cubic(p, t) {
    const u = 1 - t;
    return { x: u ** 3 * p[0].x + 3 * u ** 2 * t * p[1].x + 3 * u * t ** 2 * p[2].x + t ** 3 * p[3].x,
      y: u ** 3 * p[0].y + 3 * u ** 2 * t * p[1].y + 3 * u * t ** 2 * p[2].y + t ** 3 * p[3].y };
  }
  function strokeCubic(p, color, w, dash = []) {
    ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
    ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
  }
  function background() {
    const base = S.scene === "thermal" ? "#102a2b" : S.scene === "membrane" ? "#17252e" : "#292925";
    ctx.fillStyle = base; ctx.fillRect(0, 0, width, height);
    glow(width * 0.67, height * 0.48, width * 0.55, colors[S.scene], 0.05);
    ctx.strokeStyle = "#d2e7d007"; ctx.lineWidth = 0.7;
    for (let x = 24; x < width; x += 48) for (let y = 20; y < height; y += 48) {
      line(x - 2, y, x + 2, y, "#d2e7d016", 0.7); line(x, y - 2, x, y + 2, "#d2e7d016", 0.7);
    }
    for (let i = 0; i < 42; i++) {
      const x = seeded(i + 13) * width, y = seeded(i + 67) * height;
      const offset = S.clock * (2 + seeded(i) * 3);
      dot((x + offset) % width, y, seeded(i + 25) * 1.2, "#d2e7d020");
    }
    hitAreas = [];
  }
  function thermal() {
    const mobile = width < 700;
    const selected = D.thermal.curves.find(c => c.id === S.curve);
    const curves = D.thermal.curves.filter(c => c.trait === selected.trait);
    const xs = D.thermal.temperatures;
    const x0 = mobile ? 49 : 90;
    const x1 = width - (mobile ? 65 : 130), span = x1 - x0;
    const yBase = height - (mobile ? 204 : 170);
    const amp = mobile ? 170 : height * 0.42;
    const step = mobile ? 19 : 32;
    const shift = mobile ? 4 : 18;
    const maxRate = Math.max(...curves.flatMap(c => c.models[S.model].rate));
    const sharedMax = maxRate * 1.1 / S.verticalZoom;
    const pal = ["#dce8a0", "#b9d7a0", "#8dc7ab", "#6eb5af", "#63a0aa"];
    const xT = t => x0 + (t - 11) / 43 * span;
    geometry = { x0, x1, yBase, xT, mode: "thermal" };
    // The selected-temperature plane ties the five independent curves together.
    const temperature = thermalTemperature(), scanX = xT(temperature);
    const plane = ctx.createLinearGradient(scanX - 10, 0, scanX + 10, 0);
    plane.addColorStop(0, "#e5e6a100"); plane.addColorStop(0.5, "#e5e6a114"); plane.addColorStop(1, "#e5e6a100");
    ctx.fillStyle = plane; ctx.fillRect(scanX - 10, 112, 20, yBase - 80);
    const yLimit = S.scale === "shared" ? sharedMax : 1.1 / S.verticalZoom;
    line(x0 - 16, yBase, x0 - 16, Math.max(110, yBase - amp), "#bbcfc346", 0.8);
    for (let k = 0; k <= 4; k++) {
      const py = yBase - k / 4 * amp;
      line(x0 - 21, py, x0 - 12, py, "#bbcfc366", 0.8);
      text((yLimit * k / 4).toFixed(1), x0 - 26, py + 3, { color: "#b7c7b9", align: "right", size: mobile ? 8 : 10 });
    }
    text(S.scale === "shared" ? D.thermal.unit : "RELATIVE RATE", x0, 121, { color: "#a2bbb0", size: mobile ? 8 : 10 });
    ctx.save(); ctx.beginPath(); ctx.rect(x0 - 8, 130, width - x0 - 5, yBase - 124); ctx.clip();
    for (let index = curves.length - 1; index >= 0; index--) {
      const c = curves[index], m = c.models[S.model], active = c.id === S.curve;
      const norm = S.scale === "shared" ? maxRate : Math.max(...m.rate), base = yBase - index * step;
      const x = t => xT(t) + index * shift;
      const y = value => base - value / (norm * 1.1) * amp * S.verticalZoom;
      const tone = pal[index % pal.length];
      const ridge = xs.map((t, i) => ({ x: x(t), y: y(m.rate[i]) }));
      const fill = ctx.createLinearGradient(0, base - amp * 1.2, 0, base);
      fill.addColorStop(0, alpha(tone, active ? 0.2 : 0.095)); fill.addColorStop(1, "#102a2b80");
      ctx.beginPath(); ctx.moveTo(ridge[0].x, base); ridge.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.lineTo(ridge[ridge.length - 1].x, base); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      // Transparent contours reveal form without adding decorative false data.
      for (let k = 0.2; k <= 0.8; k += 0.2) {
        ctx.beginPath(); ridge.forEach((p, i) => i ? ctx.lineTo(p.x, mix(base, p.y, k)) : ctx.moveTo(p.x, mix(base, p.y, k)));
        ctx.strokeStyle = alpha(tone, active ? 0.12 : 0.06); ctx.lineWidth = 0.7; ctx.stroke();
      }
      if (active && S.uncertainty) {
        const good = xs.map((t, i) => i).filter(i => Number.isFinite(m.lo[i]) && Number.isFinite(m.hi[i]));
        ctx.beginPath(); good.forEach((i, k) => k ? ctx.lineTo(x(xs[i]), y(Math.max(0, m.hi[i]))) : ctx.moveTo(x(xs[i]), y(Math.max(0, m.hi[i]))));
        good.slice().reverse().forEach(i => ctx.lineTo(x(xs[i]), y(Math.max(0, m.lo[i])))); ctx.closePath();
        ctx.fillStyle = alpha(tone, 0.09); ctx.fill();
      }
      if (active && S.compareModels) {
        const other = c.models[S.model === "gaussian_1987" ? "sharpeschoolhigh_1981" : "gaussian_1987"];
        ctx.beginPath(); xs.forEach((t, i) => i ? ctx.lineTo(x(t), y(other.rate[i])) : ctx.moveTo(x(t), y(other.rate[i])));
        ctx.setLineDash([6, 4]); ctx.strokeStyle = "#e7b48cbf"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      }
      for (const extrapolated of [true, false]) {
        ctx.beginPath(); let started = false;
        for (let i = 0; i < xs.length; i++) {
          const outside = xs[i] < m.domain[0] || xs[i] > m.domain[1];
          if (outside !== extrapolated) { started = false; continue; }
          const p = ridge[i]; if (started) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); started = true;
        }
        ctx.setLineDash(extrapolated ? [3, 5] : []); ctx.strokeStyle = alpha(tone, active ? 1 : 0.58);
        ctx.lineWidth = active ? 2 : 1.2; ctx.stroke(); ctx.setLineDash([]);
      }
      if (active) {
        for (const o of c.observations) {
          const px = x(o.t), py = y(o.rate);
          if (S.residuals && !o.excluded) line(px, py, px, y(M.interpolate(xs, m.rate, o.t)), "#edb79788", 1);
          if (o.excluded) {
            line(px - 3, py - 3, px + 3, py + 3, "#ce9479", 1.2);
            line(px - 3, py + 3, px + 3, py - 3, "#ce9479", 1.2);
          } else { ctx.beginPath(); ctx.arc(px, py, 3.1, 0, TAU); ctx.fillStyle = "#102a2b"; ctx.fill(); ctx.strokeStyle = "#eef2dc"; ctx.lineWidth = 1; ctx.stroke(); }
          hitAreas.push({ x: px, y: py, r: 12, text: `${o.t} °C · ${o.rate.toFixed(3)} ${D.thermal.unit}\nRecord ${o.id}${o.excluded ? " · flagged / excluded" : " · observed"}` });
        }
      }
      if (active && S.thermalAmplitude > 0) {
        const cycle = thermalCycle(), cx = x(S.temperature), cy = y(cycle.cycle_mean_rate);
        ctx.fillStyle = "#e7b48c0b"; ctx.fillRect(x(S.temperature - S.thermalAmplitude), 130,
          x(S.temperature + S.thermalAmplitude) - x(S.temperature - S.thermalAmplitude), base - 130);
        line(x(S.temperature - S.thermalAmplitude), cy, x(S.temperature + S.thermalAmplitude), cy, "#e7b48c", 1.3);
        dot(cx, cy, 3, "#e7b48c");
        line(cx, base, cx, y(cycle.constant_rate), "#e7b48c55", 0.8);
        text("CYCLE MEAN", cx + 6, cy - 8, { color: "#e7b48c", size: mobile ? 7 : 9 });
      }
      const rate = M.thermalRate(m, temperature), px = x(temperature), py = y(rate);
      line(px, base + 3, px, py, alpha(tone, 0.28), 0.8);
      glow(px, py, active ? 26 : 13, tone, active ? 0.28 : 0.13); dot(px, py, active ? 4.5 : 2.5, tone);
      text(`${c.rearing_c}°C`, x1 + index * shift + 12, base + 3, { color: tone, size: mobile ? 8 : 10 });
      hitAreas.push({ x: x1 + index * shift + 22, y: base, r: 18, curve: c.id,
        text: `${c.rearing_c} °C acclimation\n${rate.toFixed(3)} ${D.thermal.unit}` });
      if (active) {
        const topt = m.optimum.topt, peak = M.interpolate(xs, m.rate, topt), peakY = y(peak);
        const px2 = x(topt), py2 = Math.max(148, peakY);
        line(px2, py2 + 6, px2, base, alpha(tone, 0.18), 0.7);
        text(`${topt.toFixed(1)} °C ${m.optimum.support === "supported" ? "✓" : "?"}`, px2, py2 - 10, { color: tone, size: mobile ? 8 : 11, align: "center" });
        if (peakY < 145) text("↑", px2, 145, { color: tone, size: 14, align: "center" });
      }
      // Particle travel is explicitly an illustration of normalized rate.
      const intensity = clamp(rate / norm, 0, 1), count = Math.floor(22 * intensity);
      for (let j = 0; j < count; j++) {
        const f = (seeded(j + index * 43) + S.clock * (0.04 + intensity * 0.075)) % 1;
        const t = 11 + 43 * f, v = M.interpolate(xs, m.rate, t), py2 = y(v * (0.3 + seeded(j + 16) * 0.62));
        dot(x(t), py2, active ? 1.2 : 0.8, alpha(tone, active ? 0.7 : 0.32));
      }
    }
    ctx.restore();
    // Axis follows the front ridge, retaining assay and acclimation as separate coordinates.
    line(x0, yBase + 18, x1, yBase + 18, "#bbcfc338", 0.8);
    for (const t of [15, 20, 25, 30, 35, 40, 45, 50]) {
      const px = xT(t); line(px, yBase + 15, px, yBase + 22, "#bbcfc340", 0.7);
      text(`${t}`, px, yBase + 36, { color: "#a9c0b4", size: mobile ? 7 : 9, align: "center" });
    }
    text("ASSAY TEMPERATURE / °C", (x0 + x1) / 2, yBase + 57, { color: "#96afa3", size: mobile ? 7 : 8, align: "center" });
    if (!mobile) {
      text("ACCLIMATION", width - 33, yBase - curves.length * step - 15, { size: 7, align: "right", color: "#8ca79b" });
      text("TEMPERATURE", width - 33, yBase - curves.length * step - 3, { size: 7, align: "right", color: "#8ca79b" });
    }
    // A faint, color-coded thermal spectrum anchors the moving section.
    const gradient = ctx.createLinearGradient(x0, 0, x1, 0);
    gradient.addColorStop(0, "#73bfc0"); gradient.addColorStop(0.5, "#d7dea0"); gradient.addColorStop(1, "#df8e6c");
    ctx.fillStyle = gradient; ctx.globalAlpha = 0.7; ctx.fillRect(x0, yBase + 18, span, 1); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(scanX, yBase + 26); ctx.lineTo(scanX - 3, yBase + 31); ctx.lineTo(scanX + 3, yBase + 31); ctx.closePath(); ctx.fillStyle = "#e2e9b0"; ctx.fill();
  }

  const traceNow = () => S.membraneMode === "hh" ? hh : D.membrane.cells[S.cell].traces[S.sweep];
  function membrane() {
    const mobile = width < 700, trace = traceNow(), cell = D.membrane.cells[S.cell];
    const center = { x: mobile ? width * 0.40 : width * 0.34, y: mobile ? 230 : height * 0.34 };
    $("soma-control").hidden = !trace.isHH;
    if (trace.isHH) {
      $("soma-control").style.left = `${center.x - 24}px`; $("soma-control").style.top = `${center.y - 24}px`;
      $("soma-control").setAttribute("aria-valuenow", S.hhCurrent);
      $("soma-control").setAttribute("aria-valuetext", `${S.hhCurrent.toFixed(1)} microamperes per square centimeter`);
    }
    const radius = mobile ? 99 : Math.min(185, height * 0.25);
    const t = S.time * trace.duration, voltage = M.interpolate(trace.t, trace.v, t);
    const excite = clamp((voltage - trace.baseline_mv) / 85, 0, 1), inhibit = clamp((trace.baseline_mv - voltage) / 22, 0, 1);
    const color = inhibit > 0.03 ? blend("#bcafe0", "#79b7d1", inhibit) : blend("#bcafe0", "#f0d1a2", excite);
    const activeSpike = trace.spikes.reduce((best, ts) => Math.max(best, Math.exp(-(((t - ts - 0.001) / 0.014) ** 2))), 0);
    glow(center.x, center.y, radius * 1.7, color, 0.1 + excite * 0.13);
    // The branches are an abstract electrode-driven glyph, not a cell reconstruction.
    for (let j = 0; j < 10; j++) {
      const angle = -Math.PI / 2 + j * TAU / 10 + seeded(j + 16) * 0.15;
      const length = radius * (0.77 + seeded(j + 9) * 0.38);
      const bend = (seeded(j + 7) - 0.5) * 0.55;
      const direction = a => ({ x: Math.cos(a), y: Math.sin(a) });
      const p = [center,
        { x: center.x + direction(angle + bend).x * length * 0.34, y: center.y + direction(angle + bend).y * length * 0.34 },
        { x: center.x + direction(angle - bend).x * length * 0.7, y: center.y + direction(angle - bend).y * length * 0.7 },
        { x: center.x + direction(angle).x * length, y: center.y + direction(angle).y * length }];
      strokeCubic(p, alpha(color, 0.1), 7); strokeCubic(p, alpha(color, 0.45 + excite * 0.35), 1.3);
      for (let k = 0; k < 4; k++) {
        const base = cubic(p, 0.45 + k * 0.15), a = angle + (k % 2 ? 0.56 : -0.56);
        const end = { x: base.x + Math.cos(a) * length * 0.25, y: base.y + Math.sin(a) * length * 0.25 };
        const branch = [base, base, { x: mix(base.x, end.x, 0.6), y: mix(base.y, end.y, 0.8) }, end];
        strokeCubic(branch, alpha(color, 0.24), 0.7); dot(end.x, end.y, 1.5, alpha(color, 0.35));
      }
      const traveling = (S.clock * 0.28 + j * 0.071) % 1;
      const q = cubic(p, traveling); dot(q.x, q.y, 1.6, alpha(color, 0.15 + excite * 0.75));
    }
    for (let ring = 0; ring < 3; ring++) {
      const r = radius * (0.68 + ring * 0.22);
      ctx.beginPath(); ctx.ellipse(center.x, center.y, r, r * 0.78, -0.35, 0, TAU);
      ctx.strokeStyle = alpha(color, 0.045); ctx.lineWidth = 0.8; ctx.stroke();
    }
    const soma = 19 + excite * 5;
    glow(center.x, center.y, soma * 3.3, color, 0.22 + excite * 0.2);
    ctx.beginPath();
    for (let k = 0; k <= 80; k++) {
      const a = k / 80 * TAU, r = soma * (1 + Math.sin(a * 3 + 1) * 0.1 + Math.cos(a * 5) * 0.05);
      const x = center.x + Math.cos(a) * r, y = center.y + Math.sin(a) * r;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fillStyle = alpha(color, 0.12 + excite * 0.2); ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
    dot(center.x - 2, center.y + 1, 6, alpha(color, 0.38));
    // A voltage indicator uses a fixed scale so the cell state stays comparable across sweeps.
    const gaugeX = mobile ? width - 24 : width - 52, gaugeY = mobile ? 155 : center.y - 65;
    const gaugeH = mobile ? 110 : 140;
    for (let k = 0; k < 70; k++) {
      const f = k / 69; line(gaugeX, gaugeY + gaugeH * f, gaugeX + 4, gaugeY + gaugeH * f, blend("#e5c296", "#779ecb", f), 1);
    }
    const gy = gaugeY + clamp((40 - voltage) / 140, 0, 1) * gaugeH;
    dot(gaugeX + 2, gy, 3.5, "#f1ecd5");
    text("+40", gaugeX + 12, gaugeY + 3, { size: 7 }); text("−100", gaugeX + 12, gaugeY + gaugeH + 3, { size: 7 });
    text("mV", gaugeX + 12, gaugeY + gaugeH / 2, { size: 7 });
    const gx0 = mobile ? 43 : 90, gx1 = width - (mobile ? 31 : 52);
    const gy0 = height - (mobile ? 190 : 160), graphH = mobile ? 108 : 135;
    const windowSize = S.window ? Math.min(S.window, trace.duration) : trace.duration;
    const tMin = clamp(t - windowSize * 0.35, 0, trace.duration - windowSize), tMax = tMin + windowSize;
    const vMin = Math.min(...trace.v) - 5, vMax = Math.max(...trace.v) + 6;
    const xTime = x => gx0 + (x - tMin) / windowSize * (gx1 - gx0);
    const yVoltage = v => gy0 - (v - vMin) / (vMax - vMin) * graphH;
    geometry = { x0: gx0, x1: gx1, yBase: gy0, xTime, tMin, tMax, mode: "membrane" };
    ctx.save(); ctx.beginPath(); ctx.rect(gx0, gy0 - graphH - 20, gx1 - gx0, graphH + 56); ctx.clip();
    ctx.fillStyle = "#a7a6d908";
    for (const [a,b] of trace.pulses || [[trace.on, trace.off]]) ctx.fillRect(xTime(a), gy0 - graphH - 17, xTime(b) - xTime(a), graphH + 44);
    for (let grid = 0; grid <= 2; grid++) {
      const v = mix(vMin, vMax, grid / 2), y = yVoltage(v);
      line(gx0, y, gx1, y, "#b4c7d015", 0.7);
      if (!mobile) text(`${v.toFixed(0)}`, gx0 - 9, y + 3, { size: 7, align: "right", color: "#8ea4ad" });
    }
    ctx.beginPath(); let first = true; trace.t.forEach((x, i) => { if (x < tMin || x > tMax) return; if (first) ctx.moveTo(xTime(x), yVoltage(trace.v[i])); else ctx.lineTo(xTime(x), yVoltage(trace.v[i])); first = false; });
    ctx.strokeStyle = "#d0c2ed40"; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.beginPath();
    first = true;
    for (let i = 0; i < trace.t.length && trace.t[i] <= t; i++) {
      if (trace.t[i] < tMin) continue;
      const x = xTime(trace.t[i]), y = yVoltage(trace.v[i]); if (!first) ctx.lineTo(x, y); else ctx.moveTo(x, y); first = false;
    }
    ctx.strokeStyle = "#d3c6ed"; ctx.lineWidth = 1; ctx.stroke();
    if (S.passive && trace.passive_role) {
      ctx.beginPath(); for (let k = 0; k <= 400; k++) {
        const ts = trace.duration * k / 400, y = yVoltage(M.passive(trace, cell.fit, ts));
        if (k) ctx.lineTo(xTime(ts), y); else ctx.moveTo(xTime(ts), y);
      }
      ctx.setLineDash([4, 4]); ctx.strokeStyle = "#8fcdc0"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const ts of trace.spikes) line(xTime(ts), gy0 - graphH - 10, xTime(ts), gy0 - graphH - 5, "#e2c596aa", 1);
    const cursorX = xTime(t); line(cursorX, gy0 - graphH - 17, cursorX, gy0 + 21, "#eee6cc77", 0.8);
    dot(cursorX, yVoltage(voltage), 2.8, "#f0e4c4");
    // Current is a command step; preserve sharp transitions rather than interpolate a ramp.
    const ciY = gy0 + 13, commandScale = trace.amplitude_pa >= 0 ? -9 : 9;
    ctx.beginPath(); ctx.moveTo(gx0, ciY);
    for (const [a,b] of trace.pulses || [[trace.on, trace.off]]) {
      ctx.lineTo(xTime(a), ciY); ctx.lineTo(xTime(a), ciY + commandScale);
      ctx.lineTo(xTime(b), ciY + commandScale); ctx.lineTo(xTime(b), ciY);
    }
    ctx.lineTo(gx1, ciY);
    ctx.strokeStyle = "#7eafa7"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    text(`${trace.isHH ? trace.drive.toFixed(1) + " µA/cm²" : Math.round(trace.amplitude_pa) + " pA"}`, gx1, gy0 + 33, { size: 9, align: "right", color: "#90b7b0" });
    text(`${Math.round(tMin * 1000)} ms`, gx0, gy0 + 33, { size: 9, color: "#a5b8bb" });
    text(`${Math.round(tMax * 1000)} ms`, gx1, gy0 - graphH - 22, { size: 9, align: "right", color: "#a5b8bb" });
    text(trace.isHH ? "HH VOLTAGE" : "RECORDED VOLTAGE", gx0, gy0 - graphH - 22, { size: 9, color: "#baaed1" });
    if (!mobile) {
      text(`${voltage.toFixed(1)} mV`, center.x, center.y + radius + 12, { size: 15, serif: true, align: "center", color });
    }
    // Spike timing drives a ring; there is no claim of measured radial propagation.
    if (activeSpike > 0.08) {
      ctx.beginPath(); ctx.arc(center.x, center.y, soma + 10 + (1 - activeSpike) * radius * 0.6, 0, TAU);
      ctx.strokeStyle = alpha("#ebcfa6", activeSpike * 0.35); ctx.lineWidth = 1.4; ctx.stroke();
    }
    const phase = { x: mobile ? width * 0.68 : width * 0.68, y: mobile ? 149 : 130,
      w: mobile ? width * 0.20 : width * 0.23, h: mobile ? 135 : height * 0.25 };
    const derivative = trace.dvdt || trace.v.map(() => 0);
    const dvMax = Math.max(10, ...derivative.map(Math.abs));
    const phaseX = v => phase.x + clamp((v + 100) / 150, 0, 1) * phase.w;
    const phaseY = dv => phase.y + phase.h * (0.5 - dv / (dvMax * 2));
    line(phase.x, phaseY(0), phase.x + phase.w, phaseY(0), "#d2cde03b", 0.8);
    line(phaseX(-65), phase.y, phaseX(-65), phase.y + phase.h, "#d2cde01c", 0.8);
    ctx.beginPath(); let phaseStart = true;
    trace.t.forEach((ts, i) => { if (ts < tMin || ts > tMax) return;
      const px = phaseX(trace.v[i]), py = phaseY(derivative[i]); if (phaseStart) ctx.moveTo(px, py); else ctx.lineTo(px, py); phaseStart = false; });
    ctx.strokeStyle = "#c2b0e259"; ctx.lineWidth = 0.7; ctx.stroke();
    dot(phaseX(voltage), phaseY(M.interpolate(trace.t, derivative, t)), 3.4, "#f1d1a0");
    text("dV/dt", phase.x, phase.y - 10, { size: mobile ? 8 : 10, color: "#b9b0d0" });
    text("mV/ms", phase.x, phase.y + 3, { size: 7, color: "#9294ab" });
    text(dvMax.toFixed(0), phase.x - 5, phase.y + 15, { size: 7, align: "right", color: "#9294ab" });
    text(`−${dvMax.toFixed(0)}`, phase.x - 5, phase.y + phase.h, { size: 7, align: "right", color: "#9294ab" });
    text("V / mV", phase.x + phase.w, phase.y + phase.h + 16, { size: 8, align: "right", color: "#9294ab" });
    text("−100", phase.x, phase.y + phase.h + 16, { size: 7, color: "#9294ab" });
    if (trace.isHH) {
      const gates = trace.gates[Math.min(trace.gates.length - 1, Math.round(t * 10000))];
      const channels = [["gNa", S.sodium * gates[0] ** 3 * gates[1], 180, "#edbd7c"], ["gK", S.potassium * gates[2] ** 4, 54, "#83bfc3"]];
      channels.forEach(([name, conductance, maximum, tone], i) => {
        const py = phase.y + phase.h + 43 + i * 22;
        text(name, phase.x, py + 3, { size: 9, color: tone });
        line(phase.x + 31, py, phase.x + phase.w, py, "#eee3cd22", 4);
        line(phase.x + 31, py, phase.x + 31 + Math.max(1, phase.w - 31) * conductance / maximum, py, tone, 4);
        if (!mobile) text(`${conductance.toFixed(1)} mS/cm²`, phase.x + phase.w + 10, py + 3, { size: 9, color: tone });
        hitAreas.push({ x: phase.x + phase.w * 0.5, y: py, r: 20, channel: i === 0 ? "sodium" : "potassium",
          text: `${name}: ${conductance.toFixed(2)} mS/cm²` });
      });
      text(`${S.hhCurrent.toFixed(1)} µA/cm²`, center.x, center.y - 38, { size: mobile ? 10 : 16, align: "center", serif: true, color: "#ddc5ec" });
      hitAreas.push({ x: center.x, y: center.y, r: 24, control: "current", text: `${S.hhCurrent.toFixed(1)} µA/cm²` });
      const maxIon = Math.max(1, ...trace.ina.map(Math.abs), ...trace.ik.map(Math.abs));
      for (const [samples, tone] of [[trace.ina, "#edbd7c"], [trace.ik, "#83bfc3"]]) {
        ctx.beginPath(); let started = false;
        trace.t.forEach((ts, i) => { if (ts < tMin || ts > tMax) return; const py = gy0 + 51 - samples[i] / maxIon * 14;
          if (started) ctx.lineTo(xTime(ts), py); else ctx.moveTo(xTime(ts), py); started = true; });
        ctx.strokeStyle = tone; ctx.lineWidth = 0.9; ctx.stroke();
      }
      text("I Na / K · µA/cm²", gx0, gy0 + 61, { size: 7, color: "#b5b7c3" });
    }
  }

  function energy() {
    const mobile = width < 700;
    liveBudget = currentBudget();
    const values = flows.map(f => f.key === "housekeeping" ? liveBudget.housekeeping : liveBudget.groups[f.key]);
    const center = { x: width * 0.12, y: height * 0.46 };
    const xEnd = mobile ? width * 0.44 : width * 0.49;
    const xDetail = mobile ? width * 0.75 : width * 0.83;
    const top = 155, bottom = height - (mobile ? 175 : 135);
    const thicknessScale = mobile ? 1.05 : 1.6;
    const ref = referenceBudget.total;
    const members = flows.map(f => f.key === "housekeeping" ? ["housekeeping"] : D.neural.groups[f.key]);
    const totalRows = members.reduce((n, list) => n + list.length, 0);
    let row = 0;
    glow(center.x + (xEnd - center.x) * 0.5, center.y, width * 0.27, "#d7aa85", 0.07);
    // Fixed physical-value scale: widths grow with absolute demand, not only percentages.
    for (let i = 0; i < flows.length; i++) {
      const f = flows[i], value = values[i], startRow = row;
      const y = mix(top, bottom, (row + (members[i].length - 1) / 2) / (totalRows - 1));
      row += members[i].length;
      const start = { x: center.x + 21, y: center.y + (i - 2.5) * 5 };
      const p = [start, { x: mix(center.x, xEnd, 0.3), y: center.y + (i - 2.5) * 24 },
        { x: mix(center.x, xEnd, 0.61), y }, { x: xEnd, y }];
      const selected = S.process === "all" || S.process === f.key;
      const w = Math.max(0, value * thicknessScale), dim = selected ? 1 : 0.18;
      if (S.compareBudget) {
        const referenceValue = f.key === "housekeeping" ? referenceBudget.housekeeping : referenceBudget.groups[f.key];
        strokeCubic(p, "#dfd7c511", referenceValue * thicknessScale);
      }
      if (w > 0.001) {
        strokeCubic(p, alpha(f.color, 0.025 * dim), w + 12);
        strokeCubic(p, alpha(f.color, 0.16 * dim), w);
        strokeCubic(p, alpha(f.color, 0.62 * dim), Math.min(w, 1.1));
        const count = Math.floor(value * (mobile ? 4 : 7));
        for (let j = 0; j < count; j++) {
          const phase = (seeded(j + i * 167) + S.clock * (0.06 + Math.min(value, 50) * 0.002)) % 1;
          const q = cubic(p, phase), q1 = cubic(p, Math.min(1, phase + 0.001));
          const nx = -(q1.y - q.y), ny = q1.x - q.x, len = Math.hypot(nx, ny) || 1;
          const offset = (seeded(j + 77) - 0.5) * w * 0.75;
          dot(q.x + nx / len * offset, q.y + ny / len * offset, 0.8 + seeded(j + 13) * 0.7, alpha(f.color, 0.85 * dim));
        }
      } else strokeCubic(p, alpha(f.color, 0.16), 0.8, [2, 5]);
      const r = 3 + Math.sqrt(Math.max(value, 0)) * 1.8;
      glow(xEnd, y, r * 4, f.color, 0.12 * dim);
      ctx.beginPath(); ctx.arc(xEnd, y, r, 0, TAU); ctx.fillStyle = alpha(f.color, 0.11 * dim); ctx.fill();
      ctx.strokeStyle = alpha(f.color, 0.65 * dim); ctx.lineWidth = 0.8; ctx.stroke();
      dot(xEnd, y, 2.2, alpha(f.color, dim));
      const percent = liveBudget.total > 0 ? value / liveBudget.total * 100 : 0;
      const tx = xEnd - (mobile ? 0 : 8);
      text(f.short, tx, y - (mobile ? 9 : 13), { size: mobile ? 6 : 9, align: "center", color: alpha(f.color, selected ? 1 : 0.5) });
      text(`${percent.toFixed(1)}%`, tx, y + (mobile ? 12 : 18), { size: mobile ? 10 : 15, align: "center", serif: true, color: alpha("#eee7d1", dim) });
      hitAreas.push({ x: xEnd, y, r: Math.max(20, r + 8), process: f.key,
        text: `${f.label}\n${value.toFixed(2)} µmol ATP / g / min · ${percent.toFixed(1)}%` });
      members[i].forEach((name, k) => {
        const amount = name === "housekeeping" ? liveBudget.housekeeping : liveBudget.components[name];
        const referenceAmount = name === "housekeeping" ? referenceBudget.housekeeping : referenceBudget.components[name];
        const cy = mix(top, bottom, (startRow + k) / (totalRows - 1));
        const branch = [{ x: xEnd + r, y }, { x: mix(xEnd, xDetail, 0.42), y },
          { x: mix(xEnd, xDetail, 0.66), y: cy }, { x: xDetail, y: cy }];
        if (S.compareBudget) strokeCubic(branch, "#dfd7c517", referenceAmount * thicknessScale);
        const bw = amount * thicknessScale;
        if (bw > 0) {
          strokeCubic(branch, alpha(f.color, 0.16 * dim), bw);
          strokeCubic(branch, alpha(f.color, 0.5 * dim), Math.min(bw, 0.8));
          for (let j = 0; j < Math.floor(amount * 4); j++) {
            const pt = cubic(branch, (seeded(j + i * 400 + k * 17) + S.clock * 0.1) % 1);
            dot(pt.x, pt.y + (seeded(j + 54) - 0.5) * bw * 0.6, 0.8, alpha(f.color, 0.8 * dim));
          }
        } else strokeCubic(branch, alpha(f.color, 0.16), 0.6, [2, 4]);
        dot(xDetail, cy, 2.2, alpha(f.color, dim));
        text(componentLabels[name], xDetail + 10, cy - 3, { size: mobile ? 8 : 11, color: alpha(f.color, dim) });
        text(amount.toFixed(2), xDetail + 10, cy + 12, { size: mobile ? 10 : 15, serif: true, color: alpha("#eee7d1", dim) });
        hitAreas.push({ x: xDetail, y: cy, r: 16, process: f.key,
          text: `${componentLabels[name]}\n${amount.toFixed(3)} µmol ATP / g / min\nReference ${referenceAmount.toFixed(3)}` });
      });
    }
    // The reservoir is a process-accounting origin, not a subcellular anatomical claim.
    const radius = mobile ? 24 : 33;
    for (let k = 0; k < 5; k++) {
      ctx.beginPath(); ctx.ellipse(center.x, center.y, radius + k * 9, (radius + k * 9) * 0.72, -0.52, 0, TAU);
      ctx.strokeStyle = alpha("#e3c194", 0.14 - k * 0.023); ctx.lineWidth = 0.7; ctx.stroke();
    }
    glow(center.x, center.y, 77, "#e3bd8e", 0.16);
    dot(center.x, center.y, 17, "#d6b5840d"); text("ATP", center.x, center.y + 4, { color: "#ead6b0", size: 12, serif: true, align: "center" });
    if (S.depletion) {
      const available = Math.round(S.resource * 24);
      const poolRadius = mobile ? Math.min(44, center.x - 6) : 55;
      for (let i = 0; i < 24; i++) {
        const angle = i / 24 * TAU - Math.PI / 2;
        dot(center.x + Math.cos(angle) * poolRadius, center.y + Math.sin(angle) * (mobile ? 35 : 44),
          mobile ? 2 : 3, i < available ? "#df937d" : "#df937d20");
      }
      text(`AVAILABLE ${(S.resource * 100).toFixed(0)}%`, center.x, center.y + (mobile ? 59 : 105), { size: mobile ? 7 : 9, color: "#df937d", align: "center" });
      text(`U × R = ${(effectiveRelease() * 100).toFixed(1)}%`, center.x, center.y + (mobile ? 74 : 120), { size: mobile ? 7 : 9, color: "#c4a493", align: "center" });
    }
    if (!mobile) {
      text("DEMAND", center.x, center.y + 62, { size: 7, align: "center", color: "#b1ac93" });
      text(`${(liveBudget.total / ref).toFixed(2)}× reference`, center.x, center.y + 78, { size: 8, align: "center", color: "#c8bca0" });
    }
    hitAreas.push({ x: center.x, y: center.y, r: 30, control: "firing", text: `${S.firing.toFixed(1)} Hz · firing rate` });
    text(`${S.firing.toFixed(1)} Hz`, center.x, center.y - 35, { size: mobile ? 10 : 16, serif: true, align: "center", color: "#ebceab" });
    geometry = { mode: "neural", x0: 0, x1: width };
    text("µmol ATP / g / min", xDetail, 124, { size: mobile ? 7 : 10, color: "#b5ab95" });
  }

  function resize() {
    const box = canvas.getBoundingClientRect(); width = box.width; height = box.height;
    dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw();
  }
  function draw() { background(); if (S.scene === "thermal") thermal(); else if (S.scene === "membrane") membrane(); else energy(); }
  function setPressed(id, pressed) { $(id).setAttribute("aria-pressed", String(pressed)); }
  function setPlaying(value, announce = false) {
    S.playing = value; setPressed("motion-toggle", value);
    $("motion-icon").textContent = value ? "Ⅱ" : "▷"; $("motion-label").textContent = value ? "Pause" : "Play";
    $("motion-toggle").setAttribute("aria-label", value ? "Pause animation" : "Play animation");
    if (announce) $("status").textContent = value ? "Animation playing" : "Animation paused";
    if (value) startLoop(); else { cancelAnimationFrame(raf); raf = 0; last = 0; audio.silence(); draw(); }
  }
  function updateUI() {
    let primary, secondary, state, detail, progress;
    if (S.scene === "thermal") {
      const curve = D.thermal.curves.find(c => c.id === S.curve), m = curve.models[S.model];
      const temp = thermalTemperature(); primary = temp.toFixed(1); secondary = M.thermalRate(m, temp).toFixed(3);
      const outside = temp < m.domain[0] || temp > m.domain[1];
      state = outside ? "Extrapolated response" : "Within observed range";
      detail = m.optimum.support === "supported" ? `Optimum supported · ${m.optimum.topt.toFixed(1)} °C` : "Optimum not located by these data";
      if (S.thermalAmplitude > 0) {
        const cycle = thermalCycle(); state = cycle.extrapolated ? "Cycle includes extrapolation" : "Instantaneous-rate model";
        detail = `Cycle mean ${cycle.cycle_mean_rate.toFixed(3)} · Δ ${(cycle.relative_difference * 100).toFixed(1)}% vs mean T`;
      }
      $("temperature").value = S.temperature; $("temperature-output").value = `${S.temperature.toFixed(1)} °C`;
      $("temperature").parentElement.querySelector("label").firstChild.textContent = S.thermalAmplitude > 0 ? "MEAN TEMPERATURE " : "ASSAY TEMPERATURE ";
      $("amplitude-output").value = `±${S.thermalAmplitude.toFixed(1)} °C`;
      $("transport-label").textContent = S.thermalAmplitude > 0 ? "TEMPERATURE CYCLE" : "TEMPERATURE SCAN";
      $("zoom-output").value = `${S.verticalZoom.toFixed(2)}×`;
      progress = (temp - 11) / 43;
    } else if (S.scene === "membrane") {
      const trace = traceNow(), t = S.time * trace.duration;
      primary = M.interpolate(trace.t, trace.v, t).toFixed(1);
      const current = currentAt(trace, t);
      secondary = trace.isHH ? current.toFixed(1) : String(Math.round(current));
      state = t < trace.on ? "Before stimulation" : current !== 0 ? "Current pulse" : "Recovery";
      detail = trace.isHH ? `${trace.spike_count} spikes · 0 mV crossings · ${trace.rate_hz.toFixed(1)} Hz` :
        `${trace.spike_count} spikes · QC passed${trace.passive_role ? ` · passive ${trace.passive_role === "train" ? "training" : "held-out"} sweep` : ""}`;
      if (trace.isHH) {
        state = trace.protocol === "pair" ? `2 pulses · ${trace.spike_count} spike${trace.spike_count === 1 ? "" : "s"}` : `${S.hhTemperature.toFixed(1)} °C · kinetics ${trace.kinetic_factor.toFixed(2)}×`;
        if (trace.protocol === "pair") {
          const index = Math.round((50 + trace.interval) * 10), gate = trace.gates[index];
          detail = `Before pulse 2 · h ${(gate[1] * 100).toFixed(0)}% · n ${(gate[2] * 100).toFixed(0)}%`;
        }
      }
      $("secondary-unit").textContent = trace.isHH ? "µA/cm²" : "pA";
      $("secondary-label").textContent = trace.isHH ? "CURRENT DENSITY" : "INJECTED CURRENT";
      $("hh-current-output").value = `${S.hhCurrent.toFixed(1)} µA/cm²`;
      $("sodium-output").value = `${S.sodium.toFixed(0)} mS/cm²`;
      $("potassium-output").value = `${S.potassium.toFixed(1)} mS/cm²`;
      $("hh-temperature-output").value = `${S.hhTemperature.toFixed(1)} °C`;
      $("pulse-interval-output").value = `${S.pulseInterval.toFixed(1)} ms`;
      $("time").value = S.time * 1000; $("time-output").value = `${Math.round(t * 1000)} ms`;
      progress = S.time;
    } else {
      liveBudget = currentBudget();
      primary = liveBudget.total.toFixed(2); secondary = S.firing.toFixed(1);
      const f = flows.find(f => f.key === S.process);
      state = f ? f.label : "Rodent cortex · modeled demand";
      detail = f ? `${(f.key === "housekeeping" ? liveBudget.housekeeping : liveBudget.groups[f.key]).toFixed(2)} µmol ATP / g / min` : `${(liveBudget.housekeeping / liveBudget.total * 100).toFixed(0)}% housekeeping · ${(liveBudget.signaling / liveBudget.total * 100).toFixed(0)}% signaling`;
      if (S.depletion) { state = "Resource depletion · model extension"; detail = `${(S.resource * 100).toFixed(0)}% available · effective release ${(effectiveRelease() * 100).toFixed(1)}%`; }
      $("firing-output").value = `${S.firing.toFixed(1)} Hz`; $("release-output").value = `${Math.round(S.release * 100)}%`;
      $("overlap-output").value = `${S.overlap.toFixed(2)}×`; progress = (S.clock * 0.03) % 1;
      $("recovery-output").value = `${S.recovery.toFixed(2)} s`;
    }
    $("primary-value").value = primary; $("secondary-value").value = secondary;
    $("result-state").textContent = state; $("result-detail").textContent = detail;
    $("transport-progress").style.width = `${clamp(progress, 0, 1) * 100}%`;
  }
  const presentations = {
    thermal: { title: "Thermal response", eyebrow: "Chlorella vulgaris",
      kind: "FITTED CURVES / OBSERVATIONS", note: "rTPC 1.1.0",
      primary: ["ASSAY TEMPERATURE", "°C"], secondary: ["PREDICTED RATE", "µmol O₂ / µg C / h"],
      transport: "TEMPERATURE SCAN", credit: "PADFIELD ET AL. / rTPC", legend: '<span><i class="line-key"></i>Model</span><span><i class="dot-key"></i>Observed</span><span><i class="cross-key">×</i>Excluded</span>',
      accessible: "Thermal response ridges with a shared rate scale or per-curve normalization. Dots are observations; crosses are excluded values. Left and right arrows change temperature. Up and down arrows change vertical magnification." },
    membrane: { title: "Membrane voltage", eyebrow: "Mus musculus / current clamp",
      kind: "RECORDED VOLTAGE / SCHEMATIC GEOMETRY", note: "DANDI 000020",
      primary: ["MEMBRANE VOLTAGE", "mV"], secondary: ["INJECTED CURRENT", "pA"],
      transport: "RECORDED PLAYBACK", credit: "ALLEN INSTITUTE / DANDI 000020", legend: '<span><i class="line-key"></i>Voltage</span><span><i class="line-key" style="background:#8fcdc0"></i>Current / passive fit</span>',
      accessible: "Membrane voltage trace and voltage versus voltage-derivative phase plot. Recorded mouse cells or a Hodgkin–Huxley simulation can be selected. Left and right arrows scrub the trace. Audio can sonify spike times or voltage." },
    neural: { title: "Cortical ATP budget", eyebrow: "Rodent cerebral cortex",
      kind: "MODELED PROCESS COSTS", note: "Howarth et al. / 2012",
      primary: ["TOTAL ATP DEMAND", "µmol / g / min"], secondary: ["FIRING RATE", "Hz"],
      transport: "ATP FLOW", credit: "HOWARTH ET AL. / 2012", legend: '<span><i class="line-key"></i>Demand</span><span><i class="line-key" style="background:#ccc8ba55"></i>4 Hz reference</span>',
      accessible: "ATP process budgets split into receptor types and neuronal compartments. Widths show absolute demand; gray widths show the reference. Left and right arrows change firing rate; up and down arrows change release probability." },
  };
  function changeScene(scene, updateHash = true) {
    if (!(scene in presentations)) scene = "thermal";
    S.scene = scene; $("stage").dataset.scene = scene; document.body.dataset.scene = scene; audio.silence();
    $("soma-control").hidden = scene !== "membrane" || S.membraneMode !== "hh";
    document.querySelector('meta[name="theme-color"]').content = { thermal: "#102a2b", membrane: "#17252e", neural: "#292925" }[scene];
    const p = presentations[scene]; $("world-title").textContent = p.title;
    for (const [id, value] of [["world-eyebrow", p.eyebrow], ["world-kind", p.kind],
      ["scene-note", p.note], ["primary-label", p.primary[0]], ["primary-unit", p.primary[1]],
      ["secondary-label", p.secondary[0]], ["secondary-unit", p.secondary[1]], ["transport-label", p.transport], ["source-credit", p.credit]]) $(id).textContent = value;
    $("scene-legend").innerHTML = p.legend;
    canvas.setAttribute("aria-label", p.accessible); $("canvas-description").textContent = p.accessible;
    document.querySelectorAll("[data-scene]").forEach(b => { if (b.tagName === "BUTTON") b.setAttribute("aria-pressed", String(b.dataset.scene === scene)); });
    for (const key of Object.keys(presentations)) $(`${key}-controls`).hidden = key !== scene;
    $("hover-note").hidden = true;
    if (updateHash && location.hash !== `#${scene}`) history.replaceState(null, "", `#${scene}`);
    $("status").textContent = p.eyebrow.replace(" / ", ": "); updateUI(); draw();
    if (scene === "thermal") updateCurveContext();
    if (scene === "membrane") updateMembraneContext();
    syncLegend();
  }
  function updateCurveContext() {
    const curve = D.thermal.curves.find(c => c.id === S.curve);
    $("world-eyebrow").textContent = `Chlorella vulgaris / ${curve.trait.toLowerCase()}`;
  }
  function syncLegend() {
    let legend = presentations[S.scene].legend;
    if (S.scene === "thermal") {
      const selected = S.model === "gaussian_1987" ? "Gaussian" : "S–S";
      const other = S.model === "gaussian_1987" ? "S–S" : "Gaussian";
      legend = `<span><i class="line-key"></i>${selected}</span>` +
        (S.compareModels ? `<span><i class="line-key" style="background:#e7b48c"></i>${other}</span>` : "") +
        (S.thermalAmplitude > 0 ? '<span><i class="line-key" style="background:#e7b48c"></i>Cycle mean</span>' : "") +
        '<span><i class="dot-key"></i>Observed</span><span><i class="cross-key">×</i>Excluded</span>';
    } else if (S.scene === "membrane") {
      legend = '<span><i class="line-key"></i>Voltage</span><span><i class="line-key" style="background:#7eafa7"></i>Command</span>';
      if (S.membraneMode === "hh") legend += '<span><i class="line-key" style="background:#edbd7c"></i>I Na</span><span><i class="line-key" style="background:#83bfc3"></i>I K</span>';
      else if (S.passive) legend += '<span><i class="line-key" style="background:#8fcdc0"></i>Passive fit</span>';
    } else if (!S.compareBudget) legend = '<span><i class="line-key"></i>Demand</span>';
    $("scene-legend").innerHTML = legend;
  }
  function updateMembraneContext() {
    const isHH = S.membraneMode === "hh";
    document.querySelectorAll("[data-recording]").forEach(el => el.hidden = isHH);
    document.querySelectorAll("[data-hh]").forEach(el => el.hidden = !isHH);
    if (S.scene === "membrane") {
      $("world-title").textContent = isHH ? "Hodgkin–Huxley" : "Membrane voltage";
      $("world-eyebrow").textContent = isHH ? "Squid axon / single compartment" : "Mus musculus / current clamp";
      $("world-kind").textContent = isHH ? "SIMULATED VOLTAGE / CHANNEL GATING" : "RECORDED VOLTAGE / SCHEMATIC GEOMETRY";
      $("scene-note").textContent = isHH ? "C = 1 µF/cm²" : "DANDI 000020";
      $("transport-label").textContent = isHH ? "HH SIMULATION" : "RECORDED PLAYBACK";
      $("source-credit").textContent = isHH ? "HODGKIN–HUXLEY / membrane_report" : "ALLEN INSTITUTE / DANDI 000020";
    }
    syncPassive();
  }
  function populateSweeps() {
    const cell = D.membrane.cells[S.cell]; $("sweep").replaceChildren();
    cell.traces.forEach((trace, i) => { const o = new Option(`${Math.round(trace.amplitude_pa)} pA · ${trace.spike_count ? `${trace.spike_count} spikes` : "subthreshold"}`, String(i)); $("sweep").add(o); });
    S.sweep = cell.traces.reduce((best, trace, i) => trace.spike_count > cell.traces[best].spike_count ? i : best, 0);
    $("sweep").value = S.sweep; S.time = 0.24; syncPassive();
  }
  function syncPassive() {
    const eligible = Boolean(traceNow().passive_role); $("passive-toggle").disabled = !eligible;
    $("passive-toggle").title = eligible ? "Overlay the saved training fit" : "Passive model is available on subthreshold sweeps";
    if (!eligible) S.passive = false; setPressed("passive-toggle", S.passive);
  }
  function startLoop() {
    if (!S.playing || document.hidden || raf) return; last = 0; raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0; const dt = last ? Math.min((now - last) / 1000, 0.05) : 0; last = now; S.clock += dt;
    if (S.scene === "thermal" && !dragging) {
      if (S.thermalAmplitude === 0) { S.temperature += dt * 1.4; if (S.temperature > 54) S.temperature = 11; }
    } else if (S.scene === "membrane" && !dragging) {
      S.time += dt * S.speed / traceNow().duration; if (S.time > 1) S.time %= 1;
    }
    if (S.scene === "neural" && S.depletion) {
      S.resource = M.resourceState(S.firing, S.release, S.recovery, S.resource, dt); S.resourceTime += dt;
    }
    draw(); updateAudio(); if (now - lastUI > 80) { updateUI(); lastUI = now; }
    if (S.playing && !document.hidden) raf = requestAnimationFrame(tick);
  }
  function updateAudio(audition = false) {
    const signal = { scene: S.scene, active: S.playing || dragging, running: S.playing && !dragging, tones: [] };
    if (S.scene === "thermal") {
      const selected = D.thermal.curves.find(c => c.id === S.curve);
      signal.tones = D.thermal.curves.filter(c => c.trait === selected.trait).map(c => {
        const rate = c.models[S.model].rate;
        return { hz: 110 * 2 ** ((c.rearing_c - 20) / 8), gain: M.thermalRate(c.models[S.model], thermalTemperature()) / Math.max(...rate) * 0.12 };
      });
    } else if (S.scene === "membrane") {
      const trace = traceNow(), t = S.time * trace.duration;
      const v = M.interpolate(trace.t, trace.v, t);
      Object.assign(signal, { mode: S.audioMode, time: t, speed: S.speed, spikes: trace.spikes,
        key: `${S.membraneMode}/${S.cell}/${S.sweep}/${S.hhCurrent}/${S.sodium}/${S.potassium}/${S.hhTemperature}/${S.hhProtocol}/${S.pulseInterval}` });
      if (S.audioMode === "voltage") signal.tones = [{ hz: 110 * 16 ** clamp((v + 100) / 140, 0, 1), gain: 0.12 }];
    } else {
      const budget = currentBudget();
      signal.tones = flows.map((f, i) => ({ hz: 110 * 2 ** (i / 2),
        gain: (S.process === "all" || S.process === f.key) ?
          (f.key === "housekeeping" ? budget.housekeeping : budget.groups[f.key]) / referenceBudget.total * 0.4 : 0 }));
    }
    audio.update(signal, audition);
  }
  function controlChanged() { updateUI(); syncLegend(); draw(); updateAudio(true); $("hover-note").hidden = true; }
  function manualPause() { setPlaying(false); }
  function sourceNotes() {
    const source = S.scene === "membrane" && S.membraneMode === "hh" ? D.hh : D[S.scene];
    $("source-citation").textContent = source.citation; $("source-note").textContent = source.note;
    $("source-link").href = source.source_url; const dl = $("source-details"); dl.replaceChildren();
    const add = (label, value) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; dl.append(dt, dd); };
    if (S.scene === "thermal") {
      const c = D.thermal.curves.find(c => c.id === S.curve); add("SELECTED CURVE", `${c.id} · ${c.trait.toLowerCase()} · acclimation ${c.rearing_c} °C`);
      add("ANALYSIS SHA256", source.run_sha256);
    } else if (S.scene === "membrane") {
      if (S.membraneMode === "hh") {
        add("CURRENT DENSITY", `${S.hhCurrent} µA/cm²`); add("MAXIMAL CONDUCTANCES", `Na⁺ ${S.sodium} / K⁺ ${S.potassium} mS/cm²`);
        add("TEMPERATURE", `${S.hhTemperature} °C · gating rates × 3^((T−6.3)/10); fixed reversal potentials`);
        add("PROTOCOL", S.hhProtocol === "pair" ? `Two 2 ms pulses · ${S.pulseInterval} ms onset interval` : "200 ms current step");
        add("INTEGRATION", "RK4 · 0.01 ms · 300 ms duration");
      } else {
        const c = source.cells[S.cell], t = traceNow(); add("CELL / SWEEP", `${c.id} / ${t.id}`);
        add("SOURCE ASSET", c.asset); add("SOURCE SHA256", c.sha256);
        add("ORIGINAL SAMPLING", `${Math.round(t.sampling_hz).toLocaleString()} Hz · ${t.t.length.toLocaleString()} display samples`);
      }
    } else { add("REFERENCE ASSUMPTIONS", "4 Hz · release probability 0.25 · Na⁺ overlap 1.24");
      if (S.depletion) add("RESOURCE MODEL", "R′=(1−R)/τ−U f R; effective release U×R. One-pool approximation; fixed recovery, no facilitation."); }
    if (S.scene === "thermal" && S.thermalAmplitude > 0) add("CYCLE MODEL", "Uniform time average over a sinusoidal temperature cycle; instantaneous fitted response. No acclimation or exposure-duration effects.");
    if (D.research) for (const paper of D.research.papers.filter(p => p.scenes.includes(S.scene))) {
      const dt = document.createElement("dt"), dd = document.createElement("dd"), link = document.createElement("a");
      dt.textContent = `${paper.authors} (${paper.year})`; link.href = paper.pubmed; link.target = "_blank";
      link.rel = "noopener noreferrer"; link.textContent = paper.title; dd.append(link); dl.append(dt, dd);
    }
    $("sources-dialog").showModal();
  }
  document.querySelectorAll("button[data-scene]").forEach(b => b.addEventListener("click", () => changeScene(b.dataset.scene)));
  D.thermal.curves.filter(c => c.trait === "Photosynthesis").concat(D.thermal.curves.filter(c => c.trait !== "Photosynthesis")).forEach(c =>
    $("curve").add(new Option(`${c.rearing_c} °C · ${c.trait.toLowerCase()}`, c.id)));
  $("curve").value = S.curve;
  D.membrane.cells.forEach((c, i) => $("cell").add(new Option(`Cell ${String(i + 1).padStart(2, "0")} · ${c.subject}`, i)));
  flows.forEach(f => $("process").add(new Option(f.label, f.key)));
  populateSweeps();
  $("curve").addEventListener("change", e => { S.curve = e.target.value; updateCurveContext(); controlChanged(); });
  $("temperature").addEventListener("input", e => { manualPause(); S.temperature = Number(e.target.value); controlChanged(); });
  $("thermal-amplitude").addEventListener("input", e => { S.thermalAmplitude = Number(e.target.value); cycleBounds(); controlChanged(); });
  $("rate-scale").addEventListener("change", e => { S.scale = e.target.value; controlChanged(); });
  $("vertical-zoom").addEventListener("input", e => { S.verticalZoom = Number(e.target.value); controlChanged(); });
  for (const [id, field] of [["model-compare", "compareModels"], ["residual-toggle", "residuals"], ["budget-compare", "compareBudget"]]) {
    $(id).addEventListener("click", () => { S[field] = !S[field]; setPressed(id, S[field]); controlChanged(); });
  }
  document.querySelectorAll("[data-model]").forEach(b => b.addEventListener("click", () => {
    S.model = b.dataset.model; document.querySelectorAll("[data-model]").forEach(el => el.setAttribute("aria-pressed", String(el === b))); controlChanged();
  }));
  $("uncertainty-toggle").addEventListener("click", () => { S.uncertainty = !S.uncertainty; setPressed("uncertainty-toggle", S.uncertainty); controlChanged(); });
  $("cell").addEventListener("change", e => { S.cell = Number(e.target.value); populateSweeps(); controlChanged(); });
  $("sweep").addEventListener("change", e => { S.sweep = Number(e.target.value); S.time = 0.24; syncPassive(); controlChanged(); });
  $("time").addEventListener("input", e => { manualPause(); S.time = Number(e.target.value) / 1000; controlChanged(); });
  $("speed").addEventListener("change", e => { S.speed = Number(e.target.value); });
  $("time-window").addEventListener("change", e => { S.window = Number(e.target.value); controlChanged(); });
  $("audio-mode").addEventListener("change", e => { S.audioMode = e.target.value; audio.resetClock(); controlChanged(); });
  $("membrane-mode").addEventListener("change", e => {
    S.membraneMode = e.target.value; S.time = 0.24; S.passive = false;
    S.speed = S.membraneMode === "hh" ? 0.05 : 0.25; $("speed").value = String(S.speed);
    audio.resetClock(); updateMembraneContext(); controlChanged();
  });
  for (const [id, field] of [["hh-current", "hhCurrent"], ["sodium", "sodium"], ["potassium", "potassium"]]) {
    $(id).addEventListener("input", e => { S[field] = Number(e.target.value);
      if (field in channelRestore && S[field] > 0) channelRestore[field] = S[field];
      regenerateHH();
      S.time = 0.24; audio.resetClock(); controlChanged(); });
  }
  $("hh-temperature").addEventListener("input", e => { S.hhTemperature = Number(e.target.value); regenerateHH(); controlChanged(); });
  $("pulse-interval").addEventListener("input", e => { S.pulseInterval = Number(e.target.value); regenerateHH(); S.time = 0.05 / hh.duration; controlChanged(); });
  $("hh-protocol").addEventListener("change", e => {
    S.hhProtocol = e.target.value; $("pulse-interval").disabled = S.hhProtocol !== "pair";
    if (S.hhProtocol === "pair") { S.hhCurrent = 20; $("hh-current").value = "20"; S.window = 0.12; $("time-window").value = "0.12"; }
    regenerateHH(); S.time = 0.05 / hh.duration; controlChanged();
  });
  $("next-spike").addEventListener("click", () => {
    manualPause(); const trace = traceNow(), t = S.time * trace.duration;
    const target = trace.spikes.find(ts => ts > t + 0.0001) ?? trace.spikes[0];
    if (target !== undefined) { S.time = clamp((target + 0.001) / trace.duration, 0, 1); S.window = 0.02; $("time-window").value = "0.02"; }
    controlChanged();
  });
  $("audio-toggle").addEventListener("click", async () => {
    try {
      if (audio.enabled) audio.disable(); else await audio.enable();
      setPressed("audio-toggle", audio.enabled); $("audio-toggle").textContent = audio.enabled ? "Audio on" : "Audio off";
      updateAudio(true);
    } catch (error) { $("status").textContent = error.message; $("audio-toggle").textContent = "Audio unavailable"; }
  });
  $("volume").addEventListener("input", e => audio.setVolume(Number(e.target.value) / 100));
  $("passive-toggle").addEventListener("click", () => { S.passive = !S.passive; setPressed("passive-toggle", S.passive); controlChanged(); });
  for (const key of ["firing", "release", "overlap"]) $(key).addEventListener("input", e => {
    S[key] = Number(e.target.value); $("scenario").value = "custom"; controlChanged();
  });
  $("scenario").addEventListener("change", e => {
    const value = { reference: 4, sleep: 3.8, running: 7.8, silent: 0 }[e.target.value]; if (value === undefined) return;
    S.firing = value; S.release = D.neural.reference.release; S.overlap = D.neural.reference.overlap;
    for (const key of ["firing", "release", "overlap"]) $(key).value = S[key]; controlChanged();
  });
  $("housekeeping-toggle").addEventListener("click", () => { S.housekeeping = !S.housekeeping; setPressed("housekeeping-toggle", S.housekeeping); controlChanged(); });
  $("depletion-toggle").addEventListener("click", () => { S.depletion = !S.depletion; S.resource = 1; S.resourceTime = 0;
    setPressed("depletion-toggle", S.depletion); $("recovery").disabled = !S.depletion; controlChanged(); });
  $("recovery").addEventListener("input", e => { S.recovery = Number(e.target.value); controlChanged(); });
  $("process").addEventListener("change", e => { S.process = e.target.value; controlChanged(); });
  $("motion-toggle").addEventListener("click", () => setPlaying(!S.playing, true));
  $("reset").addEventListener("click", () => {
    S.clock = 0;
    if (S.scene === "thermal") {
      S.temperature = 30; S.curve = "chlorella_tpc:49"; S.model = "sharpeschoolhigh_1981"; S.uncertainty = true;
      S.scale = "shared"; S.verticalZoom = 1; S.compareModels = false; S.residuals = false; S.thermalAmplitude = 0;
      $("thermal-amplitude").value = "0"; cycleBounds();
      $("rate-scale").value = "shared"; $("vertical-zoom").value = "1"; setPressed("model-compare", false); setPressed("residual-toggle", false);
      $("curve").value = S.curve; setPressed("uncertainty-toggle", true);
      document.querySelectorAll("[data-model]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.model === S.model)));
      updateCurveContext();
    } else if (S.scene === "membrane") {
      S.cell = 0; $("cell").value = "0"; S.passive = false; populateSweeps(); S.time = 0;
      S.hhCurrent = 7; S.sodium = 120; S.potassium = 36; S.hhTemperature = 6.3; S.hhProtocol = "step"; S.pulseInterval = 12;
      regenerateHH(); S.window = 0; $("hh-temperature").value = "6.3"; $("hh-protocol").value = "step";
      $("pulse-interval").value = "12"; $("pulse-interval").disabled = true;
      $("hh-current").value = "7"; $("sodium").value = "120"; $("potassium").value = "36"; $("time-window").value = "0";
      S.speed = S.membraneMode === "hh" ? 0.05 : 0.25; $("speed").value = String(S.speed);
    }
    else { S.firing = 4; S.release = 0.25; S.overlap = 1.24; S.housekeeping = true; S.process = "all";
      S.depletion = false; S.resource = 1; S.resourceTime = 0; S.recovery = .8; $("recovery").value = ".8";
      $("recovery").disabled = true; setPressed("depletion-toggle", false);
      $("scenario").value = "reference"; $("process").value = "all"; setPressed("housekeeping-toggle", true);
      for (const key of ["firing", "release", "overlap"]) $(key).value = S[key]; }
    audio.resetClock(); controlChanged(); $("status").textContent = "Experiment reset";
  });
  $("source-button").addEventListener("click", sourceNotes);
  $("close-sources").addEventListener("click", () => $("sources-dialog").close());
  $("sources-dialog").addEventListener("click", e => { if (e.target === $("sources-dialog")) {
    const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
  }});
  const position = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function dragCurrent(e) {
    const value = Math.round(clamp(currentDrag.value + (currentDrag.y - position(e).y) * 0.08, 0, 20) * 10) / 10;
    if (value !== S.hhCurrent) { $("hh-current").value = value; $("hh-current").dispatchEvent(new Event("input")); }
  }
  function scrubAt(e) {
    const p = position(e); if (!Number.isFinite(geometry.x0)) return;
    const f = clamp((p.x - geometry.x0) / (geometry.x1 - geometry.x0), 0, 1);
    if (S.scene === "thermal") { S.temperature = 11 + f * 43; cycleBounds(); }
    else if (S.scene === "membrane") S.time = (geometry.tMin + f * (geometry.tMax - geometry.tMin)) / traceNow().duration;
    else if (S.scene === "neural") { S.firing = Math.round(f * 120) / 10; $("firing").value = S.firing; $("scenario").value = "custom"; }
    controlChanged();
  }
  canvas.addEventListener("pointerdown", e => {
    const point = position(e), channel = hitAreas.find(h => h.channel && Math.hypot(h.x - point.x, h.y - point.y) < h.r);
    if (channel) {
      const field = channel.channel;
      $(field).value = S[field] === 0 ? channelRestore[field] : 0; $(field).dispatchEvent(new Event("input"));
      return;
    }
    const current = hitAreas.find(h => h.control === "current" && Math.hypot(h.x - point.x, h.y - point.y) < h.r);
    if (current) {
      dragging = true; currentDrag = { y: point.y, value: S.hhCurrent }; canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (S.scene === "neural") {
      const p = position(e), hit = hitAreas.find(h => Math.hypot(h.x - p.x, h.y - p.y) < h.r);
      if (hit && hit.control) { dragging = true; canvas.setPointerCapture(e.pointerId); }
      else if (hit && hit.process) { S.process = S.process === hit.process ? "all" : hit.process; $("process").value = S.process; controlChanged(); }
      return;
    }
    const pos = position(e), hit = hitAreas.find(h => h.curve && Math.hypot(h.x - pos.x, h.y - pos.y) < h.r);
    if (hit) { S.curve = hit.curve; $("curve").value = S.curve; updateCurveContext(); controlChanged(); return; }
    dragging = true; manualPause(); canvas.setPointerCapture(e.pointerId); scrubAt(e);
  });
  canvas.addEventListener("pointermove", e => {
    if (currentDrag) {
      dragCurrent(e);
      return;
    }
    if (dragging) { scrubAt(e); return; }
    const p = position(e), hit = hitAreas.find(h => Math.hypot(h.x - p.x, h.y - p.y) < h.r), note = $("hover-note");
    canvas.style.cursor = hit && hit.control ? "ns-resize" : hit && (hit.channel || hit.process || hit.curve) ? "pointer" : "crosshair";
    if (!hit) { note.hidden = true; return; }
    note.textContent = hit.text; note.style.whiteSpace = "pre-line"; note.style.left = `${clamp(p.x + 15, 10, width - 240)}px`;
    note.style.top = `${clamp(p.y + 12, 10, height - 90)}px`; note.hidden = false;
  });
  const releasePointer = () => { dragging = false; currentDrag = null; updateAudio(); };
  canvas.addEventListener("pointerup", releasePointer); canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("pointerleave", () => { $("hover-note").hidden = true; });
  $("soma-control").addEventListener("pointerdown", e => {
    dragging = true; currentDrag = { y: position(e).y, value: S.hhCurrent };
    $("soma-control").setPointerCapture(e.pointerId);
  });
  $("soma-control").addEventListener("pointermove", e => { if (currentDrag) dragCurrent(e); });
  $("soma-control").addEventListener("pointerup", releasePointer);
  $("soma-control").addEventListener("pointercancel", releasePointer);
  $("soma-control").addEventListener("keydown", e => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); const direction = ["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1;
    $("hh-current").value = e.key === "Home" ? 0 : e.key === "End" ? 20 : clamp(S.hhCurrent + direction * 0.5, 0, 20);
    $("hh-current").dispatchEvent(new Event("input"));
  });
  canvas.addEventListener("keydown", e => {
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault(); manualPause(); const direction = e.key === "ArrowLeft" ? -1 : 1;
      if (S.scene === "thermal") { S.temperature = clamp(S.temperature + direction * 0.5, 11, 54); cycleBounds(); }
      else if (S.scene === "membrane") S.time = clamp(S.time + direction * 0.01, 0, 1);
      else { S.firing = clamp(S.firing + direction * 0.1, 0, 12); $("firing").value = S.firing; $("scenario").value = "custom"; }
      controlChanged();
    }
    if (["ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); const direction = e.key === "ArrowUp" ? 1 : -1;
      if (S.scene === "thermal") { S.verticalZoom = clamp(S.verticalZoom + direction * 0.05, 0.5, 2.5); $("vertical-zoom").value = S.verticalZoom; }
      else if (S.scene === "neural") { S.release = clamp(S.release + direction * 0.01, 0, 1); $("release").value = S.release; $("scenario").value = "custom"; }
      else if (S.membraneMode === "hh") { $("hh-current").value = clamp(S.hhCurrent + direction * 0.5, 0, 20); $("hh-current").dispatchEvent(new Event("input")); }
      controlChanged();
    }
    if (e.code === "Space") { e.preventDefault(); setPlaying(!S.playing, true); }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; last = 0; audio.silence(); } else startLoop(); });
  motionPreference.addEventListener("change", e => { if (e.matches) setPlaying(false); });
  window.addEventListener("hashchange", () => changeScene(location.hash.slice(1), false));
  new ResizeObserver(resize).observe(canvas);
  const snapshot = () => ({ ...S, audio: audio.snapshot(), budget: S.scene === "neural" ? currentBudget() : null });
  function inspect() {
    let result;
    if (S.scene === "thermal") {
      const curve = D.thermal.curves.find(c => c.id === S.curve), fit = curve.models[S.model];
      const temp = thermalTemperature(); result = { rate: M.thermalRate(fit, temp), unit: D.thermal.unit, temperature_c: temp,
        mean_temperature_c: S.temperature, cycle: thermalCycle(),
        domain: fit.domain, extrapolated: temp < fit.domain[0] || temp > fit.domain[1], optimum: fit.optimum };
    } else if (S.scene === "membrane") {
      const trace = traceNow(), time = S.time * trace.duration;
      const index = Math.min(trace.t.length - 1, Math.round(time * (trace.isHH ? 10000 : 1 / trace.duration * trace.t.length)));
      result = { time_s: time, voltage_mv: M.interpolate(trace.t, trace.v, time), dvdt_mv_per_ms: M.interpolate(trace.t, trace.dvdt, time),
        spike_count: trace.spike_count, spike_times_s: trace.spikes, gates: trace.isHH ? trace.gates[index] : null,
        ina_ua_cm2: trace.isHH ? M.interpolate(trace.t, trace.ina, time) : null,
        ik_ua_cm2: trace.isHH ? M.interpolate(trace.t, trace.ik, time) : null,
        source: trace.isHH ? "Hodgkin-Huxley simulation" : { cell: D.membrane.cells[S.cell].id, sweep: trace.id, asset: D.membrane.cells[S.cell].asset } };
    } else result = { ...currentBudget(), effective_release: effectiveRelease(),
      resources: S.depletion ? { available: S.resource, recovery_s: S.recovery, model_elapsed_s: S.resourceTime,
        steady: M.resourceState(S.firing, S.release, S.recovery) } : null };
    return { state: snapshot(), result, readouts: ["world-title", "primary-label", "primary-value", "primary-unit", "secondary-label", "secondary-value", "secondary-unit", "result-state", "result-detail"]
      .map(id => ({ id, text: $(id).textContent })), viewport: { width, height, devicePixelRatio: dpr },
      captured_at: new Date().toISOString() };
  }
  window.livingSystems = Object.freeze({ snapshot, inspect, trace: () => JSON.parse(JSON.stringify(traceNow())) });
  changeScene(location.hash.slice(1) || document.body.dataset.defaultScene || "thermal", false); resize(); setPlaying(S.playing);
  if (new URLSearchParams(location.search).get("mode") === "hh" || document.body.dataset.defaultMode === "hh") {
    $("membrane-mode").value = "hh"; $("membrane-mode").dispatchEvent(new Event("change"));
  }
})();
