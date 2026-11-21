/*
 * TapeStudio — Web Audio engine for a 4-track "Portastudio 244" style recorder.
 *
 * Signal path per channel:
 *   mic -> trim -> loEQ -> hiEQ -> pan -> fader -> (masterBus + chAnalyser + recordTap)
 *
 * Master path:
 *   masterBus -> wowFlutter -> saturation -> (+hiss) -> masterFader -> masterAnalyser -> destination
 *
 * Recording: each armed channel's recordTap feeds a ScriptProcessorNode that stores
 * raw PCM samples. On stop these are copied into an AudioBuffer. (MediaRecorder output
 * is not reliably decodable with decodeAudioData across browsers, so it is not used.)
 * Playback plays the AudioBuffer through an AudioBufferSourceNode whose playbackRate
 * is driven by the pitch control (shared across all tracks).
 */

class TapeStudio {
  constructor() {
    this.ctx = null;
    this.channels = [];
    this.master = null;
    this.micStream = null;
    this.micSource = null;

    this.state = 'stopped'; // 'stopped' | 'playing' | 'recording'
    this.pitch = 1.0;       // playback speed multiplier (UI pitch control)
    this.tracks = [null, null, null, null]; // recorded AudioBuffer per track
    this.playbackSources = [];

    // UI-controlled state. Lives independently of the audio graph so knob/fader
    // moves made before POWER are remembered and applied when the graph is built.
    this.uiState = {
      channels: [0, 1, 2, 3].map((i) => ({
        trimDb: 0, loFreq: 250, loGain: 0, hiFreq: 4000, hiGain: 0,
        pan: 0, fader: 0.8, inputMode: 'mic', armed: i === 0,
      })),
      master: 0.85,
      pitch: 1.0,
      dbx: false,
    };

    this.onStateChange = null; // (state) => void
    this.onLevel = null;       // ({ch:[..4], master, led:[..4]}) => void
    this.onCounter = null;     // (seconds) => void
    this.onTrackRecorded = null; // (index, hasContent) => void
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._buildGraph();
    await this._initMic();
    return this;
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  _buildGraph() {
    const ctx = this.ctx;

    const masterBus = ctx.createGain();
    const wow = this._buildWowFlutter();
    const sat = this._buildSaturation();
    const hiss = this._buildHiss();
    const sum = ctx.createGain();
    const gate = ctx.createGain(); // dBX noise gate (level-driven, set by UI)
    gate.gain.value = 1;
    const masterFader = ctx.createGain();
    masterFader.gain.value = this.uiState.master;
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 1024;
    masterAnalyser.smoothingTimeConstant = 0.6;

    masterBus.connect(wow);
    wow.connect(sat);
    sat.connect(sum);
    hiss.connect(sum);
    sum.connect(gate);
    gate.connect(masterFader);
    masterFader.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);

    this.master = { bus: masterBus, fader: masterFader, analyser: masterAnalyser, wow, sat, hiss, gate };
    this.dbx = this.uiState.dbx;

    // Rebuild from scratch: channels hold nodes from the current context only
    this.channels = [];
    for (let i = 0; i < 4; i++) {
      this.channels.push(this._buildChannel(i, masterBus));
    }
  }

