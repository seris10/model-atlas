/* Web Audio lifecycle and smoothing follow Sound Toys' theremin.html. */
(function (root) {
  "use strict";
  const F_MIN = 110, F_MAX = 1760;
  function silentWav() {
    const sr = 8000, n = Math.floor(sr * 0.25), bytes = 44 + n * 2;
    const b = new ArrayBuffer(bytes), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    const u8 = new Uint8Array(b); let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return "data:audio/wav;base64," + btoa(bin);
  }
  function spikeVoice(context, destination, when, amplitude = 0.4) {
    const osc = context.createOscillator(), gain = context.createGain();
    osc.type = "sine"; osc.frequency.setValueAtTime(880, when);
    osc.frequency.exponentialRampToValueAtTime(110, when + 0.012);
    gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(amplitude, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.024);
    osc.connect(gain).connect(destination); osc.start(when); osc.stop(when + 0.026);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    return osc;
  }
  class AtlasAudio {
    constructor() {
      this.enabled = false; this.volume = 0.2; this.context = null; this.voices = [];
      this.scheduled = []; this.pending = new Set(); this.anchor = null; this.auditionTimer = 0;
    }
    async enable() {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) throw new Error("Web Audio is unavailable");
      if (!this.context) {
        const c = this.context = new AC();
        this.master = c.createGain(); this.master.gain.value = 0;
        this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
        this.master.connect(this.analyser).connect(c.destination);
        for (let i = 0; i < 6; i++) {
          const osc = c.createOscillator(), gain = c.createGain();
          osc.type = "sine"; osc.frequency.value = 440; gain.gain.value = 0;
          osc.connect(gain).connect(this.master); osc.start(); this.voices.push({ osc, gain });
        }
        this.samples = new Float32Array(this.analyser.fftSize);
        this.mobileSession = new Audio(silentWav()); this.mobileSession.setAttribute("playsinline", "");
        this.mobileSession.loop = true;
      }
      const c = this.context;
      const play = this.mobileSession.play(); if (play && play.catch) play.catch(() => {});
      const buf = c.createBuffer(1, 1, 22050), prime = c.createBufferSource();
      prime.buffer = buf; prime.connect(c.destination); prime.start(0);
      await c.resume();
      if (c.state !== "running") throw new Error("Audio context remains suspended");
      this.enabled = true; this.master.gain.setTargetAtTime(this.volume, c.currentTime, 0.02);
    }
    disable() {
      this.enabled = false; this.silence();
      if (this.context) {
        this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
        setTimeout(() => { if (!this.enabled) this.context.suspend(); }, 120);
      }
      if (this.mobileSession) this.mobileSession.pause();
    }
    setVolume(volume) {
      this.volume = Math.max(0, Math.min(0.4, volume));
      if (this.enabled) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
    silence() {
      clearTimeout(this.auditionTimer); this.resetClock();
      if (this.context) for (const v of this.voices) v.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
    }
    resetClock() {
      this.anchor = null;
      for (const osc of this.pending) { try { osc.stop(); } catch (_) {} }
      this.pending.clear();
    }
    update(signal, audition = false) {
      if (!this.enabled || !this.context) return;
      clearTimeout(this.auditionTimer);
      const c = this.context, now = c.currentTime;
      const active = signal.active || audition;
      const tones = active ? signal.tones || [] : [];
      for (let i = 0; i < this.voices.length; i++) {
        const voice = this.voices[i], tone = tones[i];
        const freq = tone ? Math.max(F_MIN, Math.min(F_MAX, tone.hz)) : 440;
        voice.osc.frequency.setTargetAtTime(freq, now, 0.01);
        voice.gain.gain.setTargetAtTime(tone ? Math.max(0, Math.min(0.2, tone.gain)) : 0, now, 0.02);
      }
      if (signal.scene === "membrane" && signal.mode === "spikes" && signal.running && !audition) {
        const key = `${signal.key}/${signal.speed}`;
        const a = this.anchor;
        const discontinuity = a && Math.abs((signal.time - a.data) / signal.speed - (now - a.audio)) > 0.12;
        if (!a || a.key !== key || signal.time < a.previous || discontinuity) {
          this.resetClock();
          this.anchor = { key, data: signal.time, audio: now + 0.025, until: signal.time - 1e-9, previous: signal.time };
        }
        const anchor = this.anchor, until = signal.time + signal.speed * 0.08;
        for (const t of signal.spikes) {
          if (t <= anchor.until || t > until) continue;
          const when = anchor.audio + (t - anchor.data) / signal.speed;
          if (when < now) continue;
          const osc = spikeVoice(c, this.master, when);
          this.pending.add(osc); osc.addEventListener("ended", () => this.pending.delete(osc));
          this.scheduled.push({ dataTime: t, audioTime: when, speed: signal.speed, key: signal.key });
          if (this.scheduled.length > 256) this.scheduled.shift();
        }
        anchor.until = until; anchor.previous = signal.time;
      } else if (this.anchor) this.resetClock();
      if (audition && !signal.active) this.auditionTimer = setTimeout(() => this.silence(), 220);
    }
    snapshot() {
      let rms = 0;
      if (this.analyser) {
        this.analyser.getFloatTimeDomainData(this.samples);
        rms = Math.sqrt(this.samples.reduce((sum, x) => sum + x * x, 0) / this.samples.length);
      }
      return { enabled: this.enabled, state: this.context ? this.context.state : "uninitialized", volume: this.volume,
        rms, scheduled: this.scheduled.slice(), pending: this.pending.size };
    }
    static async renderSpikes(times, speed = 1, duration = 1.5, sampleRate = 22050) {
      const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      const c = new Offline(1, Math.ceil(duration * sampleRate), sampleRate);
      for (const t of times) if (t / speed + 0.026 < duration) spikeVoice(c, c.destination, t / speed, 0.2);
      return c.startRendering();
    }
  }
  root.AtlasAudio = AtlasAudio;
})(window);
