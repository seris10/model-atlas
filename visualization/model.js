/* Browser calculations use coefficients exported by the checked Python model. */
(function (root) {
  "use strict";
  function budget(data, firing, release, overlap, housekeeping = true) {
    if (![firing, release, overlap].every(Number.isFinite) || firing < 0 || release < 0 || release > 1 || overlap < 1) {
      throw new RangeError("Invalid budget controls");
    }
    const components = {};
    for (const [key, c] of Object.entries(data.coefficients)) {
      const scale = c.kind === "release" ? firing * release : c.kind === "spike" ? firing * overlap : 1;
      components[key] = c.value * scale * data.conversion;
    }
    const groups = Object.fromEntries(Object.entries(data.groups).map(([key, members]) =>
      [key, members.reduce((sum, name) => sum + components[name], 0)]));
    const signaling = Object.values(components).reduce((a, b) => a + b, 0);
    const maintenance = housekeeping ? signaling * data.housekeeping_fraction : 0;
    return { components, groups, signaling, housekeeping: maintenance, total: signaling + maintenance };
  }
  function interpolate(xs, ys, x) {
    if (!Number.isFinite(x) || !xs.length || xs.length !== ys.length) throw new RangeError("Invalid samples");
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * f;
  }
  function passive(trace, fit, t) {
    if (!trace.passive_role || !fit) return null;
    const amplitude = trace.amplitude_pa * fit.r_in_mohm * 0.001; // pA × MΩ -> mV
    const tau = fit.tau_ms / 1000;
    if (t < trace.on) return trace.model_baseline_mv;
    if (t < trace.off) return trace.model_baseline_mv + amplitude * (1 - Math.exp(-(t - trace.on) / tau));
    return trace.model_baseline_mv + amplitude * (1 - Math.exp(-(trace.off - trace.on) / tau)) * Math.exp(-(t - trace.off) / tau);
  }
  function thermalRate(fit, temperature) {
    const p = fit.params, c = fit.constants || {};
    if (!Number.isFinite(temperature) || temperature <= -273.15) throw new RangeError("Invalid temperature");
    if ("rmax" in p) return p.rmax * Math.exp(-0.5 * ((temperature - p.topt) / p.a) ** 2);
    const inv = 1 / (temperature + 273.15), k = c.k ?? 8.62e-5;
    const z = p.eh / k * (1 / (p.th + 273.15) - inv);
    const softplus = Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z)));
    return p.r_tref * Math.exp(p.e / k * (1 / ((c.tref ?? 20) + 273.15) - inv) - softplus);
  }
  function cycleAverage(fit, mean, amplitude) {
    if (![mean, amplitude].every(Number.isFinite) || amplitude < 0 || mean - amplitude < -20 || mean + amplitude > 80) throw new RangeError("Invalid cycle");
    const constant = thermalRate(fit, mean);
    let total = 0; const samples = 720;
    for (let i = 0; i < samples; i++) total += thermalRate(fit, mean + amplitude * Math.sin(2 * Math.PI * i / samples));
    const average = total / samples;
    return { constant_rate: constant, cycle_mean_rate: average, difference: average - constant,
      relative_difference: constant === 0 ? null : average / constant - 1,
      temperature_range_c: [mean - amplitude, mean + amplitude],
      extrapolated: mean - amplitude < fit.domain[0] || mean + amplitude > fit.domain[1] };
  }
  function resourceState(firing, utilization, recovery, initial = 1, elapsed = null) {
    if (![firing, utilization, recovery, initial].every(Number.isFinite) || firing < 0 || utilization < 0 || utilization > 1 || recovery <= 0 || initial < 0 || initial > 1 ||
      (elapsed !== null && (!Number.isFinite(elapsed) || elapsed < 0))) throw new RangeError("Invalid resource state");
    const steady = 1 / (1 + utilization * firing * recovery);
    return elapsed === null ? steady : steady + (initial - steady) * Math.exp(-(1 / recovery + utilization * firing) * elapsed);
  }
  function hhTrace(drive = 7, sodium = 120, potassium = 36, options = {}) {
    const temperature = options.temperature ?? 6.3, protocol = options.protocol ?? "step", interval = options.interval ?? 12;
    if (![drive, sodium, potassium].every(Number.isFinite) || drive < 0 || drive > 20 ||
        sodium < 0 || sodium > 180 || potassium < 0 || potassium > 54 || !Number.isFinite(temperature) || temperature < 0 || temperature > 25 ||
        !["step", "pair"].includes(protocol) || !Number.isFinite(interval) || interval < 4 || interval > 30) throw new RangeError("Invalid HH controls");
    const phi = 3 ** ((temperature - 6.3) / 10);
    const pulses = protocol === "step" ? [[0.05, 0.25]] : [[0.05, 0.052], [0.05 + interval / 1000, 0.052 + interval / 1000]];
    const pulseSteps = pulses.map(([a,b]) => [Math.round(a * 100000), Math.round(b * 100000)]);
    const rhs = (s, current) => {
      const [v, m, h, n] = s;
      const am = Math.abs(v + 40) < 1e-9 ? 1 : 0.1 * (v + 40) / -Math.expm1(-(v + 40) / 10);
      const an = Math.abs(v + 55) < 1e-9 ? 0.1 : 0.01 * (v + 55) / -Math.expm1(-(v + 55) / 10);
      const ina = sodium * m ** 3 * h * (v - 50), ik = potassium * n ** 4 * (v + 77);
      return [current - ina - ik - 0.3 * (v + 54.387),
        phi * (am * (1 - m) - 4 * Math.exp(-(v + 65) / 18) * m),
        phi * (0.07 * Math.exp(-(v + 65) / 20) * (1 - h) - h / (1 + Math.exp(-(v + 35) / 10))),
        phi * (an * (1 - n) - 0.125 * Math.exp(-(v + 65) / 80) * n)];
    };
    const trace = { isHH: true, id: "HH", t: [], v: [], dvdt: [], gates: [], ina: [], ik: [], leak: [],
      i: [], spikes: [], duration: 0.3, on: 0.05, off: 0.25, baseline_mv: -65, sampling_hz: 10000,
      passive_role: null, drive, sodium, potassium, qc_pass: null, amplitude_pa: drive,
      temperature, kinetic_factor: phi, protocol, interval, pulses };
    trace.off = pulses[pulses.length - 1][1];
    const dt = 0.01; // ms; fourth-order Runge–Kutta, display every 0.1 ms.
    let state = [-65, 0.0529, 0.5961, 0.3177], previous = state[0];
    for (let k = 0; k <= 30000; k++) {
      const current = pulseSteps.some(([a,b]) => k >= a && k < b) ? drive : 0;
      if (k % 10 === 0) {
        const [v, m, h, n] = state;
        trace.t.push(k * dt / 1000); trace.v.push(v); trace.dvdt.push(rhs(state, current)[0]);
        trace.gates.push([m, h, n]); trace.ina.push(sodium * m ** 3 * h * (v - 50));
        trace.ik.push(potassium * n ** 4 * (v + 77)); trace.leak.push(0.3 * (v + 54.387)); trace.i.push(current);
      }
      if (k === 30000) break;
      const a = rhs(state, current), b = rhs(state.map((v, i) => v + a[i] * dt / 2), current);
      const c = rhs(state.map((v, i) => v + b[i] * dt / 2), current);
      const d = rhs(state.map((v, i) => v + c[i] * dt), current);
      state = state.map((v, i) => v + dt * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
      if (previous < 0 && state[0] >= 0 && k >= 5000 && k < (protocol === "pair" ? (trace.off + 0.015) * 100000 : 25000)) {
        trace.spikes.push((k + (-previous / (state[0] - previous))) * dt / 1000);
      }
      previous = state[0];
    }
    if (!trace.v.every(Number.isFinite)) throw new Error("HH integration failed");
    trace.spike_count = trace.spikes.length; trace.rate_hz = trace.spikes.length / (trace.off - trace.on);
    return trace;
  }
  root.AtlasModel = { budget, interpolate, passive, hhTrace, thermalRate, cycleAverage, resourceState };
  if (typeof module !== "undefined" && module.exports) module.exports = root.AtlasModel;
})(typeof window !== "undefined" ? window : globalThis);