  _buildChannel(i, masterBus) {
    const ctx = this.ctx;
    const st = this.uiState.channels[i];

    const trim = ctx.createGain();
    trim.gain.value = st.inputMode === 'off' ? 0 : Math.pow(10, st.trimDb / 20);

    const loEQ = ctx.createBiquadFilter();
    loEQ.type = 'lowshelf';
    loEQ.frequency.value = st.loFreq;
    loEQ.gain.value = st.loGain;

    const hiEQ = ctx.createBiquadFilter();
    hiEQ.type = 'highshelf';
    hiEQ.frequency.value = st.hiFreq;
    hiEQ.gain.value = st.hiGain;

    const pan = ctx.createStereoPanner();
    pan.pan.value = st.pan;

    const fader = ctx.createGain();
    fader.gain.value = st.fader;

    const preAnalyser = ctx.createAnalyser(); // post-trim, for overload LED
    preAnalyser.fftSize = 512;
    const chAnalyser = ctx.createAnalyser(); // post-fader, for VU meter
    chAnalyser.fftSize = 512;
    chAnalyser.smoothingTimeConstant = 0.5;
    const playAnalyser = ctx.createAnalyser(); // tape playback level, for VU meter
    playAnalyser.fftSize = 512;
    playAnalyser.smoothingTimeConstant = 0.5;

    const recordTap = ctx.createGain();
    recordTap.gain.value = 1.0;

    trim.connect(loEQ);
    loEQ.connect(hiEQ);
    hiEQ.connect(pan);
    pan.connect(fader);
    fader.connect(masterBus);
    fader.connect(chAnalyser);
    fader.connect(recordTap);
    trim.connect(preAnalyser);

    return {
      index: i,
      trim, loEQ, hiEQ, pan, fader,
      preAnalyser, chAnalyser, playAnalyser, recordTap,
      inputMode: st.inputMode, // 'mic' | 'off' | 'tape'
      armed: st.armed,         // record-arm: included in the next record()
      trimDb: st.trimDb, // UI-owned trim value, survives input-mode changes
      recProc: null, recSink: null, recBlocks: [],
      playSource: null,
    };
  }

  _buildWowFlutter() {
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.004;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.0008;
    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 6.0;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.00015;
    lfo2.connect(lfo2Gain);
    lfo2Gain.connect(delay.delayTime);
    lfo2.start();

    return delay;
  }

  _buildSaturation() {
    const ctx = this.ctx;
    const ws = ctx.createWaveShaper();
    ws.curve = this._softClipCurve(3.0);
    ws.oversample = '2x';
    return ws;
  }

  _softClipCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    return curve;
  }

  _buildHiss() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.value = 0.006; // subtle tape hiss
    src.connect(hp);
    hp.connect(g);
    src.start();
    return g;
  }

  async _initMic() {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      for (const ch of this.channels) {
        this.micSource.connect(ch.trim);
      }
    } catch (err) {
      console.warn('Microphone unavailable:', err);
      this.micSource = null;
      this.micError = err.name || 'MIC_UNAVAILABLE';
    }
  }

  // ---- Control setters (called from UI) ----
  // All setters write to uiState first, then apply to the live graph only if it
  // exists. This makes knob/fader moves before POWER safe and remembered.

  setTrim(i, db) {
    const st = this.uiState.channels[i];
    st.trimDb = db;
    const ch = this.channels[i];
    if (ch) ch.trimDb = db;
    if (ch && ch.inputMode !== 'off') {
      ch.trim.gain.value = Math.pow(10, db / 20);
    }
  }
  setLoFreq(i, hz) {
    this.uiState.channels[i].loFreq = hz;
    const ch = this.channels[i];
    if (ch) ch.loEQ.frequency.value = hz;
  }
  setLoGain(i, db) {
    this.uiState.channels[i].loGain = db;
    const ch = this.channels[i];
    if (ch) ch.loEQ.gain.value = db;
  }
  setHiFreq(i, hz) {
    this.uiState.channels[i].hiFreq = hz;
    const ch = this.channels[i];
    if (ch) ch.hiEQ.frequency.value = hz;
  }
  setHiGain(i, db) {
    this.uiState.channels[i].hiGain = db;
    const ch = this.channels[i];
    if (ch) ch.hiEQ.gain.value = db;
  }
  setPan(i, v) { // -1..1
    this.uiState.channels[i].pan = v;
    const ch = this.channels[i];
    if (ch) ch.pan.pan.value = v;
  }
  setFader(i, v) { // 0..1
    this.uiState.channels[i].fader = v;
    const ch = this.channels[i];
    if (ch) ch.fader.gain.value = v;
  }
  setMaster(v) {
    this.uiState.master = v;
    if (this.master) this.master.fader.gain.value = v;
  }
  setDbx(on) {
    this.uiState.dbx = on;
    this.dbx = on;
  }
  /** Called each frame by the UI: dBX-style level gate on the master bus. */
  applyGate(masterRms) {
    if (!this.ctx || !this.master) return;
    if (!this.dbx) {
      this.master.gate.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      return;
    }
    // Below -30 dB → -24 dB attenuation, above -12 dB → fully open.
    const db = 20 * Math.log10(masterRms + 1e-6);
    let g = 1;
    if (db < -30) g = 0.063;
    else if (db < -12) g = 0.063 + ((db + 30) / 18) * (1 - 0.063);
    this.master.gate.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }
  setInputMode(i, mode) {
    const st = this.uiState.channels[i];
    st.inputMode = mode;
    const ch = this.channels[i];
    if (!ch) return;
    ch.inputMode = mode;
    // 'off' mutes the input path; 'mic' and 'tape' keep it live for monitoring
    ch.trim.gain.value =
      mode === 'off' ? 0 : Math.pow(10, ch.trimDb / 20);
  }
  setArm(i, on) {
    this.uiState.channels[i].armed = on;
    const ch = this.channels[i];
    if (ch) ch.armed = on;
  }
  setPitch(v) {
    this.uiState.pitch = v;
    this.pitch = v;
    for (const s of this.playbackSources) {
      s.playbackRate.value = v;
    }
  }

  // ---- Transport ----

  async record() {
    await this.resume();
    this._stopPlayback();
    this.state = 'recording';
    this._markSessionStart();
    for (const ch of this.channels) {
      if (!ch.armed) continue; // only record-armed channels are recorded
      ch.recBlocks = [];
      ch.recProc = this.ctx.createScriptProcessor(4096, 1, 1);
      ch.recProc.onaudioprocess = (e) => {
        ch.recBlocks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // ScriptProcessorNode only runs while connected to the destination; the sink is silent.
      ch.recSink = this.ctx.createGain();
      ch.recSink.gain.value = 0;
      ch.recordTap.connect(ch.recProc);
      ch.recProc.connect(ch.recSink);
      ch.recSink.connect(this.ctx.destination);
    }
    this._emitState();
  }

  async stop() {
    await this.resume();
    clearTimeout(this._autoStopTimer);
    this._stopPlayback();
    for (const ch of this.channels) {
      if (ch.recProc) this._finalizeTrack(ch);
    }
    this._frozenElapsed = this.elapsed();
    this.state = 'stopped';
    this._emitState();
  }

  async play() {
    await this.resume();
    this._stopPlayback();
    this.state = 'playing';
    this._markSessionStart();
    // Every track that has recorded content plays back, regardless of the input selector
    const buffers = [];
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      if (!this.tracks[i]) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = this.tracks[i];
      src.playbackRate.value = this.pitch;
      const g = this.ctx.createGain();
      g.gain.value = 1;
      src.connect(g);
      g.connect(this.master.bus);
      g.connect(this.channels[i].playAnalyser);
      src.start(now);
      this.playbackSources.push(src);
      this.channels[i].playSource = src;
      buffers.push(this.tracks[i]);
    }
    if (buffers.length) {
      const longest = Math.max(...buffers.map((b) => b.duration));
      const endAt = now + longest / this.pitch;
      clearTimeout(this._autoStopTimer);
      this._autoStopTimer = setTimeout(() => {
        if (this.state === 'playing') this.stop();
      }, (endAt - this.ctx.currentTime) * 1000);
    }
    this._emitState();
  }

  _stopPlayback() {
    for (const s of this.playbackSources) {
      try { s.stop(); } catch (e) { /* already stopped */ }
      s.disconnect();
    }
    this.playbackSources = [];
    for (const ch of this.channels) ch.playSource = null;
  }

  /** Stops capture on one channel and turns the collected samples into its track buffer. */
  _finalizeTrack(ch) {
    try { ch.recordTap.disconnect(ch.recProc); } catch (e) { /* already disconnected */ }
    try { ch.recProc.disconnect(); } catch (e) { /* already disconnected */ }
    try { ch.recSink.disconnect(); } catch (e) { /* already disconnected */ }
    ch.recProc.onaudioprocess = null;

    const total = ch.recBlocks.reduce((n, b) => n + b.length, 0);
    const blocks = ch.recBlocks;
    ch.recBlocks = [];
    ch.recProc = null;
    ch.recSink = null;
    if (total === 0) return;

    const buf = this.ctx.createBuffer(1, total, this.ctx.sampleRate);
    const out = buf.getChannelData(0);
    let peak = 0;
    let off = 0;
    for (const b of blocks) {
      out.set(b, off);
      off += b.length;
    }
    for (let i = 0; i < total; i++) {
      const a = Math.abs(out[i]);
      if (a > peak) peak = a;
    }
    this.tracks[ch.index] = buf;
    if (this.onTrackRecorded) this.onTrackRecorded(ch.index, peak > 0.0005);
  }

  _emitState() {
    if (this.onStateChange) this.onStateChange(this.state);
  }

  // ---- Metering (called each animation frame) ----

  readLevels() {
    const ch = [0, 0, 0, 0];
    const led = [false, false, false, false];
    const tmp = new Float32Array(512);
    for (const c of this.channels) {
      const sum2 = (analyser) => {
        analyser.getFloatTimeDomainData(tmp);
        let sum = 0;
        for (let i = 0; i < tmp.length; i++) sum += tmp[i] * tmp[i];
        return Math.sqrt(sum / tmp.length);
      };
      // Input level (mic/line through fader) or tape playback, whichever is louder
      ch[c.index] = Math.max(sum2(c.chAnalyser), sum2(c.playAnalyser));

      c.preAnalyser.getFloatTimeDomainData(tmp);
      let peak = 0;
      for (let i = 0; i < tmp.length; i++) {
        const a = Math.abs(tmp[i]);
        if (a > peak) peak = a;
      }
      led[c.index] = peak > 0.98;
    }
    const mtmp = new Float32Array(1024);
    this.master.analyser.getFloatTimeDomainData(mtmp);
    let msum = 0;
    for (let i = 0; i < mtmp.length; i++) msum += mtmp[i] * mtmp[i];
    const master = Math.sqrt(msum / mtmp.length);
    return { ch, master, led };
  }

  // Offline render of all recorded tracks to one stereo AudioBuffer, using
  // each channel's fader and pan plus the master fader. Tape effects
  // (wow/flutter, saturation, hiss, gate) are not included.
  async mixdown() {
    const sr = this.ctx.sampleRate;
    const used = this.tracks.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    if (!used.length) return null;
    const length = Math.ceil(Math.max(...used.map((i) => this.tracks[i].length / this.pitch)));
    const off = new OfflineAudioContext(2, length, sr);
    const master = off.createGain();
    master.gain.value = this.uiState.master;
    master.connect(off.destination);
    for (const i of used) {
      const st = this.uiState.channels[i];
      const src = off.createBufferSource();
      src.buffer = this.tracks[i];
      src.playbackRate.value = this.pitch;
      const fader = off.createGain();
      fader.gain.value = st.fader;
      const pan = off.createStereoPanner();
      pan.pan.value = st.pan;
      src.connect(fader);
      fader.connect(pan);
      pan.connect(master);
      src.start(0);
    }
    return off.startRendering();
  }

  elapsed() {
    // rough elapsed time of the current playback/record session
    if (this.state === 'stopped') return this._frozenElapsed || 0;
    if (!this._sessionStart) return 0;
    return (this.ctx.currentTime - this._sessionStart) * this.pitch;
  }

  _markSessionStart() {
    this._sessionStart = this.ctx.currentTime;
  }
}

export { TapeStudio };
